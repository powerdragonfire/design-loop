import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { committeeHooks, createProgress, formatDuration, formatStatus, noProgress, promptLines, type ProgressOptions } from "../../src/cli/progress.js";

const ESC = "\x1b[";
let out: string[];
const make = (over: Partial<ProgressOptions> = {}) =>
  createProgress({ write: (s) => out.push(s), tty: false, ...over });
const text = () => out.join("");
const lines = () => text().split("\n").filter(Boolean);

beforeEach(() => {
  out = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T13:30:00"));
});
afterEach(() => vi.useRealTimers());

describe("formatDuration", () => {
  it.each([[400, "400ms"], [999, "999ms"], [1000, "0:01"], [58_400, "0:58"], [62_000, "1:02"], [605_000, "10:05"]])(
    "%ims -> %s", (ms, want) => expect(formatDuration(ms)).toBe(want),
  );
});

describe("a plain stream (not a terminal)", () => {
  it("prints a timestamped line when a step starts and another, with its time, when it ends", () => {
    const p = make({ heartbeatMs: 600_000 });
    const step = p.begin("stitch generate");
    vi.advanceTimersByTime(58_000);
    step.done("2 KB html");
    const [start, end] = lines();
    expect(start).toMatch(/^\[\d\d:\d\d:\d\d\] ▸ stitch generate$/);
    expect(end).toMatch(/^\[\d\d:\d\d:\d\d\] ✓ stitch generate\s+0:58  2 KB html$/);
    p.close();
  });

  it("never writes a control character, colour or a carriage return", () => {
    const p = make();
    p.header(["run home"]);
    p.begin("a").fail("boom");
    p.warn("careful");
    p.banner("v01", { fraction: 0.5 });
    p.close();
    expect(text()).not.toContain("\r");
    expect(text()).not.toContain("\x1b[2K");
  });

  it("says a long step is still running every heartbeat, and stops once it ends", () => {
    const p = make({ heartbeatMs: 30_000 });
    const step = p.begin("stitch generate");
    vi.advanceTimersByTime(29_000);
    expect(text()).not.toContain("still waiting");
    vi.advanceTimersByTime(2_000);
    expect(lines().at(-1)).toMatch(/… still waiting on stitch generate \(0:30\)$/);
    vi.advanceTimersByTime(30_000);
    expect(text().match(/still waiting/g)).toHaveLength(2);
    step.done();
    const before = out.length;
    vi.advanceTimersByTime(120_000);
    expect(out.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not heartbeat between steps", () => {
    const p = make({ heartbeatMs: 30_000 });
    p.begin("a").done();
    vi.advanceTimersByTime(300_000);
    expect(text()).not.toContain("still waiting");
  });
});

describe("a terminal", () => {
  it("redraws one live line with a spinner, the label, the time and the status, and replaces it with the result", () => {
    const p = make({ tty: true, columns: 120 });
    p.setStatus("$0.41 so far");
    const step = p.begin("critics");
    vi.advanceTimersByTime(3_000);
    const live = out.filter((s) => s.startsWith("\r\x1b[2K") && !s.endsWith("\n"));
    expect(live.length).toBeGreaterThan(2);
    expect(live.at(-1)).toMatch(/^\r\x1b\[2K[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] critics\s+0:03  \$0\.41 so far$/);
    step.done("4/4 ok");
    expect(text()).toMatch(/\r\x1b\[2K✓ critics\s+0:03  4\/4 ok\n$/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the live line beneath a line printed while a step runs", () => {
    const p = make({ tty: true });
    p.begin("critics");
    out = [];
    p.info("  ✓ typography 71");
    expect(out.join("")).toMatch(/^\r\x1b\[2K {2}✓ typography 71\n\r\x1b\[2K[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] critics/);
  });

  it("cuts a live line to the width of the terminal", () => {
    const p = make({ tty: true, columns: 30 });
    p.setStatus("x".repeat(200));
    p.begin("critics");
    const live = out.filter((s) => s.startsWith("\r\x1b[2K") && !s.endsWith("\n")).at(-1)!;
    expect(live.length - "\r\x1b[2K".length).toBeLessThan(30);
  });

  it("counts the live clock in whole seconds, never in flickering milliseconds", () => {
    const p = make({ tty: true });
    p.begin("critics");
    vi.advanceTimersByTime(450);
    const live = out.filter((s) => s.startsWith("\r\x1b[2K") && !s.endsWith("\n")).at(-1)!;
    expect(live).toMatch(/critics\s+0:00$/);
  });

  it("treats a terminal that reports 0 columns as of unknown width, and cuts nothing", () => {
    const p = make({ tty: true, columns: 0 });
    p.setStatus("$0.00 so far");
    p.begin("stitch generate");
    const live = out.filter((s) => s.startsWith("\r\x1b[2K") && !s.endsWith("\n")).at(-1)!;
    expect(live).toMatch(/\$0\.00 so far$/);
  });

  it("colours only when asked", () => {
    const plain = make({ tty: true });
    plain.begin("a").done();
    expect(text()).not.toContain(ESC + "32m");
    out = [];
    const coloured = make({ tty: true, color: true });
    coloured.begin("a").done();
    expect(text()).toContain(ESC + "32m✓");
  });
});

describe("phase", () => {
  it("returns the result and summarises it", async () => {
    const p = make();
    await expect(p.phase("measure", async () => 1204, (n) => `${n} nodes`)).resolves.toBe(1204);
    expect(lines().at(-1)).toMatch(/✓ measure\s+\d+ms {2}1204 nodes$/);
  });

  it("closes as failed, keeps the first line of the error, and rethrows it", async () => {
    const p = make();
    await expect(p.phase("chair", async () => { throw new Error("overloaded\nrequest_id: abc"); })).rejects.toThrow("overloaded");
    expect(lines().at(-1)).toMatch(/✗ chair\s+\d+ms {2}overloaded$/);
  });

  it("is a plain pass-through when there is no reporter", async () => {
    await expect(noProgress.phase("x", async () => 7)).resolves.toBe(7);
    await expect(noProgress.phase("x", async () => { throw new Error("no"); })).rejects.toThrow("no");
  });
});

describe("modes", () => {
  it("quiet prints nothing at all", () => {
    const p = make({ mode: "quiet", tty: true });
    p.header(["h"]); p.banner("b"); p.info("i"); p.warn("w"); p.begin("s").done("d"); p.skipped("k", "why"); p.close();
    expect(out).toEqual([]);
  });

  it("debug lines appear only in verbose", () => {
    make().debug("tokens: 5 in");
    expect(out).toEqual([]);
    make({ mode: "verbose" }).debug("tokens: 5 in");
    expect(text()).toContain("tokens: 5 in");
  });
});

describe("lines", () => {
  it("banner draws a bar filled to the fraction", () => {
    make().banner("v01 · edit 1 of at most 4", { fraction: 0.25, status: "$0.41 so far" });
    expect(lines()[0]).toContain("── v01 · edit 1 of at most 4  ████░░░░░░░░░░░░  $0.41 so far ──");
  });

  it("banner clamps a fraction outside 0..1", () => {
    make().banner("a", { fraction: 5 });
    expect(text()).toContain("█".repeat(16));
    out = [];
    make().banner("a", { fraction: -1 });
    expect(text()).toContain("░".repeat(16));
  });

  it("skipped says why, and warn is marked", () => {
    const p = make();
    p.skipped("2/7 prompt cache", "the critic call did not succeed");
    p.warn("stitch generate failed");
    expect(lines()[0]).toMatch(/– 2\/7 prompt cache\s+skipped: the critic call did not succeed$/);
    expect(lines()[1]).toMatch(/! stitch generate failed$/);
  });

  it("ignores a second close of the same step", () => {
    const p = make();
    const s = p.begin("a");
    s.done("first");
    s.fail("second");
    expect(text().match(/✓|✗/g)).toHaveLength(1);
  });

  it("close says how long it all took, but only if something ran", () => {
    const idle = make();
    idle.close();
    expect(out).toEqual([]);
    const p = make();
    p.begin("a").done();
    vi.advanceTimersByTime(125_000);
    p.close();
    expect(lines().at(-1)).toMatch(/finished in 2:05$/);
  });

  it("formatStatus is the one place the live line is laid out", () => {
    expect(formatStatus({ frame: "⠋", label: "critics", elapsed: "0:03", status: "" })).toBe(`⠋ ${"critics".padEnd(24)}  0:03`);
  });
});

describe("the event log", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "dl-prog-")), "events.jsonl");
  const read = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

  it("writes what happened before it was attached, then everything after, one JSON object per line", () => {
    const f = file();
    const p = make();
    p.header(["run home"]);
    p.attachLog(f);
    const s = p.begin("stitch generate");
    vi.advanceTimersByTime(1_500);
    s.done("ok");
    p.warn("careful");
    const events = read(f);
    expect(events.map((e) => e.type)).toEqual(["header", "start", "done", "warn"]);
    expect(events[2]).toMatchObject({ label: "stitch generate", ms: 1500, detail: "ok" });
    expect(events[0].t).toMatch(/^2026-09-20T/);
  });

  it("is written in quiet mode too", () => {
    const f = file();
    const p = make({ mode: "quiet" });
    p.attachLog(f);
    p.begin("a").done();
    expect(read(f).map((e) => e.type)).toEqual(["start", "done"]);
    expect(out).toEqual([]);
  });

  it("a log that cannot be written never throws", () => {
    const p = make();
    p.attachLog("/nonexistent-dir-for-design-loop/events.jsonl");
    expect(() => { p.begin("a").done(); p.info("x"); }).not.toThrow();
  });
});

describe("committeeHooks", () => {
  it("warns on a retry, naming the critic and the reason", () => {
    const p = make();
    committeeHooks(p, false).onRetry!("layout" as never, "529 overloaded\nrequest_id: x");
    expect(lines()[0]).toMatch(/! layout critic failed, retrying once: 529 overloaded$/);
  });

  it("reports each critic as it finishes only when asked", () => {
    const p = make();
    const hooks = committeeHooks(p, true);
    hooks.onCritic!("typography", { ok: true, score: 71.4, ms: 12_000 });
    hooks.onCritic!("feasibility", { ok: false, error: "bad json", ms: 3_000 });
    expect(lines()[0]).toMatch(/ {2}✓ typography\s+71  0:12$/);
    expect(lines()[1]).toMatch(/ {2}✗ feasibility\s+dropped: bad json$/);
    expect(committeeHooks(p, false).onCritic).toBeUndefined();
  });
});

describe("promptLines", () => {
  const SHORT = "a simple mobile login screen";
  const LONG = `Conker\n\nA mobile voice-dubbing game.\n\nDesign tokens (use these exact values):\n{ "bg": "#0B0B0F" }`;

  it("shows a short prompt on one indented line, under the step it belongs to", () => {
    expect(promptLines("generate", SHORT, "normal")).toEqual([`  → generate: ${SHORT}`]);
    expect(promptLines("edit", "make the button larger", "normal")).toEqual(["  → edit: make the button larger"]);
  });

  it("keeps a long prompt to its first line, truncated, when not verbose", () => {
    const [line] = promptLines("generate", LONG, "normal");
    expect(line).toBe("  → generate: Conker");
    expect(promptLines("generate", "x".repeat(200), "normal")[0]!.length).toBeLessThan(160);
    expect(promptLines("generate", "x".repeat(200), "normal")[0]).toMatch(/…$/);
  });

  it("expands the whole prompt under --verbose, one call per line", () => {
    expect(promptLines("generate", LONG, "verbose")).toEqual([
      "  → generate:",
      "    Conker",
      "    ",
      "    A mobile voice-dubbing game.",
      "    ",
      "    Design tokens (use these exact values):",
      '    { "bg": "#0B0B0F" }',
    ]);
  });

  // Expanding a prompt that already fits would only add a line saying nothing.
  it("leaves a prompt that already fits on one line alone, even under --verbose", () => {
    expect(promptLines("generate", SHORT, "verbose")).toEqual([`  → generate: ${SHORT}`]);
  });

  // `info` suppresses these in quiet mode, but the JSONL event log records them either way, which is the
  // whole point of the log on a paid run.
  it("formats in quiet mode as it does in normal, and lets the reporter do the suppressing", () => {
    expect(promptLines("generate", SHORT, "quiet")).toEqual(promptLines("generate", SHORT, "normal"));
    const p = createProgress({ write: (x) => out.push(x), tty: false, mode: "quiet" });
    for (const line of promptLines("generate", SHORT, "quiet")) p.info(line);
    expect(out).toEqual([]);
  });
});
