import { loadContract } from "../contract/load.js";
import { measure } from "../measure/measure.js";
import { deterministicCritique } from "../critics/deterministic.js";
import { validateEvidence, promoteResolutions } from "../evidence/validate.js";
import { composite, gate, openIssues, renormalise } from "../scoring/score.js";
import { decide, type RoundRecord, type StopReason } from "../scoring/stop.js";
import { distill } from "../distill/distill.js";
import { runCommittee, type LlmClient } from "../critics/llm.js";
import { chair, type ChairClient } from "../chair/chair.js";
import type { Generator, Screen } from "../stitch/adapter.js";
import { readQuota } from "../stitch/quota.js";
import { openRun, type Degradation } from "../store/store.js";
import { costUsd } from "./pricing.js";
import { buildFirstPrompt } from "./prompt.js";
import type { CriticName, Critique, Issue, MeasuredDoc, Usage } from "../types.js";

export interface RunOptions {
  designDir: string;
  screen: string;
  date: string;
  generator: Generator;
  llm: LlmClient;
  chairClient: ChairClient;
  /** Where the Stitch quota counter lives; defaults to `designDir`. */
  quotaDir?: string;
  log?: (line: string) => void;
}

export interface RunResult {
  stopReason: StopReason | "aborted";
  versions: number;
  best: string;
  runDir: string;
  abortReason?: string;
}

/** Everything a later round may need from an earlier one, kept per version. */
interface VersionRecord {
  png: Buffer;
  doc: MeasuredDoc;
  critiques: Critique[];
  open: Issue[];
  composite: number;
  prompt: string;
  handle: Screen;
}

const noUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
const addUsage = (total: Usage, more: Usage | undefined): void => {
  if (!more) return;
  total.inputTokens += more.inputTokens;
  total.outputTokens += more.outputTokens;
  total.cachedTokens += more.cachedTokens;
};

const isDeterministic = (i: Issue): boolean => i.id.startsWith("det-");

