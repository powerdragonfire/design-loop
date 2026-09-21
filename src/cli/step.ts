import { join, resolve } from "node:path";
import { AgentChairClient } from "../chair/agent.js";
import { AgentLlmClient, WorkOrderPending } from "../critics/agent.js";
import { LLM_CRITICS } from "../critics/llm.js";
import { measure } from "../measure/measure.js";
import { openExistingRun, openRun, writeAtomic } from "../store/store.js";
import type { Generator } from "../stitch/adapter.js";
import type { CriticName, MeasuredDoc } from "../types.js";
import { noProgress, type Progress } from "./progress.js";
import { resumingGenerator, resumingMeasure, resumingRun, type RoundCursor } from "./resume.js";
import { runScreen, type RunResult } from "./run.js";

export interface StepOptions {
  designDir: string;
  screen: string;
  date: string;
  /** Absent on the first step: the run directory is claimed here. */
  runDir?: string;
  generator: Generator;
  log?: (line: string) => void;
  progress?: Progress;
  /** Replaced only by tests that must not drive a browser; production always renders the page. */
  measure?: (html: string) => Promise<MeasuredDoc>;
}

export type StepResult =
  | { done: true; result: RunResult; runDir: string }
  | { done: false; workOrder: string; runDir: string };

/**
 * One subagent's job: which agent type to dispatch, what it may read, and the one file it must write. Paths
 * are relative — to `runDir`, or to `designDir` for `brief.md`, `tokens.json` and `screens/` — and the work
 * order gives both of those as absolute paths, so a dispatcher never has to guess a base.
 */
interface WorkUnit {
  critic: CriticName | "chair";
  agent: string;
  output: string;
  /**
   * `null`, not omitted, for an input this critic is deliberately not shown. An absent key reads as an
   * oversight; an explicit null says the file exists and this agent is not to read it.
   */
  inputs: Record<string, string | null>;
}

const rel = (version: string, file: string): string => `${version}/${file}`;

function unitsFor(kind: "critics" | "chair", version: string, screen: string, pending: CriticName[]): WorkUnit[] {
  if (kind === "chair") {
    return [{
      critic: "chair",
      agent: "design-loop-chair",
      output: rel(version, "inbox/chair.json"),
      inputs: {
        screenshot: rel(version, "screen.png"),
        openIssues: rel(version, "open-issues.json"),
        critiques: rel(version, "critiques"),
        tokens: "tokens.json",
      },
    }];
  }
  // Ordered by the committee's own list, never by the order the missing files were noticed: those are read
  // concurrently, so arrival order is the filesystem's business and would make the file differ run to run.
  const waiting = new Set<CriticName>(pending);
  return LLM_CRITICS.filter((critic) => waiting.has(critic)).map((critic) => ({
    critic,
    agent: `design-loop-${critic}`,
    output: rel(version, `inbox/${critic}.json`),
    inputs: {
      digest: rel(version, "digest.txt"),
      screenshot: rel(version, "screen.png"),
      html: rel(version, "screen.html"),
      screenSpec: `screens/${screen}.md`,
      brief: "brief.md",
      tokens: "tokens.json",
      carriedIssues: rel(version, "carried-issues.json"),
      // Deterministic findings are facts shown to the accessibility critic alone (spec §7).
      measurements: critic === "accessibility" ? rel(version, "measurements.json") : null,
    },
  }));
}

/**
 * Writes what a dispatcher has to do next into the version directory the work is about, so the order and the
 * files it names live together and a stale order cannot be read against a newer round.
 */
export async function writeWorkOrder(opts: {
  runDir: string; designDir: string; screen: string; pending: WorkOrderPending;
}): Promise<string> {
  const { runDir, designDir, screen, pending } = opts;
  const file = join(runDir, pending.version, "work-order.json");
  await writeAtomic(file, `${JSON.stringify({
    kind: pending.kind,
    version: pending.version,
    screen,
    designDir: resolve(designDir),
    runDir: resolve(runDir),
    concurrency: 4,
    units: unitsFor(pending.kind, pending.version, screen, pending.units.map((u) => u.critic)),
  }, null, 2)}\n`);
  return file;
}

/**
 * Advances a run by one suspension. Everything already on disk is replayed for free; the first step that needs
 * an answer nobody has written stops and says what to dispatch.
 *
 * The whole run is re-executed from round 0 every time. That is not waste: the resume layer serves each
 * generated screen, each measured doc and each scored round from the run directory, and the loop's own
 * arithmetic is pure, so replaying a suspended run costs no Stitch generation and no model call.
 */
export async function stepRun(opts: StepOptions): Promise<StepResult> {
  const { designDir, screen, date, generator, log } = opts;
  const progress = opts.progress ?? noProgress;

  // `resumingRun` requires an `openExistingRun`-backed Run whenever anything is being replayed: it returns a
  // replayed version's name without registering it, and `finalise` validates `committeeRank` against the list
  // `openExistingRun` rebuilds from each `vNN/composite.json`. The first step has nothing to replay, so the
  // freshly claimed run is equivalent there — every round it writes registers itself through `finish`.
  const run = opts.runDir ? await openExistingRun(opts.runDir) : await openRun(designDir, screen, date);
  const runDir = run.dir;

  // One cursor, written only by the resuming generator, read by both agent clients to find the round's
  // directory. -1 until the first generate-or-edit, so a read before then names no version at all.
  const cursor: RoundCursor = { index: -1 };
  const llm = new AgentLlmClient({ runDir, cursor });
  const chairClient = new AgentChairClient({ runDir, cursor });

  try {
    const result = await runScreen({
      designDir, screen, date, log, progress,
      // Never `generator.fromId`: a handle taken from there skips this wrapper, so its `edit` does not advance
      // the cursor and the next round is generated again instead of replayed. `generate` is the only way in.
      generator: resumingGenerator({ runDir, inner: generator, cursor }),
      measure: resumingMeasure({ runDir, inner: opts.measure ?? measure }),
      llm,
      chairClient,
      run: resumingRun(run, runDir),
    });
    return { done: true, result, runDir };
  } catch (err) {
    // `runCommittee` settles every critic before `throwIfPending` is allowed to throw, so one work order names
    // them all and a dispatcher never has to step four times to learn about four missing files.
    if (err instanceof WorkOrderPending) {
      return { done: false, workOrder: await writeWorkOrder({ runDir, designDir, screen, pending: err }), runDir };
    }
    // Deliberately no `llm.throwIfPending()` here. `runScreen` already calls it the moment the committee
    // settles, so anything else reaching this point is a real failure, and raising a work order over it would
    // hide the cause behind "waiting for critics".
    throw err;
  }
}
