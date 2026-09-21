import { join } from "node:path";
import { loadContract } from "../contract/load.js";
import { measure } from "../measure/measure.js";
import { deterministicCritique } from "../critics/deterministic.js";
import { validateEvidence, promoteResolutions } from "../evidence/validate.js";
import { composite, gate, openIssues, renormalise } from "../scoring/score.js";
import { decide, type RoundRecord, type StopReason } from "../scoring/stop.js";
import { distill } from "../distill/distill.js";
import { runCommittee, type LlmClient } from "../critics/llm.js";
import { WorkOrderPending } from "../critics/agent.js";
import { chair, type ChairClient } from "../chair/chair.js";
import { selectCandidate, type CandidateRow } from "./candidates.js";
import type { Generator, Screen } from "../stitch/adapter.js";
import { MONTHLY_LIMIT, readQuota } from "../stitch/quota.js";
import { openRun, versionName, writeChair, type CandidateSummary, type Degradation, type Run } from "../store/store.js";
import { readCalibration, type Calibration } from "./calibration.js";
import { costUsd } from "./pricing.js";
import { groupTokenIssues } from "./group.js";
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
  /** Replaced by the resume layer so a replayed round reads its stored doc instead of re-rendering the page. */
  measure?: (html: string) => Promise<MeasuredDoc>;
  /**
   * The run to write into, when the caller has already opened one. `dl step` resumes a run directory an
   * earlier process claimed, so it must hand over that directory rather than let this one claim a new `-2`.
   */
  run?: Run;
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

/** `CandidateRow` names the field `open`; the store's `openIssues`/`VersionInput` shape names it `openIssues`. */
const toSummary = (r: CandidateRow): CandidateSummary => ({
  id: r.id, family: r.family, composite: r.composite, blockers: r.blockers, gatePass: r.gatePass, failed: r.failed,
});

