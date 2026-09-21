import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { versionName, type RoundCursor } from "../store/store.js";
import { parseCritique } from "./schema.js";
import type { CriticInput, LlmClient } from "./llm.js";
import type { CriticName, Critique } from "../types.js";

export interface PendingUnit {
  critic: CriticName;
}

/** Not a failure: the round cannot continue until a subagent writes the named files. */
export class WorkOrderPending extends Error {
  constructor(
    readonly kind: "critics" | "chair",
    readonly version: string,
    readonly units: PendingUnit[],
  ) {
    super(`${kind} pending for ${version}: ${units.map((u) => u.critic).join(", ")}`);
    this.name = "WorkOrderPending";
  }
}

/**
 * A pending critic must not be retried — it is waiting, not failing. `runCommittee` retries anything
 * whose status is not in NON_RETRYABLE_STATUS (src/critics/llm.ts), and 400 is in that set, so the
 * sentinel claims it to opt out of the retry.
 */
class Pending extends Error {
  readonly status = 400;
  constructor(readonly critic: CriticName) {
    super(`${critic} has not answered yet`);
  }
}

// Distinguishes "the file does not exist" from "the file exists and its JSON content happens to be
// `null`". Using `null` itself as the not-found sentinel (as an earlier version of this file did) would
// make a `critiques/<critic>.json` containing literal `null` fall through to `inbox/` — breaking the
// "archived always wins" invariant — and would misfile it as *pending* rather than malformed, the same
// missing-vs-malformed collapse the class-level comment below warns about, reached by a different route.
const NOT_FOUND = Symbol("not-found");

const readJson = async (file: string): Promise<unknown> => {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return NOT_FOUND;
    throw err;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
};

/**
 * Reads a critique a Claude Code subagent wrote to disk instead of calling the Anthropic API. The
 * archived `critiques/` copy wins over `inbox/`, so replaying an already-scored round can never pick
 * up a newer answer sitting in the inbox and silently change a past score.
 *
 * `cursor` is read-only here: the resuming generator (src/cli/resume.ts) is the sole writer, once per
 * round. This client only ever reads `cursor.index` to find today's version directory.
 *
 * CALLING CONTRACT — read before using this class anywhere but a test: `throwIfPending()` must be
 * called immediately after `runCommittee()` returns, before anything reads `CommitteeResult`. A
 * missing critic and a malformed one both surface to `runCommittee` as a rejected promise, and its
 * `allSettled` handler (src/critics/llm.ts) files both identically into `dropped`/`failures` — it has
 * no way to tell "waiting for a subagent" apart from "this subagent's answer doesn't parse". That
 * distinction exists only inside this class's private `pending` list. Reading `out.dropped` or
 * `out.critiques` before calling `throwIfPending()` will silently renormalise the weights over
 * whichever critics happened to have files on disk, and score a round that should have suspended
 * instead. This cannot be fixed structurally without changing `llm.ts`'s `CommitteeResult` shape,
 * which is out of this class's scope — so the caller must preserve the ordering by convention.
 */
export class AgentLlmClient implements LlmClient {
  private readonly runDir: string;
  private readonly cursor: RoundCursor;
  // Accumulates across the committee's parallel calls; runCommittee's allSettled must finish everyone
  // before throwIfPending() is called, so one work order can name every missing critic at once.
  private pending: PendingUnit[] = [];

  constructor(opts: { runDir: string; cursor: RoundCursor }) {
    this.runDir = opts.runDir;
    this.cursor = opts.cursor;
  }

  private get version(): string {
    return versionName(this.cursor.index);
  }

  async critique(critic: CriticName, _input: CriticInput, _model: string): Promise<Critique> {
    const dir = join(this.runDir, this.version);
    const archived = await readJson(join(dir, "critiques", `${critic}.json`));
    const raw = archived !== NOT_FOUND ? archived : await readJson(join(dir, "inbox", `${critic}.json`));
    if (raw === NOT_FOUND) {
      this.pending.push({ critic });
      throw new Pending(critic);
    }
    // A file that exists but is malformed is NOT pending: parseCritique throws its own error, and
    // runCommittee treats that as an ordinary dropped critic (renormalising weights over survivors).
    // Never widen parseCritique's tolerance here — it is the only barrier between whatever a subagent
    // wrote and the scoring code.
    return parseCritique(critic, raw);
  }

  /**
   * Raises one work order naming every critic still to answer. Must be called only after
   * `runCommittee` has settled all four critics, never from inside `critique()` itself — otherwise the
   * first missing file would throw before its siblings' files were even checked.
   *
   * Call this BEFORE reading `CommitteeResult` — see the class-level "CALLING CONTRACT" comment. A
   * pending critic looks exactly like a dropped one to `runCommittee`, so checking here first is the
   * only way to tell "the round must suspend" apart from "the round scored with one fewer critic".
   */
  throwIfPending(): void {
    if (this.pending.length === 0) return;
    const units = [...this.pending];
    this.pending = [];
    throw new WorkOrderPending("critics", this.version, units);
  }

  // No takeUsage(): subagent tokens never reach this process, so there is nothing to report. Defining
  // one that returns undefined would make it *present*, and calibrate.ts's pricedTotal keys off
  // `llm.takeUsage` being defined to decide whether a run is priceable — omitting it entirely is what
  // makes agent-mode calibration report "not priced" instead of a false "$0.00".
}
