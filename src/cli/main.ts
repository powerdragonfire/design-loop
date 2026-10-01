import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicChairClient, type ChairClient } from "../chair/chair.js";
import { loadContract } from "../contract/load.js";
import { AnthropicLlmClient, type LlmClient } from "../critics/llm.js";
import { buildReport, captureApproval } from "../report/report.js";
import { createStitchGenerator, type Generator } from "../stitch/adapter.js";
import { createFigmaClient } from "../figma/client.js";
import { FigmaGenerator, figmaMeasure, normaliseNodeId } from "../figma/generator.js";
import type { Config, MeasuredDoc } from "../types.js";
import { defaultAgentsDir, staleAgents, syncAgents } from "./agents.js";
import { abDistiller, calibrate, calibrateAgent } from "./calibrate.js";
import { inspectVersion } from "./inspect.js";
import { createProgress, noProgress, promptLines, type Progress, type ProgressMode } from "./progress.js";
import { runScreen } from "./run.js";
import { isSkipped, smoke } from "./smoke.js";
import { readStart, stepRun, type RunStart } from "./step.js";
import { check, formatRows } from "./check.js";
import { figmaFrameUrl, formatRuns, listRuns } from "./runs.js";
import { runIdentity } from "../store/store.js";

export interface Deps {
  runScreen: typeof runScreen;
  stepRun: typeof stepRun;
  /** The screen and date a run directory is for, so a resumed run needs no retyping. */
  runIdentity: typeof runIdentity;
  buildReport: typeof buildReport;
  captureApproval: typeof captureApproval;
  calibrate: typeof calibrate;
  /** `calibrate` for a folder whose critics are subagents: suspends on a work order until they have answered. */
  calibrateAgent: typeof calibrateAgent;
  abDistiller: typeof abDistiller;
  smoke: typeof smoke;
  /**
   * The generator a run uses. Given the design folder's config it picks Stitch or Figma; without one, Stitch.
   * `seed` is a Figma run's starting frame (`run --seed`), which its first generation duplicates.
   */
  makeGenerator(config?: Config, seed?: string): Generator;
  /**
   * The measure a run uses, when it is not the default Chromium render. Figma frames are serialised node trees,
   * not HTML, so a Figma run measures them natively. Optional so a test's Deps need not supply it.
   */
  makeMeasure?(config?: Config): ((html: string) => Promise<MeasuredDoc>) | undefined;
  makeLlm(): LlmClient;
  makeChair(): ChairClient;
  /** The committee's top-ranked version of a finalised run. */
  committeePick(runDir: string): Promise<string>;
  /** The candidate stage's own pick; undefined for a run finalised before that stage existed. */
  candidateWinner(runDir: string): Promise<string | undefined>;
  /** Fails, naming what is wrong, before any Stitch quota or model spend. */
  preflight(): Promise<void>;
  openInBrowser(path: string): Promise<void>;
  ask(question: string): Promise<string>;
  now(): Date;
}

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Builds the live progress reporter for a command; without one a command reports nothing but its results. */
  makeProgress?(mode: ProgressMode): Progress;
}

