import { spawn } from "node:child_process";
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
import { abDistiller, calibrate } from "./calibrate.js";
import { createProgress, noProgress, type Progress, type ProgressMode } from "./progress.js";
import { runScreen } from "./run.js";
import { isSkipped, smoke } from "./smoke.js";

export interface Deps {
  runScreen: typeof runScreen;
  buildReport: typeof buildReport;
  captureApproval: typeof captureApproval;
  calibrate: typeof calibrate;
  abDistiller: typeof abDistiller;
  smoke: typeof smoke;
  makeGenerator(): Generator;
  makeLlm(): LlmClient;
  makeChair(): ChairClient;
  /** The committee's top-ranked version of a finalised run. */
  committeePick(runDir: string): Promise<string>;
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
  smoke                              check every live service once, before spending real money
  run <screen> [--date YYYY-MM-DD]   generate and critique a screen until a stopping rule fires
  review <runDir>                    open the report, then ask which version to approve
  report <runDir>                    build the report page and open it
  approve <runDir> <version>         record your pick for a run
  calibrate [--repeats N]            measure the composite's noise floor into config.json
  ab-distiller                       list what the digest loses against the raw HTML

Options:
  --design <dir>                     the design folder (default: design)
  --quiet                            print results only, no progress
  --verbose                          also print token counts per call
  --date YYYY-MM-DD                  the run's date (default: today, UTC)
  --repeats N                        calibration repeats per screen (default: 5)`;

/** A mistake in how the command was typed: exit 2 with the reason and the usage. */
class UsageError extends Error {}

const FAILED_AUTH = new Set([401, 403]);

/** Production wiring: the real modules, for the design folder in use. Every field is replaceable in tests. */
export function defaultDeps(designDir: string, io: Io, progress: Progress = noProgress): Deps {
  return {
    runScreen,
    buildReport,
    captureApproval,
    calibrate,
    abDistiller,
    smoke,
    makeGenerator: () =>
      createStitchGenerator({
        quotaDir: designDir,
        onRetry: (r) => progress.warn(`stitch ${r.what} failed, attempt ${r.attempt} of ${r.of} in ${r.waitMs / 1000}s: ${r.error.split("\n")[0]!.slice(0, 100)}`),
      }),
    makeLlm: () => new AnthropicLlmClient(),
    makeChair: () => new AnthropicChairClient(),
    async committeePick(runDir) {
      const file = join(resolve(runDir), "manifest.json");
      const raw = await readFile(file, "utf8").catch(() => null);
      const rank = raw === null ? undefined : (JSON.parse(raw) as { committeeRank?: string[] }).committeeRank;
      if (!rank?.[0]) throw new Error(`run not finalised: ${file} has no committee pick`);
      return rank[0];
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

/** What the run cost, from its manifest; null when the manifest is unreadable, so a report never fails on it. */
async function readSpend(runDir: string): Promise<{ usd?: number; stitchGenerations?: number } | null> {
  try {
    const manifest = JSON.parse(await readFile(join(resolve(runDir), "manifest.json"), "utf8"));
    return manifest.spend ?? null;
  } catch {
    return null;
  }
}

async function approve(d: Deps, io: Io, runDir: string, version: string, known?: string): Promise<void> {
  await d.captureApproval(runDir, version);
  const pick = known ?? (await d.committeePick(runDir));
  io.out(`Approved ${version}: ${version === pick ? "agrees with" : `differs from (${pick})`} the committee's pick.`);
}

async function runCommand(d: Deps, io: Io, progress: Progress, designDir: string, screen: string, date: string): Promise<number> {
  await progress.phase("check credentials", () => d.preflight());
  const generator = d.makeGenerator();
  const result = await d.runScreen({
    designDir, screen, date, generator, llm: d.makeLlm(), chairClient: d.makeChair(), log: (line) => io.out(line), progress,
  });
  // The summary first: on a PAID run a failing report must not cost the operator the stop reason, the
  // versions, what was spent, or the exit-3 signal a script reads.
  const spend = await readSpend(result.runDir);
  io.out(`Stop reason: ${result.stopReason}${result.abortReason ? ` (${result.abortReason})` : ""}`);
  io.out(`Versions: ${result.versions}, best: ${result.best}`);
  if (spend?.usd !== undefined) io.out(`Spend: $${spend.usd.toFixed(2)}, ${spend.stitchGenerations ?? 0} Stitch generations`);
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
    const only = (option: "date" | "repeats", cmd: string): void => {
      if (values[option] !== undefined && command !== cmd) throw new UsageError(`--${option} only applies to \`${cmd}\``);
    };
    only("date", "run");
    only("repeats", "calibrate");

    if (values.quiet && values.verbose) throw new UsageError("--quiet and --verbose cannot be used together");
    const designDir = values.design ?? "design";
    progress = io.makeProgress?.(values.quiet ? "quiet" : values.verbose ? "verbose" : "normal") ?? noProgress;
    const d: Deps = { ...defaultDeps(designDir, io, progress), ...overrides };

    switch (command) {
      case "run": {
        need(1, "one argument: <screen>");
        const date = values.date ?? d.now().toISOString().slice(0, 10);
        if (!DATE.test(date)) throw new UsageError(`--date must be YYYY-MM-DD (got ${date})`);
        return await runCommand(d, io, progress, designDir, args[0]!, date);
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
      case "approve":
        need(2, "two arguments: <runDir> <version>");
        await approve(d, io, args[0]!, args[1]!);
        return 0;
      case "review":
        need(1, "one argument: <runDir>");
        return await reviewCommand(d, io, args[0]!);
      case "calibrate": {
        need(0, "no arguments");
        const repeats = values.repeats === undefined ? undefined : Number(values.repeats);
        if (repeats !== undefined && !Number.isInteger(repeats)) throw new UsageError(`--repeats must be a whole number (got ${values.repeats})`);
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
