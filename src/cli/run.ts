import { join } from "node:path";
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
import { MONTHLY_LIMIT, readQuota } from "../stitch/quota.js";
import { openRun, type Degradation } from "../store/store.js";
import { readCalibration, type Calibration } from "./calibration.js";
import { costUsd } from "./pricing.js";
import { groupTokenIssues } from "./group.js";
import { buildFirstPrompt } from "./prompt.js";
import { committeeHooks, noProgress, type Progress } from "./progress.js";
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
  /** What a person watching sees: each step as it starts and ends, with how long it took. */
  progress?: Progress;
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
  const progress = opts.progress ?? noProgress;

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
  if (quota.warn) log?.(`Stitch quota: ${quota.used}/${MONTHLY_LIMIT} used this month`);
  // loadContract has already refused a null sigma.
  const sigma = cfg.sigma!;
  // A stale calibration is the quiet failure: sigma decides when the run stops, so a run judged against
  // a noise floor measured for another model, other weights or another number says so, loudly (spec §16).
  const calibration = await readCalibration(designDir, cfg, sigma, log);
  const run = await openRun(designDir, screen, date);
  progress.header([
    `run ${screen} · design ${designDir}`,
    `critic ${cfg.models.critic} (${cfg.criticMode}) · chair ${cfg.models.chair} · sigma ${sigma} · up to ${cfg.maxRounds} edits`,
    `Stitch ${quota.used}/${MONTHLY_LIMIT} used this month · results in ${run.dir}`,
  ]);
  progress.attachLog(join(run.dir, "events.jsonl"));

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
  // The version the next edit is built from: null for round 0, then the chair's `buildFrom` or the previous version.
  let parent: string | null = null;

  const askChair = async (input: Parameters<typeof chair>[0]) => {
    try {
      return await chair(input, cfg, chairClient);
    } finally {
      const tokens = chairClient.takeUsage?.();
      addUsage(chairUsage, tokens);
      if (tokens) progress.debug(`  chair tokens: ${tokens.inputTokens} in, ${tokens.outputTokens} out, ${tokens.cachedTokens} cached`);
    }
  };
  const spentSoFar = (): number => costUsd(cfg.models.critic, criticUsage) + costUsd(cfg.models.chair, chairUsage);

  const loop = async (): Promise<{ stop: StopReason; best: string }> => {
    let prompt = buildFirstPrompt(contract, screen);
    let baseHandle: Screen | null = null;
    // The chair changes `prompt` was built to make; recorded on the version that prompt produces, so a
    // regression can be read back against what the round was trying to fix. Round 0 has none.
    let changes: { requested: number; applied: Issue[] } | undefined;
    for (let n = 0; ; n++) {
      const version = `v${String(n).padStart(2, "0")}`;
      progress.banner(n === 0 ? `${version} · first generation` : `${version} · edit ${n} of at most ${cfg.maxRounds}`, {
        fraction: n / cfg.maxRounds,
        status: `$${spentSoFar().toFixed(2)} so far · ${stitchGenerations} Stitch generation${stitchGenerations === 1 ? "" : "s"}`,
      });
      const handle: Screen = await progress.phase(
        n === 0 ? "stitch generate" : "stitch edit",
        () => (baseHandle ? baseHandle.edit(prompt) : generator.generate(prompt)),
      );
      stitchGenerations++;
      const [html, png] = await progress.phase(
        "fetch html + image",
        async () => [await handle.getHtml(), await handle.getImage()] as const,
        ([h, p]) => `${Math.round(h.length / 1024)} KB html, ${Math.round(p.length / 1024)} KB png`,
      );
      const doc = await progress.phase("measure", () => measure(html), (d) => `${d.nodes.length} nodes`);
      const det = deterministicCritique(doc, contract.tokens);
      const digest = distill(doc);

      const committee = await progress.phase(
        "critics",
        () =>
          runCommittee(
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
            committeeHooks(progress, true),
          ),
        (c) => `${c.critiques.length}/${c.critiques.length + c.failures.length} ok`,
      );
      const criticTokens = llm.takeUsage?.();
      addUsage(criticUsage, criticTokens);
      if (criticTokens) progress.debug(`  critics tokens: ${criticTokens.inputTokens} in, ${criticTokens.outputTokens} out, ${criticTokens.cachedTokens} cached`);
      for (const f of committee.failures) degradations.push({ version, critic: f.critic, error: f.error });
      // The deterministic critique alone is not a review: without one LLM critic the round is not scored (spec §14).
      if (committee.critiques.length === 0) {
        throw new Error(`committee unavailable: ${committee.failures.map((f) => `${f.critic}: ${f.error}`).join("; ")}`);
      }

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
        index: n, png, html, doc, critiques: scored, composite: score, gatePass: verdict.pass, prompt, openIssues: open, parent, changes,
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
      // Only what the CHAIR sees is grouped: one off-token value on twenty elements is one edit, not twenty
      // rounds of the three-change cap. The store, the gate and the critics keep the per-selector issues.
      const chairInput = regressed
        ? {
            critiques: last.critiques,
            openIssues: groupTokenIssues(best.open),
            imagePng: best.png,
            tokens: contract.tokens,
            regression: {
              bestVersion: decision.best,
              delta: last.composite - best.composite,
              introduced: last.open.filter((i) => !best.open.some((b) => b.id === i.id)),
              failedPrompt: last.prompt,
            },
          }
        : { critiques: last.critiques, openIssues: groupTokenIssues(last.open), imagePng: last.png, tokens: contract.tokens, regression: null };

      const chairPhase = (): Promise<Awaited<ReturnType<typeof askChair>>> =>
        progress.phase("chair", () => askChair(chairInput), (c) => `${c.changes.length} change${c.changes.length === 1 ? "" : "s"} asked of Stitch`);
      let next;
      try {
        next = await chairPhase();
      } catch {
        progress.warn("chair failed, retrying once");
        next = await chairPhase();
      }
      if (next.requested > next.changes.length) {
        log?.(`chair returned ${next.requested} changes; keeping the top ${next.changes.length}`);
      }
      prompt = next.prompt;
      changes = { requested: next.requested, applied: next.changes };
      // The next version is an edit of `base`, so the next round's state describes `base`, not a regressed `last`.
      parent = next.buildFrom ?? written;
      const base = records.get(parent)!;
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
    calibration,
  });
  return { stopReason, versions: rounds.length, best: stoppedBest ?? committeeRank[0]!, runDir: run.dir, abortReason };
}