const USAGE = `Usage: design-loop [--design <dir>] <command>

Commands:
  check [screen]                     list everything a run needs and what is missing (--offline: no Figma call)
  runs [--json]                      every run in the design folder: state, scores, approval, Figma frames
  smoke                              check every live service once, before spending real money
  run <screen> [--date YYYY-MM-DD]   generate and critique a screen until a stopping rule fires
      [--direction N]                start from art direction N (one run per direction to compare them)
      [--from <nodeId>]              Figma: improve an existing frame; it is scored as v00
      [--seed <nodeId>]              Figma: build v00 by duplicating this frame (a missing state)
  step <runDir>                      advance an agent-mode run by one round
  sync-agents                        write the agent definitions from the critic rubrics
  review <runDir>                    open the report, then ask which version to approve
  report <runDir>                    build the report page and open it
  approve <runDir> <vNN|cN>          record your pick for a run
  calibrate [--repeats N]            measure the composite's noise floor into config.json
                                     (agent mode: exits 10 with a work order until the critics answer)
  ab-distiller                       list what the digest loses against the raw HTML
  inspect <versionDir>               look up measured nodes by --selector or --text

Options:
  --design <dir>                     the design folder (default: design)
  --quiet                            print results only, no progress
  --verbose                          also print token counts per call
  --date YYYY-MM-DD                  the run's date (default: today, UTC)
  --repeats N                        calibration repeats per screen (default: 5)
  --selector <css>                   the node to look up, for \`inspect\`
  --text <substring>                 match nodes by text, for \`inspect\`
  --agents-dir <dir>                 agent definitions, for \`sync-agents\`, \`run\` and \`step\`
                                     (default: ~/.claude/agents)`;

/** A mistake in how the command was typed: exit 2 with the reason and the usage. */
class UsageError extends Error {}

const FAILED_AUTH = new Set([401, 403]);

/** Production wiring: the real modules, for the design folder in use. Every field is replaceable in tests. */
export function defaultDeps(designDir: string, io: Io, progress: Progress = noProgress, mode: ProgressMode = "normal"): Deps {
  return {
    runScreen,
    stepRun,
    runIdentity,
    buildReport,
    captureApproval,
    calibrate,
    calibrateAgent,
    abDistiller,
    smoke,
    makeGenerator: (config, seed) =>
      config?.generator === "figma"
        // The token comes from FIGMA_TOKEN, never config; createFigmaClient names it if it is missing.
        ? new FigmaGenerator({ client: createFigmaClient({ fileKey: config.figma?.fileKey }), seed })
        : createStitchGenerator({
            quotaDir: designDir,
            onRetry: (r) => progress.warn(`stitch ${r.what} failed, attempt ${r.attempt} of ${r.of} in ${r.waitMs / 1000}s: ${r.error.split("\n")[0]!.slice(0, 100)}`),
            // What was asked for, not only what came back: a generation is slow and expensive, and the prompt
            // is the one input worth seeing while waiting on it.
            onPrompt: (pr) => { for (const line of promptLines(pr.what, pr.prompt, mode)) progress.info(line); },
          }),
    makeMeasure: (config) => (config?.generator === "figma" ? figmaMeasure() : undefined),
    makeLlm: () => new AnthropicLlmClient(),
    makeChair: () => new AnthropicChairClient(),
    async committeePick(runDir) {
      const file = join(resolve(runDir), "manifest.json");
      const raw = await readFile(file, "utf8").catch(() => null);
      const rank = raw === null ? undefined : (JSON.parse(raw) as { committeeRank?: string[] }).committeeRank;
      if (!rank?.[0]) throw new Error(`run not finalised: ${file} has no committee pick`);
      return rank[0];
    },
    async candidateWinner(runDir) {
      const file = join(resolve(runDir), "manifest.json");
      const raw = await readFile(file, "utf8").catch(() => null);
      const selection = raw === null ? undefined : (JSON.parse(raw) as { selection?: { winner?: string } | null }).selection;
      return selection?.winner;
    },
    async preflight() {
      const { config } = await loadContract(designDir, {}, undefined, { allowNullSigma: true });
      createStitchGenerator({ quotaDir: designDir }); // its own check of the Stitch variables; the client is discarded
      // Free, and authenticated: a bad key stops the run here, before Stitch quota is spent, instead of inside the
      // committee where every critic would be dropped as non-retryable.
      try {
        await new Anthropic().messages.countTokens({ model: config.models.critic, messages: [{ role: "user", content: "hi" }] });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== undefined && FAILED_AUTH.has(status)) throw new Error(`Anthropic rejected the API key (${status})`);
        throw err;
      }
    },
    openInBrowser: (path) =>
      new Promise<void>((done) => {
        const [cmd, args] =
          process.platform === "darwin" ? ["open", [path]]
          : process.platform === "win32" ? ["cmd", ["/c", "start", "", path]]
          : ["xdg-open", [path]];
        const child = spawn(cmd!, args as string[], { detached: true, stdio: "ignore" });
        child.once("error", () => { io.out(`open it yourself: ${path}`); done(); });
        child.once("spawn", () => { child.unref(); done(); });
      }),
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        // A closed stdin (a pipe, CI) never answers; treat it as "skip" rather than hang.
        return await new Promise<string>((done) => {
          rl.once("close", () => done("q"));
          void rl.question(question).then(done);
        });
      } finally {
        rl.close();
      }
    },
    now: () => new Date(),
  };
}

