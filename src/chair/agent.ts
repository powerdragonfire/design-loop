import { join } from "node:path";
import { versionName, readChair, writeAtomic, type RoundCursor } from "../store/store.js";
import { WorkOrderPending } from "../critics/agent.js";
import type { ChairClient, ChairInput } from "./chair.js";
import type { Issue } from "../types.js";

/**
 * Reads the edit prompt a Claude Code subagent wrote to disk instead of calling the Anthropic API.
 * `chair()`'s ranking and MAX_CHANGES cap stay in code and are re-applied on every replay: this client
 * only resolves the ids the subagent named against `input.openIssues`, so the agent can name an issue
 * but never invent one, and it has no way to overrule the cap.
 *
 * `cursor` is read-only here, exactly as in `AgentLlmClient` (src/critics/agent.ts): the resuming
 * generator is the sole writer of `cursor.index`, once per round. The chair for round `n` runs while
 * the cursor still reads `n`, so its files live in `vNN/`, the same directory as the critiques it is
 * reacting to, not the round it will produce.
 */
export class AgentChairClient implements ChairClient {
  private readonly runDir: string;
  private readonly cursor: RoundCursor;

  constructor(opts: { runDir: string; cursor: RoundCursor }) {
    this.runDir = opts.runDir;
    this.cursor = opts.cursor;
  }

  async synthesise(input: ChairInput, _model: string): Promise<{ prompt: string; changes: Issue[] }> {
    const version = versionName(this.cursor.index);
    // Archived wins over inbox, tried first, so replaying an already-scored round can never pick up a
    // newer answer sitting in the inbox and silently change a past decision (same invariant as the
    // critics' client). readChair validates non-blankness itself; a blank prompt throws from there.
    const raw = (await readChair(this.runDir, version, "version")) ?? (await readChair(this.runDir, version, "inbox"));
    if (raw === null) {
      // The agent is briefed from the very `ChairInput` its answer is resolved against below, written out
      // before suspending. Built anywhere else — from `open-issues.json`, say — it would show the chair the
      // per-selector token ids rather than the grouped ones, every id it picked from that family would
      // resolve to nothing, and a later change to what `run.ts` hands the chair would never reach this mode.
      const screenshot = chairScreenshot(input, version);
      await writeAtomic(join(this.runDir, version, "chair-input.json"), `${JSON.stringify(chairInputFile(input, screenshot), null, 2)}\n`);
      throw new WorkOrderPending("chair", version, [], screenshot);
    }

    // Resolved against openIssues only, via a Set: an id naming nothing is silently dropped rather than
    // fabricated into an issue, and a duplicated id cannot produce a duplicated change.
    const byId = new Map(input.openIssues.map((i) => [i.id, i] as const));
    const changes: Issue[] = [];
    for (const id of new Set(raw.changeIds)) {
      const issue = byId.get(id);
      if (issue) changes.push(issue);
    }
    return { prompt: raw.prompt, changes };
  }

  // No takeUsage(): subagent tokens never reach this process, so there is nothing to report. See the
  // matching comment on AgentLlmClient (src/critics/agent.ts) — omitting it entirely, rather than
  // defining one that returns undefined, is what keeps `takeUsage` genuinely absent rather than present.
}

/**
 * The screenshot `input.imagePng` holds, as a path relative to the run directory. After a regression the
 * chair works on the best version and `runScreen` hands it that version's image; otherwise it is this round's.
 */
const chairScreenshot = (input: ChairInput, version: string): string =>
  `${input.regression?.bestVersion ?? version}/screen.png`;

/**
 * What `AnthropicChairClient` sends the model, as a file: the open issues, the regression block and the
 * tokens, with the image as a path. `critiques` is left out because the API chair never sends it either.
 */
const chairInputFile = (input: ChairInput, screenshot: string) => ({
  generator: input.generator ?? "stitch",
  screenshot,
  openIssues: input.openIssues,
  regression: input.regression,
  tokens: input.tokens,
});
