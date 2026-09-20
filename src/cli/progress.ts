import { appendFileSync } from "node:fs";
import type { CommitteeHooks } from "../critics/llm.js";

/** `quiet` prints nothing; `verbose` adds the lines a person debugging a run wants (token counts). */
export type ProgressMode = "normal" | "quiet" | "verbose";

/** One running step. Closing it twice is harmless: the second call is ignored. */
export interface Step {
  done(detail?: string): void;
  fail(detail?: string): void;
}

/**
 * What a command tells the person while it works. Progress is for eyes and goes to stderr; the results a
 * script reads stay on stdout, so the two never mix.
 */
export interface Progress {
  /** Starts a named step, shown live until it is closed. */
  begin(label: string): Step;
  /** `begin`, run `fn`, close with `summarise(result)` as the detail, or with the error message if it throws. */
  phase<T>(label: string, fn: () => Promise<T>, summarise?: (result: T) => string | undefined): Promise<T>;
  /** A step that never ran; not a failure. */
  skipped(label: string, why: string): void;
  /** The lines that open a command: what is about to run, and against what. */
  header(lines: string[]): void;
  /** A divider between rounds, with an optional bar (0..1) and a status. */
  banner(title: string, opts?: { fraction?: number; status?: string }): void;
  info(line: string): void;
  warn(line: string): void;
  /** Only in `verbose` mode. */
  debug(line: string): void;
  /** Shown after the timer on the live line while a step runs (a terminal only). */
  setStatus(text: string): void;
  /** Also append every event, as JSON lines, to this file: what happened, and when, after the terminal is gone. */
  attachLog(path: string): void;
  elapsedMs(): number;
  /** Stops the live line and, if anything ran, says how long it all took. */
  close(): void;
}

const NOOP_STEP: Step = { done() {}, fail() {} };

/** Used wherever no reporter is passed, so callers never test for one. */
export const noProgress: Progress = {
  begin: () => NOOP_STEP,
  phase: (_label, fn) => fn(),
  skipped() {},
  header() {},
  banner() {},
  info() {},
  warn() {},
  debug() {},
  setStatus() {},
  attachLog() {},
  elapsedMs: () => 0,
  close() {},
};

const LABEL_WIDTH = 24;

/**
 * The live line on a terminal while a step runs: the spinner frame, what is running, how long, and the status
 * text. Change this to change what you see; nothing else depends on its shape.
 */
export function formatStatus(s: { frame: string; label: string; elapsed: string; status: string }): string {
  return `${s.frame} ${s.label.padEnd(LABEL_WIDTH)} ${s.elapsed.padStart(5)}${s.status ? `  ${s.status}` : ""}`;
}

/** m:ss, for a clock that counts up on the live line. */
const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A finished step: milliseconds while it is under a second, then m:ss. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : clock(ms);
}

/** First line only, and short: a long error is printed in full where it is finally reported. */
export const oneLine = (text: string, max = 140): string => {
  const first = text.split("\n")[0]!.trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};
const errorText = (err: unknown): string => oneLine(err instanceof Error ? err.message : String(err));

/**
 * The prompt about to go to Stitch, as sub-lines under the step that sends it — two spaces, the same
 * convention `committeeHooks` uses for its per-critic lines.
 *
 * A run's first prompt is a brief plus the whole token table, so only `--verbose` prints it in full, and
 * only when one line would actually lose something. Quiet formats like normal: `info` drops the lines, but
 * the JSONL event log keeps them, which is what makes a paid run answerable after the terminal is gone.
 */