const usd = (v: number | null): string => (v === null ? "unknown (no price for the model)" : `$${v.toFixed(2)}`);

/**
 * What the run cost, from its manifest; null when the manifest is unreadable, so a report never fails on it.
 * `usd` is itself `number | null`: null there is agent mode's honest "not measured", never absence of the field.
 */
async function readSpend(runDir: string): Promise<{ usd?: number | null; stitchGenerations?: number } | null> {
  try {
    const manifest = JSON.parse(await readFile(join(resolve(runDir), "manifest.json"), "utf8"));
    return manifest.spend ?? null;
  } catch {
    return null;
  }
}

async function approve(d: Deps, io: Io, runDir: string, id: string, known?: string): Promise<void> {
  await d.captureApproval(runDir, id);
  if (CANDIDATE_ID.test(id)) {
    // manifest.committeeRank[0] is a VERSION id; comparing a candidate against it would always read
    // "differs", so a candidate is judged against the candidate stage's own pick instead. A run
    // finalised before that stage existed has no selection.winner, so it falls back to today's read.
    const winner = (await d.candidateWinner(runDir)) ?? (await d.committeePick(runDir));
    io.out(`Approved ${id}: ${id === winner ? "agrees with" : `differs from (${winner})`} the committee's candidate pick.`);
    return;
  }
  const pick = known ?? (await d.committeePick(runDir));
  io.out(`Approved ${id}: ${id === pick ? "agrees with" : `differs from (${pick})`} the committee's pick.`);
}

/**
 * Whether this design folder's critics are Claude Code subagents rather than API calls.
 *
 * Only ONE failure is tolerated: no `config.json` at all, which is not a mode decision and which the CLI's
 * own tests hit by driving `run` against the default `design/` folder that does not exist. Every other
 * contract error — bad JSON, weights that do not sum to 1, an empty `tokens.json`, a missing `brief.md` —
 * is thrown from here with its own message.
 *
 * It must NOT swallow those. A mode selector that fails open sends an agent-mode run down the API path,
 * where `preflight()` runs first and reports a broken `tokens.json` as a rejected Anthropic key — a key an
 * agent-mode run has no reason to hold, which is the very dead end the branch below exists to avoid.
 */
async function isAgentMode(designDir: string): Promise<boolean> {
  return (await readConfig(designDir))?.criticMode === "agent";
}

/**
 * The design folder's config, or null when there is no config.json at all — the one absence that is tolerated,
 * so `step <runDir>` still works from a folder that has none. Anything else wrong with the contract throws, for
 * the reason `isAgentMode` gives: failing open would mis-route the run and misreport the error.
 */
async function readConfig(designDir: string): Promise<Config | null> {
  if (!existsSync(join(designDir, "config.json"))) return null;
  const { config } = await loadContract(designDir, {}, undefined, { allowNullSigma: true });
  return config;
}

/**
 * One suspension of an agent-mode run: `runDir` absent claims a new run, present resumes that one. Exit 10
 * means a work order is waiting — not a failure, and deliberately not 0, so a script driving the loop can
 * tell "dispatch these agents and call me again" apart from "the run is finished".
 */
