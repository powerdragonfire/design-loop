import type { Progress } from "../../src/cli/progress.js";

/** A reporter that writes down what it was told, in order, so a test can read the story of a command. */
export function recordProgress() {
  const events: string[] = [];
  const suffix = (detail?: string) => (detail ? `: ${detail}` : "");
  const progress: Progress = {
    begin(label) {
      events.push(`begin ${label}`);
      return {
        done: (detail) => { events.push(`done ${label}${suffix(detail)}`); },
        fail: (detail) => { events.push(`fail ${label}${suffix(detail)}`); },
      };
    },
    async phase(label, fn, summarise) {
      events.push(`begin ${label}`);
      try {
        const result = await fn();
        events.push(`done ${label}${suffix(summarise?.(result))}`);
        return result;
      } catch (err) {
        events.push(`fail ${label}${suffix(err instanceof Error ? err.message : String(err))}`);
        throw err;
      }
    },
    skipped: (label, why) => { events.push(`skipped ${label}: ${why}`); },
    header: (lines) => { for (const l of lines) events.push(`header ${l}`); },
    banner: (title, o) => { events.push(`banner ${title}${o?.fraction === undefined ? "" : ` @${o.fraction}`}`); },
    info: (line) => { events.push(`info ${line}`); },
    warn: (line) => { events.push(`warn ${line}`); },
    debug: (line) => { events.push(`debug ${line}`); },
    setStatus() {},
    attachLog: (path) => { events.push(`log ${path}`); },
    elapsedMs: () => 0,
    close: () => { events.push("close"); },
  };
  return { progress, events };
}