export function promptLines(what: string, prompt: string, mode: ProgressMode): string[] {
  const text = prompt.trim();
  const short = oneLine(text);
  if (mode !== "verbose" || short === text) return [`  → ${what}: ${short}`];
  return [`  → ${what}:`, ...text.split("\n").map((line) => `    ${line}`)];
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_WIDTH = 16;
/** Kept when nothing has been attached, so a very long command cannot grow this without bound. */
const BACKLOG_CAP = 1000;

export interface ProgressOptions {
  write(text: string): void;
  /** A terminal redraws one live line in place; anything else gets plain timestamped lines and a heartbeat. */
  tty: boolean;
  color?: boolean;
  columns?: number;
  mode?: ProgressMode;
  now?: () => number;
  spinnerMs?: number;
  /** How often a non-terminal says a long step is still running. */
  heartbeatMs?: number;
}

interface Active {
  label: string;
  startedAt: number;
  beatAt: number;
}

interface LogEvent {
  t: string;
  type: string;
  label?: string;
  ms?: number;
  detail?: string;
}

export function createProgress(opts: ProgressOptions): Progress {
  const { write, tty } = opts;
  const mode = opts.mode ?? "normal";
  const color = opts.color ?? false;
  const now = opts.now ?? Date.now;
  const spinnerMs = opts.spinnerMs ?? 100;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const shown = mode !== "quiet";
  const createdAt = now();

  const stack: Active[] = [];
  let status = "";
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let began = 0;

  let backlog: LogEvent[] = [];
  let logPath: string | null = null;

  const paint = (code: string, text: string): string => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const green = (t: string) => paint("32", t);
  const red = (t: string) => paint("31", t);
  const dim = (t: string) => paint("2", t);
  const bold = (t: string) => paint("1", t);

  const record = (event: Omit<LogEvent, "t">): void => {
    const full: LogEvent = { t: new Date(now()).toISOString(), ...event };
    if (logPath === null) {
      if (backlog.length < BACKLOG_CAP) backlog.push(full);
      return;
    }
    try {
      appendFileSync(logPath, JSON.stringify(full) + "\n");
    } catch {
      // A log that cannot be written must never stop a paid run.
      logPath = null;
    }
  };

  const stamp = (): string => `[${new Date(now()).toTimeString().slice(0, 8)}] `;
  const clearLive = "\r\x1b[2K";

  const drawLive = (): void => {
    const top = stack[stack.length - 1];
    if (!shown || !tty || !top) return;
    const line = formatStatus({
      frame: FRAMES[frame % FRAMES.length]!,
      label: top.label,
      elapsed: clock(now() - top.startedAt),
      status,
    });
    // A pty can report 0 columns; an unknown width is not a width of zero.
    const width = opts.columns && opts.columns > 0 ? opts.columns : 100;
    write(clearLive + (line.length >= width ? line.slice(0, width - 1) : line));
  };

  /** A line that stays. On a terminal it replaces the live line, which is then drawn again beneath it. */
  const emit = (line: string): void => {
    if (!shown) return;
    if (tty) {
      write(`${clearLive}${line}\n`);
      drawLive();
    } else {
      write(`${stamp()}${line}\n`);
    }
  };

  const tick = (): void => {
    frame++;
    if (tty) {
      drawLive();
      return;
    }
    const top = stack[stack.length - 1];
    if (top && shown && now() - top.beatAt >= heartbeatMs) {
      top.beatAt = now();
      write(`${stamp()}… still waiting on ${top.label} (${formatDuration(now() - top.startedAt)})\n`);
    }
  };

  const startTimer = (): void => {
    if (timer) return;
    timer = setInterval(tick, tty ? spinnerMs : Math.min(heartbeatMs, 1000));
    timer.unref();
  };
  const stopTimer = (): void => {
    if (timer && stack.length === 0) {
      clearInterval(timer);
      timer = null;
    }
  };

  const row = (icon: string, label: string, ms: number, detail?: string): string =>
    `${icon} ${label.padEnd(LABEL_WIDTH)} ${dim(formatDuration(ms).padStart(5))}${detail ? `  ${detail}` : ""}`;

  const begin = (label: string): Step => {
    const entry: Active = { label, startedAt: now(), beatAt: now() };
    stack.push(entry);
    began++;
    record({ type: "start", label });
    if (!tty) emit(`▸ ${label}`);
    startTimer();
    drawLive();
    let closed = false;
    const close = (ok: boolean, detail?: string): void => {
      if (closed) return;
      closed = true;
      const at = stack.indexOf(entry);
      if (at >= 0) stack.splice(at, 1);
      const ms = now() - entry.startedAt;
      record({ type: ok ? "done" : "fail", label, ms, detail });
      emit(row(ok ? green("✓") : red("✗"), label, ms, detail === undefined ? undefined : ok ? detail : red(detail)));
      stopTimer();
    };
    return { done: (detail) => close(true, detail), fail: (detail) => close(false, detail) };
  };

  return {
    begin,
    async phase(label, fn, summarise) {
      const step = begin(label);
      try {
        const result = await fn();
        step.done(summarise?.(result));
        return result;
      } catch (err) {
        step.fail(errorText(err));
        throw err;
      }
    },
    skipped(label, why) {
      record({ type: "skipped", label, detail: why });
      emit(`${dim("–")} ${dim(label.padEnd(LABEL_WIDTH))}       ${dim(`skipped: ${why}`)}`);
    },
    header(lines) {
      for (const line of lines) {
        record({ type: "header", detail: line });
        emit(bold(line));
      }
    },
    banner(title, o) {
      const fraction = o?.fraction === undefined ? null : Math.max(0, Math.min(1, o.fraction));
      const filled = fraction === null ? 0 : Math.round(fraction * BAR_WIDTH);
      const bar = fraction === null ? "" : `  ${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
      record({ type: "banner", label: title, detail: o?.status });
      emit(bold(`── ${title}${bar}${o?.status ? `  ${o.status}` : ""} ──`));
    },
    info(line) {
      record({ type: "info", detail: line });
      emit(line);
    },
    warn(line) {
      record({ type: "warn", detail: line });
      emit(`${red("!")} ${line}`);
    },
    debug(line) {
      if (mode !== "verbose") return;
      record({ type: "debug", detail: line });
      emit(dim(line));
    },
    setStatus(text) {
      status = text;
    },
    attachLog(path) {
      const earlier = backlog;
      backlog = [];
      logPath = path;
      try {
        appendFileSync(path, earlier.map((e) => JSON.stringify(e) + "\n").join(""));
      } catch {
        logPath = null;
      }
    },
    elapsedMs: () => now() - createdAt,
    close() {
      while (stack.length > 0) stack.pop();
      stopTimer();
      if (tty && shown) write(clearLive);
      if (began > 0) emit(dim(`finished in ${formatDuration(now() - createdAt)}`));
    },
  };
}

/** The committee's own events, as the person sees them. `perCritic` adds one line per critic as it finishes. */
export function committeeHooks(progress: Progress, perCritic: boolean): CommitteeHooks {
  return {
    onRetry: (critic, error) => progress.warn(`${critic} critic failed, retrying once: ${oneLine(error, 100)}`),
    onCritic: perCritic
      ? (critic, outcome) =>
          progress.info(
            outcome.ok
              ? `  ✓ ${critic.padEnd(14)} ${String(Math.round(outcome.score)).padStart(3)}  ${formatDuration(outcome.ms)}`
              : `  ✗ ${critic.padEnd(14)} dropped: ${oneLine(outcome.error, 100)}`,
          )
      : undefined,
  };
}