export async function runScreen(opts: RunOptions): Promise<RunResult> {
  const { designDir, screen, date, generator, llm, chairClient, log } = opts;

  // Everything that can fail cheaply fails here: before any spend and before any directory exists.
  const contract = await loadContract(designDir, {}, screen);
  const cfg = contract.config;
  const zero = noUsage();
  costUsd(cfg.models.critic, zero);
  costUsd(cfg.models.chair, zero);
  const quota = await readQuota(opts.quotaDir ?? designDir);
  if (quota.remaining < cfg.maxRounds + 1) {
    const [y, m] = quota.month.split("-").map(Number);
    const resets = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);
    throw new Error(
      `Stitch quota too low: ${quota.remaining} generations left, a run may need ${cfg.maxRounds + 1} — resets ${resets}`,
    );
  }
  // loadContract has already refused a null sigma.
  const sigma = cfg.sigma!;
  const run = await openRun(designDir, screen, date);

  const rounds: RoundRecord[] = [];
  const records = new Map<string, VersionRecord>();
  const degradations: Degradation[] = [];
  const hallucination = new Map<CriticName, { sum: number; n: number }>();
  const criticUsage = noUsage();
  const chairUsage = noUsage();
  let stitchGenerations = 0;

  let carried: Issue[] = [];
  let prevOpen: Issue[] = [];
  let prevDoc: MeasuredDoc | null = null;

  const askChair = async (input: Parameters<typeof chair>[0]) => {
    try {
      return await chair(input, cfg, chairClient);
    } finally {
      addUsage(chairUsage, chairClient.takeUsage?.());
    }
  };

  const loop = async (): Promise<{ stop: StopReason; best: string }> => {
    let prompt = buildFirstPrompt(contract, screen);
    let baseHandle: Screen | null = null;
    for (let n = 0; ; n++) {
      const version = `v${String(n).padStart(2, "0")}`;
      const handle: Screen = baseHandle ? await baseHandle.edit(prompt) : await generator.generate(prompt);
      stitchGenerations++;
      const html = await handle.getHtml();
      const png = await handle.getImage();
      const doc = await measure(html);
      const det = deterministicCritique(doc, contract.tokens);
      const digest = distill(doc);

      const committee = await runCommittee(
        {
          contract,
          screen,
          digest,
          imagePng: png,
          openIssues: carried,
          measurements: det.critique.issues.filter((i) => !i.id.startsWith("det-token-")),
        },
        cfg,
        llm,
      );
      addUsage(criticUsage, llm.takeUsage?.());
      for (const f of committee.failures) degradations.push({ version, critic: f.critic, error: f.error });

      const validated = validateEvidence(committee.critiques, doc);
      for (const [critic, rate] of Object.entries(validated.hallucinationRate) as [CriticName, number][]) {
        const tally = hallucination.get(critic) ?? { sum: 0, n: 0 };
        hallucination.set(critic, { sum: tally.sum + rate, n: tally.n + 1 });
      }
      const promoted = promoteResolutions(validated.critiques, prevDoc, doc, prevOpen);
      // The deterministic critique is the tokenConformance dimension.
      const scored = [...promoted, det.critique];
      const score = composite(scored, renormalise(cfg.weights, scored.map((c) => c.critic)));
      const open = openIssues(scored, carried);
      const verdict = gate(scored, det.measurementsPass, carried);

      const written = await run.writeVersion({
        index: n, png, html, doc, critiques: scored, composite: score, gatePass: verdict.pass, prompt, openIssues: open,
      });
      rounds.push({ version: written, composite: score, gatePass: verdict.pass });
      records.set(written, { png, doc, critiques: scored, open, composite: score, prompt, handle });
      log?.(`${written}: composite ${score.toFixed(1)}, ${open.length} open, gate ${verdict.pass ? "pass" : "fail"}`);

      const decision = decide(rounds, cfg);
      if (decision.stop) return { stop: decision.stop, best: decision.best };

      const last = records.get(written)!;
      const best = records.get(decision.best)!;
      // A regression is judged against the noise floor, as convergence is. The chair then works on the BEST
      // version, so it is given that version's screenshot and open issues, and the prompt that broke it.
      const regressed = last.composite < best.composite - cfg.convergenceSigmas * sigma;
      const chairInput = regressed
        ? {
            critiques: last.critiques,
            openIssues: best.open,
            imagePng: best.png,
            tokens: contract.tokens,
            regression: {
              bestVersion: decision.best,
              delta: last.composite - best.composite,
              introduced: last.open.filter((i) => !best.open.some((b) => b.id === i.id)),
              failedPrompt: last.prompt,
            },
          }
        : { critiques: last.critiques, openIssues: last.open, imagePng: last.png, tokens: contract.tokens, regression: null };

      let next;
      try {
        next = await askChair(chairInput);
      } catch {
        next = await askChair(chairInput);
      }
      prompt = next.prompt;
      // The next version is an edit of `base`, so the next round's state describes `base`, not a regressed `last`.
      const base = next.buildFrom ? records.get(next.buildFrom)! : last;
      baseHandle = base.handle;
      // Deterministic issues are re-measured every round, so only the LLM ones are carried.
      carried = base.open.filter((i) => !isDeterministic(i));
      prevOpen = base.open;
      prevDoc = base.doc;
    }
  };

  let stopReason: StopReason | "aborted";
  let stoppedBest: string | null = null;
  let abortReason: string | undefined;
  try {
    ({ stop: stopReason, best: stoppedBest } = await loop());
  } catch (err) {
    // With no version written there is nothing to keep, so the failure is the caller's to see.
    if (rounds.length === 0) throw err;
    stopReason = "aborted";
    abortReason = err instanceof Error ? err.message : String(err);
  }

  // A gate-passing version outranks any other, then highest composite first; the sort is stable, so a tie keeps
  // the earlier version.
  const committeeRank = [...rounds]
    .sort((a, b) => Number(b.gatePass) - Number(a.gatePass) || b.composite - a.composite)
    .map((r) => r.version);
  const total = noUsage();
  addUsage(total, criticUsage);
  addUsage(total, chairUsage);
  await run.finalise({
    stopReason,
    abortReason,
    committeeRank,
    spend: {
      stitchGenerations,
      ...total,
      usd: costUsd(cfg.models.critic, criticUsage) + costUsd(cfg.models.chair, chairUsage),
    },
    hallucinationRate: Object.fromEntries([...hallucination].map(([critic, t]) => [critic, t.sum / t.n])),
    degradations,
    sigma,
  });
  return { stopReason, versions: rounds.length, best: stoppedBest ?? committeeRank[0]!, runDir: run.dir, abortReason };
}