export async function runScreen(opts: RunOptions): Promise<RunResult> {
  const { designDir, screen, date, generator, llm, chairClient, log } = opts;
  const progress = opts.progress ?? noProgress;
  const measureDoc = opts.measure ?? measure;

  // Everything that can fail cheaply fails here: before any spend and before any directory exists.
  const contract = await loadContract(designDir, {}, screen);
  const cfg = contract.config;
  // One seed per family plus that family's variants, all spent before the edit loop gets a single edit.
  const totalCandidates = cfg.candidates.families * (1 + cfg.candidates.variantsPerFamily);
  const zero = noUsage();
  costUsd(cfg.models.critic, zero);
  costUsd(cfg.models.chair, zero);
  const quota = await readQuota(opts.quotaDir ?? designDir);
  const needed = totalCandidates + cfg.maxRounds;
  if (quota.remaining < needed) {
    const [y, m] = quota.month.split("-").map(Number);
    const resets = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);
    throw new Error(
      `Stitch quota too low: ${quota.remaining} generations left, a run may need ${needed} generations — resets ${resets}`,
    );
  }
  if (quota.warn) log?.(`Stitch quota: ${quota.used}/${MONTHLY_LIMIT} used this month`);
  // loadContract has already refused a null sigma.
  const sigma = cfg.sigma!;
  // A stale calibration is the quiet failure: sigma decides when the run stops, so a run judged against
  // a noise floor measured for another model, other weights or another number says so, loudly (spec §16).
  const calibration = await readCalibration(designDir, cfg, sigma, log);
  const run = opts.run ?? (await openRun(designDir, screen, date));
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

  // Every candidate is generated, measured and critiqued once, here; the winner becomes v00 without ever
  // being measured or critiqued again — that is the whole point of running this stage before the loop.
  // Persistence happens from `onCandidate`, as each row is scored, rather than from a loop over the
  // returned rows: `pickWinner` throws when every candidate fails, which would otherwise mean every
  // candidate this stage already paid for is written nowhere (spec fix 3).
  const { winner, rows } = await selectCandidate({
    contract, screen, designDir, generator, cfg, progress, llm, sigma,
    onDegraded: (critic, error, id) => degradations.push({ version: id, critic, error }),
    onCandidate: async (row) => {
      await run.writeCandidate({
        id: row.id, family: row.family, png: row.png, html: row.html, doc: row.doc,
        critiques: row.critiques, composite: row.composite, gatePass: row.gatePass,
        prompt: row.prompt, openIssues: row.open,
      });
    },
  });
  // selectCandidate never calls takeUsage itself, so everything it spent is still sitting in the client
  // waiting to be claimed; taken here, once, it folds into criticUsage exactly like any other round's.
  addUsage(criticUsage, llm.takeUsage?.());
  progress.banner(`candidates · ${rows.length} generated`, { fraction: 0 });

  const candidateSummaries = rows.map(toSummary);
  await run.writeSelection({ winner: winner.id, rows: candidateSummaries });
  await run.promoteCandidate(winner.id);
  log?.(`v00: composite ${winner.composite.toFixed(1)}, ${winner.open.length} open, gate ${winner.gatePass ? "pass" : "fail"} (candidate ${winner.id})`);

  // Only the WINNER's hallucination rate folds in: the manifest's rate describes the design that was
  // actually iterated, and averaging in candidates the loop never saw would misdescribe it. Before this
  // a run that stopped at v00 always finalised with an empty hallucinationRate (spec fix 1).
  for (const [critic, rate] of Object.entries(winner.hallucinationRate) as [CriticName, number][]) {
    const tally = hallucination.get(critic) ?? { sum: 0, n: 0 };
    hallucination.set(critic, { sum: tally.sum + rate, n: tally.n + 1 });
  }

  // Seed the loop's state from the winner instead of re-scoring it: nothing below may measure or
  // critique v00 a second time.
  stitchGenerations = rows.length;
  prevDoc = winner.doc;
  carried = winner.open;
  prevOpen = winner.open;
  rounds.push({ version: "v00", composite: winner.composite, gatePass: winner.gatePass });
  records.set("v00", {
    png: winner.png, doc: winner.doc, critiques: winner.critiques, open: winner.open,
    composite: winner.composite, prompt: winner.prompt, handle: winner.handle,
  });

  const loop = async (): Promise<{ stop: StopReason; best: string }> => {
    let prompt = "";
    let baseHandle: Screen = winner.handle;
    // The chair changes `prompt` was built to make; recorded on the version that prompt produces, so a
    // regression can be read back against what the round was trying to fix. v00 has none: it was not
    // built from a chair prompt at all.
    let changes: { requested: number; applied: Issue[] } | undefined;
    let parent: string | null = null;

    // Shared by the seeded winner and every edit the loop scores itself: decide whether `written` ends
    // the run, and if not, ask the chair for the next prompt and the version to build it from.
    const advance = async (written: string): Promise<{ stop: StopReason; best: string } | null> => {
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
      } catch (err) {
        // A chair that has not answered yet has not failed. Retrying would re-read the same absent file, and
        // "chair failed, retrying once" would tell the operator a suspension was an outage.
        if (err instanceof WorkOrderPending) throw err;
        progress.warn("chair failed, retrying once");
        next = await chairPhase();
      }
      // Archived the moment it is answered, into the version the chair was reacting to, and BEFORE the edit
      // it produces exists. From here on this round's answer is settled: `AgentChairClient` prefers the
      // archived copy over `inbox/chair.json`, so a replay cannot pick up an inbox file that changed after
      // the fact and rewrite the `prompt.txt` and `changes.json` of a version whose pixels are already
      // pinned by `screen-id.txt`. It archives in API mode too, which is what Task 4 built it for: without
      // it a resumed run re-pays the Anthropic chair for every round it replays.
      await writeChair(run.dir, written, next.raw);
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
      return null;
    };

    const seeded = await advance("v00");
    if (seeded) return seeded;

    for (let n = 1; ; n++) {
      const version = versionName(n);
      progress.banner(`${version} · edit ${n} of at most ${cfg.maxRounds}`, {
        fraction: n / cfg.maxRounds,
        status: `$${spentSoFar().toFixed(2)} so far · ${stitchGenerations} Stitch generation${stitchGenerations === 1 ? "" : "s"}`,
      });
      const handle: Screen = await progress.phase("stitch edit", () => baseHandle.edit(prompt));
      stitchGenerations++;
      const [html, png] = await progress.phase(
        "fetch html + image",
        async () => [await handle.getHtml(), await handle.getImage()] as const,
        ([h, p]) => `${Math.round(h.length / 1024)} KB html, ${Math.round(p.length / 1024)} KB png`,
      );
      const doc = await progress.phase("measure", () => measureDoc(html), (d) => `${d.nodes.length} nodes`);
      const det = deterministicCritique(doc, contract.tokens);
      const digest = distill(doc);
      // Token drift is the deterministic critique's own dimension and is not a measurement, so it is filtered
      // out here rather than at each use: an agent critic reads `measurements.json` instead of being sent this
      // list, and the two must hold the same facts or the modes are not the same review.
      const measurements = det.critique.issues.filter((i) => !i.id.startsWith("det-token-"));

      // The directory is claimed and everything a critic reads is written BEFORE the committee runs. In agent
      // mode a critic is a separate process reading these files, so a round that suspends must already have
      // left them behind; in API mode it costs three writes and makes the same round replayable.
      const slot = await run.openVersion(n);
      await slot.writeGenerated({ png, html, doc, prompt, screenId: handle.id, parent });
      await slot.writeCommitteeInputs({ digest, carriedIssues: carried, measurements });

      const committee = await progress.phase(
        "critics",
        () =>
          runCommittee(
            { contract, screen, digest, imagePng: png, openIssues: carried, measurements },
            cfg,
            llm,
            committeeHooks(progress, true),
          ),
        (c) => `${c.critiques.length}/${c.critiques.length + c.failures.length} ok`,
      );
      // Before ANY read of `committee` — see the CALLING CONTRACT on AgentLlmClient. A critic that has not
      // answered yet and one whose answer does not parse both reach `runCommittee` as a rejected promise and
      // are filed identically into `dropped`/`failures`; only the client knows which is which. Read the result
      // first and a round waiting on all four critics renormalises its weights over nobody and scores itself.
      llm.throwIfPending?.();
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

      await slot.finish({ critiques: scored, composite: score, gatePass: verdict.pass, openIssues: open, changes });
      const written = slot.version;
      rounds.push({ version: written, composite: score, gatePass: verdict.pass });
      records.set(written, { png, doc, critiques: scored, open, composite: score, prompt, handle });
      log?.(`${written}: composite ${score.toFixed(1)}, ${open.length} open, gate ${verdict.pass ? "pass" : "fail"}`);

      const stop = await advance(written);
      if (stop) return stop;
    }
  };

  let stopReason: StopReason | "aborted";
  let stoppedBest: string | null = null;
  let abortReason: string | undefined;
  try {
    ({ stop: stopReason, best: stoppedBest } = await loop());
  } catch (err) {
    // A work order is a suspension, not an abort: the run has more to do and a later step will do it. Writing
    // a manifest here would finalise it, and a finalised run refuses every later write — the resumed step
    // could never score the round it is waiting for. This must come before the `rounds.length` test: from
    // round 1 on there ARE rounds, so a suspension would otherwise be recorded as an aborted run.
    if (err instanceof WorkOrderPending) throw err;
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
    candidates: candidateSummaries,
    selection: { winner: winner.id, rows: candidateSummaries },
  });
  return { stopReason, versions: rounds.length, best: stoppedBest ?? committeeRank[0]!, runDir: run.dir, abortReason };
}