async function stepCommand(
  d: Deps, io: Io, progress: Progress, designDir: string, agentsDir: string, runDir?: string, screen?: string, date?: string,
  start: RunStart = {},
): Promise<number> {
  // A resumed run says which screen and date it is for; only the first step is told.
  const identity = runDir === undefined ? { screen: screen!, date: date! } : await d.runIdentity(runDir);
  const config = (await readConfig(designDir)) ?? undefined;
  const figma = config?.generator === "figma";
  // A resumed run starts the way its first step did, whatever this command line says.
  const begun = runDir === undefined ? start : await readStart(runDir);
  if (!figma && (begun.from !== undefined || begun.seed !== undefined)) {
    throw new UsageError("--from and --seed name Figma frames: they need \"generator\": \"figma\"");
  }
  const out = await d.stepRun({
    designDir, ...identity, runDir, generator: begun.seed === undefined ? d.makeGenerator(config) : d.makeGenerator(config, begun.seed), log: (line) => io.out(line), progress,
    ...(runDir === undefined && Object.keys(start).length > 0 ? { start } : {}),
    // Every real agent-mode run checks its agent files; only `stepRun`'s own unit tests, which construct
    // this option directly, ever leave it unset.
    agentsDir,
    // Only a Figma run adds these, so a Stitch step is called exactly as it always was.
    ...(figma ? { measure: d.makeMeasure?.(config), snapshotDesigns: true, figma: config.figma } : {}),
  });
  if (!out.done) {
    io.out(`Run: ${out.runDir}`);
    io.out(`Work order: ${out.workOrder}`);
    if (out.kind === "design") {
      // No subagent can do this one: none of them can reach Figma.
      io.out("Build the frame in Figma as the order says (for an edit: duplicate, never edit in place),");
      io.out(`write its node id to the file the order names, then: design-loop step ${out.runDir}`);
    } else {
      io.out(`Dispatch the agents it names, then: design-loop step ${out.runDir}`);
    }
    return 10;
  }
  // The summary first, then the report, for the reason runCommand gives: a failing report must not cost the
  // operator the outcome of a run that has already been paid for.
  io.out(`Stop reason: ${out.result.stopReason}${out.result.abortReason ? ` (${out.result.abortReason})` : ""}`);
  io.out(`Versions: ${out.result.versions}, best: ${out.result.best}`);
  try {
    io.out(`Report: ${await d.buildReport(out.runDir)}`);
  } catch (err) {
    io.err(`Report failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  io.out(`Review with: design-loop review ${out.runDir}`);
  return out.result.stopReason === "aborted" ? 3 : 0;
}

async function runCommand(
  d: Deps, io: Io, progress: Progress, designDir: string, agentsDir: string, screen: string, date: string,
  start: RunStart = {},
): Promise<number> {
  // In agent mode `run` IS the first step: the critics are subagents this process cannot call, so the round
  // suspends as soon as they are needed. The preflight is skipped with it — it authenticates an Anthropic key
  // that an agent-mode run never uses, and failing on a key nobody needs would block the whole mode.
  if (await isAgentMode(designDir)) return await stepCommand(d, io, progress, designDir, agentsDir, undefined, screen, date, start);
  if (start.from !== undefined || start.seed !== undefined) {
    throw new UsageError("--from and --seed name Figma frames: they need \"generator\": \"figma\"");
  }
  await progress.phase("check credentials", () => d.preflight());
  const generator = d.makeGenerator();
  const result = await d.runScreen({
    designDir, screen, date, generator, llm: d.makeLlm(), chairClient: d.makeChair(), log: (line) => io.out(line), progress,
    ...(start.direction !== undefined ? { direction: start.direction } : {}),
  });
  // The summary first: on a PAID run a failing report must not cost the operator the stop reason, the
  // versions, what was spent, or the exit-3 signal a script reads.
  const spend = await readSpend(result.runDir);
  io.out(`Stop reason: ${result.stopReason}${result.abortReason ? ` (${result.abortReason})` : ""}`);
  io.out(`Versions: ${result.versions}, best: ${result.best}`);
  // `!== undefined` would let a `null` usd (agent mode's honest "not measured") through to `.toFixed()` and
  // crash the summary line the operator most needs to see. Handle it as its own case instead of coercing it.
  if (spend?.usd != null) io.out(`Spend: $${spend.usd.toFixed(2)}, ${spend.stitchGenerations ?? 0} Stitch generations`);
  else if (spend) io.out(`Spend: not metered (agent mode), ${spend.stitchGenerations ?? 0} Stitch generations`);
  try {
    io.out(`Report: ${await d.buildReport(result.runDir)}`);
  } catch (err) {
    io.err(`Report failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  io.out(`Review with: design-loop review ${result.runDir}`);
  return result.stopReason === "aborted" ? 3 : 0;
}

/**
 * The diagnostic the operator runs before the first paid run. Every step is printed whatever the others
 * did, and only a step that actually failed — not one that was skipped for want of an earlier step's
 * output — decides the exit code.
 */
async function smokeCommand(d: Deps, io: Io, progress: Progress, designDir: string): Promise<number> {
  await progress.phase("check credentials", () => d.preflight());
  io.out("Checking the live services. This uses 2 Stitch generations and roughly $0.30 of Claude spend.");
  const report = await d.smoke({
    designDir,
    generator: d.makeGenerator(),
    llm: d.makeLlm(),
    chairClient: d.makeChair(),
    progress,
  });
  let failed = false;
  for (const step of report.steps) {
    const label = isSkipped(step) ? "SKIP" : step.ok ? "PASS" : "FAIL";
    if (label === "FAIL") failed = true;
    io.out(`${label} ${step.name}: ${step.detail}`);
  }
  io.out(`Estimated spend: ${usd(report.usd)}`);
  return failed ? 1 : 0;
}

async function reviewCommand(d: Deps, io: Io, runDir: string): Promise<number> {
  const report = await d.buildReport(runDir);
  io.out(`Report: ${report}`);
  await d.openInBrowser(report);
  const pick = await d.committeePick(runDir);
  io.out(`The committee's pick: ${pick}`);
  const answer = (await d.ask(`Approve which version? [${pick}, q to skip] `)).trim();
  if (answer.toLowerCase() === "q") {
    io.out("Nothing approved.");
    return 0;
  }
  await approve(d, io, runDir, answer === "" ? pick : answer, pick);
  return 0;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A run's approvable things are its versions and, since the candidate stage, its candidates.
const APPROVABLE = /^(v\d+|c\d+)$/;
const CANDIDATE_ID = /^c\d+$/;

export async function main(argv: string[], io: Io, overrides: Partial<Deps> = {}): Promise<number> {
  let progress: Progress = noProgress;
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        options: {
          design: { type: "string" }, date: { type: "string" }, repeats: { type: "string" }, help: { type: "boolean" },
          quiet: { type: "boolean" }, verbose: { type: "boolean" },
          selector: { type: "string" }, text: { type: "string" }, "agents-dir": { type: "string" },
          direction: { type: "string" }, from: { type: "string" }, seed: { type: "string" },
          json: { type: "boolean" }, offline: { type: "boolean" },
        },
        allowPositionals: true,
        strict: true,
      });
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    const { values, positionals } = parsed;
    const [command, ...args] = positionals;
    if (values.help || command === undefined) throw new UsageError("");

    const need = (n: number, what: string): void => {
      if (args.length !== n) throw new UsageError(`\`${command}\` takes ${what}`);
    };
    const only = (option: "date" | "repeats" | "selector" | "text" | "direction" | "from" | "seed" | "offline", cmd: string): void => {
      if (values[option] !== undefined && command !== cmd) throw new UsageError(`--${option} only applies to \`${cmd}\``);
    };
    only("date", "run");
    only("repeats", "calibrate");
    only("selector", "inspect");
    only("text", "inspect");
    only("direction", "run");
    only("from", "run");
    only("seed", "run");
    if (values.json !== undefined && command !== "check" && command !== "runs") throw new UsageError("--json only applies to `check` and `runs`");
    only("offline", "check");

    if (values.quiet && values.verbose) throw new UsageError("--quiet and --verbose cannot be used together");
    const designDir = values.design ?? "design";
    // One value for the writer (`sync-agents`) and the checker (`run`/`step`), so they cannot disagree.
    const agentsDir = values["agents-dir"] ?? defaultAgentsDir();
    const mode: ProgressMode = values.quiet ? "quiet" : values.verbose ? "verbose" : "normal";
    progress = io.makeProgress?.(mode) ?? noProgress;
    const d: Deps = { ...defaultDeps(designDir, io, progress, mode), ...overrides };

    switch (command) {
      case "run": {
        need(1, "one argument: <screen>");
        const date = values.date ?? d.now().toISOString().slice(0, 10);
        if (!DATE.test(date)) throw new UsageError(`--date must be YYYY-MM-DD (got ${date})`);
        const start: RunStart = {};
        if (values.direction !== undefined) {
          const n = Number(values.direction);
          if (!Number.isInteger(n) || n < 0) throw new UsageError(`--direction must be a whole number from 0 (got ${values.direction})`);
          start.direction = n;
        }
        if (values.from !== undefined && values.seed !== undefined) throw new UsageError("--from and --seed cannot be used together");
        try {
          if (values.from !== undefined) start.from = normaliseNodeId(values.from);
          if (values.seed !== undefined) start.seed = normaliseNodeId(values.seed);
        } catch (err) {
          throw new UsageError((err as Error).message);
        }
        return await runCommand(d, io, progress, designDir, agentsDir, args[0]!, date, start);
      }
      case "runs": {
        need(0, "no arguments");
        const runs = await listRuns(designDir);
        if (!values.json) {
          for (const line of formatRuns(runs)) io.out(line);
          return 0;
        }
        // Frame links need the file key, which only the config knows; a folder without one gets none.
        const fileKey = (await readConfig(designDir).catch(() => null))?.figma?.fileKey;
        const linked = fileKey === undefined ? runs : runs.map((r) => ({
          ...r, versions: r.versions.map((v) => (v.frameId ? { ...v, frameUrl: figmaFrameUrl(fileKey, v.frameId) } : v)),
        }));
        io.out(JSON.stringify(linked, null, 2));
        return 0;
      }
      case "check": {
        if (args.length > 1) throw new UsageError("`check` takes at most one argument: [screen]");
        const rows = await check({ designDir, screen: args[0], agentsDir, offline: values.offline });
        if (values.json) io.out(JSON.stringify(rows, null, 2));
        else for (const line of formatRows(rows)) io.out(line);
        return rows.some((r) => r.status === "fail") ? 1 : 0;
      }
      case "step": {
        need(1, "one argument: <runDir>");
        return await stepCommand(d, io, progress, designDir, agentsDir, args[0]!);
      }
      case "sync-agents": {
        need(0, "no arguments");
        const written = await syncAgents({ outDir: agentsDir });
        for (const f of written) io.out(`wrote ${f}`);
        return 0;
      }
      case "smoke":
        need(0, "no arguments");
        return await smokeCommand(d, io, progress, designDir);
      case "report": {
        need(1, "one argument: <runDir>");
        const report = await d.buildReport(args[0]!);
        io.out(`Report: ${report}`);
        await d.openInBrowser(report);
        return 0;
      }
      case "approve": {
        need(2, "two arguments: <runDir> <vNN|cN>");
        const id = args[1]!;
        if (!APPROVABLE.test(id)) throw new UsageError(`not a version or candidate id: ${id} (expected vNN or cN)`);
        await approve(d, io, args[0]!, id);
        return 0;
      }
      case "review":
        need(1, "one argument: <runDir>");
        return await reviewCommand(d, io, args[0]!);
      case "calibrate": {
        need(0, "no arguments");
        const repeats = values.repeats === undefined ? undefined : Number(values.repeats);
        if (repeats !== undefined && !Number.isInteger(repeats)) throw new UsageError(`--repeats must be a whole number (got ${values.repeats})`);
        const config = await readConfig(designDir);
        if (config?.criticMode === "agent") {
          // The same refusal `step` makes: a critic briefed from an old rubric would calibrate the wrong standard.
          const stale = await staleAgents({ outDir: agentsDir });
          if (stale.length > 0) {
            throw new Error(`these agent definitions are missing or out of date: ${stale.join(", ")}. Run \`design-loop sync-agents\`.`);
          }
          const a = await d.calibrateAgent({ designDir, repeats, measure: d.makeMeasure?.(config), log: (line) => io.out(line) });
          if (!a.done) {
            io.out(`Work order: ${a.workOrder}`);
            io.out(`Dispatch the agents it names, then run calibrate again (with the same --repeats).`);
            return 10;
          }
          io.out(`sigma ${a.sigma.toFixed(2)} over ${a.repeats} agent-mode repeats of ${a.screens.join(", ")} (written to ${join(designDir, "config.json")})`);
          for (const [critic, s] of Object.entries(a.perCritic)) io.out(`  ${critic}: ${s.toFixed(2)}`);
          io.out("Cost: not metered (agent mode)");
          return 0;
        }
        const r = await d.calibrate({ designDir, llm: d.makeLlm(), repeats, log: (line) => io.out(line), progress });
        io.out(`sigma ${r.sigma.toFixed(2)} over ${r.repeats} repeats of ${r.screens.join(", ")} (written to ${join(designDir, "config.json")})`);
        for (const [critic, s] of Object.entries(r.perCritic)) io.out(`  ${critic}: ${s.toFixed(2)}`);
        io.out(`Cost: ${usd(r.usd)}`);
        return 0;
      }
      case "ab-distiller": {
        need(0, "no arguments");
        const r = await d.abDistiller({ designDir, llm: d.makeLlm(), log: (line) => io.out(line), progress });
        io.out("Claims only the raw-HTML critique raised (add what they need to measure's STYLE_PROPS):");
        for (const s of r.screens) {
          io.out(`${s.screen}: ${s.rawOnly.length} raw-only`);
          for (const i of s.rawOnly) io.out(`  [${i.critic}, ${i.severity}] ${i.claim}`);
        }
        io.out(`Cost: ${usd(r.usd)}`);
        return 0;
      }
      case "inspect": {
        need(1, "one argument: <versionDir>");
        // stdout, not io.out through progress or a summary line: a subagent parses this as JSON, so nothing
        // else may share stdout with it.
        const nodes = await inspectVersion({ versionDir: args[0]!, selector: values.selector, text: values.text });
        io.out(JSON.stringify(nodes, null, 2));
        return 0;
      }
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(err.message ? `${err.message}\n${USAGE}` : USAGE);
      return 2;
    }
    io.err(err instanceof Error ? err.message : String(err));
    if (process.env.DEBUG && err instanceof Error && err.stack) io.err(err.stack);
    return 1;
  } finally {
    progress.close();
  }
}

// Only when this file is the process entry point, never on import (the tests import it).
const entry = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entry !== null && import.meta.url === pathToFileURL(entry).href) {
  const code = await main(process.argv.slice(2), {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    // Progress is for eyes, so it goes to stderr and leaves stdout to the results a script reads.
    makeProgress: (mode) =>
      createProgress({
        write: (s) => process.stderr.write(s),
        tty: Boolean(process.stderr.isTTY),
        color: Boolean(process.stderr.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb",
        columns: process.stderr.columns,
        mode,
      }),
  });
  // Let both streams flush before exiting; open SDK sockets would otherwise keep the process alive.
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}
