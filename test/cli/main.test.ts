import { describe, it, expect, vi } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Deps } from "../../src/cli/main.js";
import { recordProgress } from "../helpers/recordProgress.js";

const capture = () => {
  const out: string[] = []; const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};
const RESULT = { stopReason: "pass" as const, versions: 2, best: "v01", runDir: "/tmp/runs/2026-09-18-home" };
const deps = (over: Partial<Deps> = {}): Partial<Deps> => ({
  runScreen: vi.fn(async () => RESULT),
  buildReport: vi.fn(async (d: string) => `${d}/report.html`),
  captureApproval: vi.fn(async () => {}),
  calibrate: vi.fn(async () => ({ sigma: 3.2, perCritic: { typography: 4 }, repeats: 5, screens: ["a"], usd: 2.1 })),
  smoke: vi.fn(async () => ({ steps: [{ name: "critic call", ok: true, detail: "typography returned score 82" }], usd: 0.12 })),
  abDistiller: vi.fn(async () => ({ screens: [{ screen: "a", rawIssues: [], digestIssues: [], rawOnly: [{ critic: "typography", severity: "major", claim: "letter spacing" }] }], usd: 8 })),
  makeGenerator: vi.fn(() => ({ generate: vi.fn() }) as any),
  makeLlm: vi.fn(() => ({ critique: vi.fn() }) as any),
  makeChair: vi.fn(() => ({ synthesise: vi.fn() }) as any),
  committeePick: vi.fn(async () => "v01"),
  candidateWinner: vi.fn(async () => undefined),
  preflight: vi.fn(async () => {}),
  openInBrowser: vi.fn(async () => {}),
  ask: vi.fn(async () => ""),
  now: () => new Date("2026-09-18T10:00:00Z"),
  ...over,
});

describe("main", () => {
  it("prints usage and exits 2 with no arguments", async () => {
    const c = capture();
    expect(await main([], c.io, deps())).toBe(2);
    expect(c.err.join("\n")).toMatch(/usage/i);
  });

  it("exits 2 on an unknown command", async () => {
    const c = capture();
    expect(await main(["dance"], c.io, deps())).toBe(2);
    expect(c.err.join("\n")).toContain("dance");
  });

  it("exits 2 when `run` has no screen", async () => {
    const c = capture();
    expect(await main(["run"], c.io, deps())).toBe(2);
  });

  it("runs a screen with the default design folder and today's date, then builds the report", async () => {
    const c = capture(); const d = deps();
    expect(await main(["run", "home"], c.io, d)).toBe(0);
    expect(d.runScreen).toHaveBeenCalledWith(expect.objectContaining({ designDir: "design", screen: "home", date: "2026-09-18" }));
    expect(d.buildReport).toHaveBeenCalledWith(RESULT.runDir);
    const text = c.out.join("\n");
    expect(text).toContain("pass");
    expect(text).toContain("v01");
    expect(text).toContain(`design-loop review ${RESULT.runDir}`);
  });

  it("honours --design and --date wherever they appear", async () => {
    const c = capture(); const d = deps();
    await main(["--design", "x/design", "run", "--date", "2026-01-02", "home"], c.io, d);
    expect(d.runScreen).toHaveBeenCalledWith(expect.objectContaining({ designDir: "x/design", date: "2026-01-02" }));
  });

  it("runs the preflight BEFORE building the Stitch client or spending anything", async () => {
    const c = capture();
    const order: string[] = [];
    const d = deps({
      preflight: vi.fn(async () => { order.push("preflight"); }),
      makeGenerator: vi.fn(() => { order.push("generator"); return {} as any; }),
      runScreen: vi.fn(async () => { order.push("run"); return RESULT; }),
    });
    await main(["run", "home"], c.io, d);
    expect(order).toEqual(["preflight", "generator", "run"]);
  });

  it("exits 1 naming the problem, and never runs, when the preflight fails", async () => {
    const c = capture();
    const d = deps({ preflight: vi.fn(async () => { throw new Error("Anthropic rejected the API key (401)"); }) });
    expect(await main(["run", "home"], c.io, d)).toBe(1);
    expect(c.err.join("\n")).toContain("Anthropic rejected the API key");
    expect(d.runScreen).not.toHaveBeenCalled();
  });

  it("exits 1 naming the variable when the Stitch client cannot be built", async () => {
    const c = capture();
    const d = deps({ makeGenerator: vi.fn(() => { throw new Error("STITCH_PROJECT_ID is not set"); }) });
    expect(await main(["run", "home"], c.io, d)).toBe(1);
    expect(c.err.join("\n")).toContain("STITCH_PROJECT_ID");
    expect(d.runScreen).not.toHaveBeenCalled();
  });

  it("exits 3 for an aborted run, so scripts can tell, and still prints its report", async () => {
    const c = capture();
    const d = deps({ runScreen: vi.fn(async () => ({ ...RESULT, stopReason: "aborted" as const, abortReason: "quota" })) });
    expect(await main(["run", "home"], c.io, d)).toBe(3);
    expect(c.out.join("\n")).toContain("quota");
    expect(d.buildReport).toHaveBeenCalled();
  });

  it("prints the summary before the report, so the run's outcome survives a failing report", async () => {
    const c = capture();
    const d = deps({ buildReport: vi.fn(async () => { throw new Error("EACCES report.html"); }) });
    expect(await main(["run", "home"], c.io, d)).toBe(0);
    expect(c.out.join("\n")).toContain("pass");
    expect(c.out.join("\n")).toContain("v01");
    expect(c.err.join("\n")).toContain("Report failed: EACCES report.html");
  });

  it("keeps an aborted run's exit 3 even when the report fails as well", async () => {
    const c = capture();
    const d = deps({
      runScreen: vi.fn(async () => ({ ...RESULT, stopReason: "aborted" as const, abortReason: "quota" })),
      buildReport: vi.fn(async () => { throw new Error("EACCES report.html"); }),
    });
    expect(await main(["run", "home"], c.io, d)).toBe(3);
    expect(c.out.join("\n")).toContain("quota");
  });

  it("orders the run summary ahead of the report line", async () => {
    const c = capture();
    await main(["run", "home"], c.io, deps());
    expect(c.out.findIndex(l => l.startsWith("Stop reason:"))).toBeLessThan(c.out.findIndex(l => l.startsWith("Report:")));
  });

  it("prints only the message, not a stack, for an ordinary error", async () => {
    const c = capture();
    const d = deps({ runScreen: vi.fn(async () => { throw new Error("Stitch quota too low"); }) });
    expect(await main(["run", "home"], c.io, d)).toBe(1);
    expect(c.err.join("\n")).toContain("Stitch quota too low");
    expect(c.err.join("\n")).not.toMatch(/\n\s+at /);
  });

  // A design folder in each mode. `run` must take the old path in "api" and the step path in "agent".
  const designIn = (criticMode: "api" | "agent") => {
    const dir = mkdtempSync(join(tmpdir(), "dl-mode-"));
    cpSync(new URL("../fixtures/design/", import.meta.url).pathname, dir, {
      recursive: true, filter: (src) => !src.includes(".design-loop"),
    });
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), criticMode }));
    return dir;
  };

  it("runs a screen through runScreen in api mode, never through a step", async () => {
    const d = deps({ stepRun: vi.fn() });
    expect(await main(["--design", designIn("api"), "run", "home"], capture().io, d)).toBe(0);
    expect(d.runScreen).toHaveBeenCalled();
    expect(d.stepRun).not.toHaveBeenCalled();
  });

  it("suspends `run` into the first step in agent mode, without an Anthropic preflight", async () => {
    const c = capture();
    const designDir = designIn("agent");
    const d = deps({
      stepRun: vi.fn(async () => ({ done: false as const, workOrder: "/r/v00/work-order.json", runDir: "/r" })),
    });
    expect(await main(["--design", designDir, "run", "--date", "2026-09-20", "home"], c.io, d)).toBe(10);
    expect(d.runScreen).not.toHaveBeenCalled();
    expect(d.stepRun).toHaveBeenCalledWith(expect.objectContaining({ designDir, screen: "home", date: "2026-09-20", runDir: undefined }));
    // The preflight authenticates a key an agent-mode run never uses; failing on it would block the mode.
    expect(d.preflight).not.toHaveBeenCalled();
    expect(c.out.join("\n")).toContain("/r/v00/work-order.json");
  });

  // The mode selector tolerates only a missing config.json. A real contract error must not fail open into
  // API mode, where the credential check would report a broken tokens.json as a rejected Anthropic key —
  // a key an agent-mode run has no reason to hold.
  it("reports a broken agent-mode contract as a contract error, not as bad credentials", async () => {
    const c = capture();
    const designDir = designIn("agent");
    writeFileSync(join(designDir, "tokens.json"), "{}");
    const d = deps({ stepRun: vi.fn() });
    expect(await main(["--design", designDir, "run", "home"], c.io, d)).toBe(1);
    expect(c.err.join("\n")).toContain("tokens.json defines no tokens");
    expect(d.preflight).not.toHaveBeenCalled();
    expect(d.runScreen).not.toHaveBeenCalled();
    expect(d.stepRun).not.toHaveBeenCalled();
  });

  it("exits 2 when `step` has no run directory", async () => {
    expect(await main(["step"], capture().io, deps())).toBe(2);
    expect(await main(["step", "/r", "extra"], capture().io, deps())).toBe(2);
  });

  it("exits 10 with the work order and the command to run next when a step suspends", async () => {
    const c = capture();
    const d = deps({
      runIdentity: vi.fn(async () => ({ screen: "home", date: "2026-09-20" })),
      stepRun: vi.fn(async () => ({ done: false as const, workOrder: "/r/v00/work-order.json", runDir: "/r" })),
    });
    expect(await main(["step", "/r"], c.io, d)).toBe(10);
    expect(d.stepRun).toHaveBeenCalledWith(expect.objectContaining({ runDir: "/r", screen: "home", date: "2026-09-20" }));
    const text = c.out.join("\n");
    expect(text).toContain("/r/v00/work-order.json");
    expect(text).toContain("design-loop step /r");
    expect(d.buildReport).not.toHaveBeenCalled();
  });

  it("exits 0 and reports when the stepped run has finished", async () => {
    const c = capture();
    const d = deps({
      runIdentity: vi.fn(async () => ({ screen: "home", date: "2026-09-20" })),
      stepRun: vi.fn(async () => ({ done: true as const, result: RESULT, runDir: RESULT.runDir })),
    });
    expect(await main(["step", RESULT.runDir], c.io, d)).toBe(0);
    expect(c.out.join("\n")).toContain("pass");
    expect(d.buildReport).toHaveBeenCalledWith(RESULT.runDir);
  });

  it("approves a version and says whether it agreed with the committee", async () => {
    const c = capture(); const d = deps();
    expect(await main(["approve", "/r", "v01"], c.io, d)).toBe(0);
    expect(d.captureApproval).toHaveBeenCalledWith("/r", "v01");
  });

  it("exits 1 when approving a version that does not exist", async () => {
    const c = capture();
    const d = deps({ captureApproval: vi.fn(async () => { throw new Error("no such version: v09"); }) });
    expect(await main(["approve", "/r", "v09"], c.io, d)).toBe(1);
    expect(c.err.join("\n")).toContain("no such version");
  });

  it("approves a candidate id and reports it against the candidate stage's pick", async () => {
    const c = capture();
    const d = deps({ candidateWinner: vi.fn(async () => "c1") });
    expect(await main(["approve", "/r", "c3"], c.io, d)).toBe(0);
    expect(d.captureApproval).toHaveBeenCalledWith("/r", "c3");
    expect(d.candidateWinner).toHaveBeenCalledWith("/r");
    expect(c.out.join("\n")).toContain("differs from (c1)");
    expect(c.out.join("\n")).toContain("committee's candidate pick");
    expect(d.committeePick).not.toHaveBeenCalled();
  });

  it("says a candidate agrees when it matches the candidate stage's own pick", async () => {
    const c = capture();
    const d = deps({ candidateWinner: vi.fn(async () => "c1") });
    await main(["approve", "/r", "c1"], c.io, d);
    expect(c.out.join("\n")).toContain("agrees with");
  });

  it("falls back to the committee's version pick for a candidate approval when the run predates the candidate stage", async () => {
    const c = capture();
    const d = deps({ candidateWinner: vi.fn(async () => undefined), committeePick: vi.fn(async () => "v01") });
    await main(["approve", "/r", "c0"], c.io, d);
    expect(c.out.join("\n")).toContain("differs from (v01)");
  });

  it("rejects an id that is neither a version nor a candidate, as a usage error", async () => {
    const c = capture();
    expect(await main(["approve", "/r", "banana"], c.io, deps())).toBe(2);
    expect(c.err.join("\n")).toMatch(/vNN or cN/);
  });

  it("builds and opens the report", async () => {
    const c = capture(); const d = deps();
    expect(await main(["report", "/r"], c.io, d)).toBe(0);
    expect(d.openInBrowser).toHaveBeenCalledWith("/r/report.html");
    expect(c.out.join("\n")).toContain("/r/report.html");
  });

  it("review: empty input accepts the committee's pick", async () => {
    const c = capture(); const d = deps({ ask: vi.fn(async () => "") });
    expect(await main(["review", "/r"], c.io, d)).toBe(0);
    expect(d.captureApproval).toHaveBeenCalledWith("/r", "v01");
  });

  it("review: a typed version overrides the pick, and q skips", async () => {
    const a = deps({ ask: vi.fn(async () => "v00") });
    await main(["review", "/r"], capture().io, a);
    expect(a.captureApproval).toHaveBeenCalledWith("/r", "v00");
    const b = deps({ ask: vi.fn(async () => "q") });
    await main(["review", "/r"], capture().io, b);
    expect(b.captureApproval).not.toHaveBeenCalled();
  });

  it("calibrate prints sigma and the cost", async () => {
    const c = capture(); const d = deps();
    expect(await main(["calibrate", "--repeats", "3"], c.io, d)).toBe(0);
    expect(d.calibrate).toHaveBeenCalledWith(expect.objectContaining({ designDir: "design", repeats: 3 }));
    expect(c.out.join("\n")).toMatch(/3\.2/);
    expect(c.out.join("\n")).toMatch(/\$2\.1/);
  });

  it("smoke runs the preflight, prints a line per step, and exits 0 when they all passed", async () => {
    const c = capture(); const d = deps();
    expect(await main(["smoke"], c.io, d)).toBe(0);
    expect(d.preflight).toHaveBeenCalled();
    expect(d.smoke).toHaveBeenCalledWith(expect.objectContaining({ designDir: "design" }));
    const text = c.out.join("\n");
    expect(text).toContain("PASS critic call");
    expect(text).toContain("typography returned score 82");
    expect(text).toContain("$0.12");
    expect(text).toMatch(/2 Stitch generations/);
  });

  it("smoke exits 1 on a failed step and marks a skipped one SKIP", async () => {
    const c = capture();
    const d = deps({ smoke: vi.fn(async () => ({
      steps: [
        { name: "stitch generate", ok: false, detail: "Stitch is unreachable" },
        { name: "stitch edit", ok: false, detail: "skipped: the generate step did not succeed" },
      ],
      usd: null,
    })) });
    expect(await main(["smoke"], c.io, d)).toBe(1);
    expect(c.out.join("\n")).toContain("FAIL stitch generate");
    expect(c.out.join("\n")).toContain("SKIP stitch edit");
  });

  it("smoke does not fail the command for a step that was only skipped", async () => {
    const d = deps({ smoke: vi.fn(async () => ({
      steps: [
        { name: "critic call", ok: true, detail: "fine" },
        { name: "prompt cache", ok: false, detail: "skipped: nothing to hit" },
      ],
      usd: 0,
    })) });
    expect(await main(["smoke"], capture().io, d)).toBe(0);
  });

  it("smoke takes no arguments, and honours --design", async () => {
    expect(await main(["smoke", "home"], capture().io, deps())).toBe(2);
    const d = deps();
    await main(["--design", "x/design", "smoke"], capture().io, d);
    expect(d.smoke).toHaveBeenCalledWith(expect.objectContaining({ designDir: "x/design" }));
  });

  it("ab-distiller prints the raw-only triage list", async () => {
    const c = capture();
    expect(await main(["ab-distiller"], c.io, deps())).toBe(0);
    expect(c.out.join("\n")).toContain("letter spacing");
  });
});

describe("progress wiring", () => {
  const withProgress = () => {
    const c = capture();
    const rec = recordProgress();
    const makeProgress = vi.fn((_mode: string) => rec.progress);
    return { ...rec, makeProgress, io: { ...c.io, makeProgress }, out: c.out, err: c.err };
  };

  it.each([
    [[], "normal"],
    [["--quiet"], "quiet"],
    [["--verbose"], "verbose"],
  ])("builds the reporter for %j in %s mode", async (flags, mode) => {
    const w = withProgress();
    await main([...flags, "smoke"], w.io, deps());
    expect(w.makeProgress).toHaveBeenCalledWith(mode);
  });

  it("refuses --quiet with --verbose, as a usage error", async () => {
    const w = withProgress();
    expect(await main(["--quiet", "--verbose", "smoke"], w.io, deps())).toBe(2);
    expect(w.err.join("\n")).toMatch(/--quiet and --verbose/);
    expect(w.makeProgress).not.toHaveBeenCalled();
  });

  it("hands the same reporter to run, smoke, calibrate and ab-distiller", async () => {
    const w = withProgress(); const d = deps();
    await main(["run", "home"], w.io, d);
    await main(["smoke"], w.io, d);
    await main(["calibrate"], w.io, d);
    await main(["ab-distiller"], w.io, d);
    for (const fn of [d.runScreen, d.smoke, d.calibrate, d.abDistiller]) {
      expect(fn).toHaveBeenCalledWith(expect.objectContaining({ progress: w.progress }));
    }
  });

  it("shows the credential check as its own step, before any spend", async () => {
    const w = withProgress();
    const order: string[] = [];
    const d = deps({
      preflight: vi.fn(async () => { order.push("preflight"); }),
      runScreen: vi.fn(async () => { order.push("run"); return RESULT; }),
    });
    await main(["run", "home"], w.io, d);
    expect(order).toEqual(["preflight", "run"]);
    expect(w.events.slice(0, 2)).toEqual(["begin check credentials", "done check credentials"]);
  });

  it("closes the reporter after a command, and after one that fails", async () => {
    const ok = withProgress();
    await main(["smoke"], ok.io, deps());
    expect(ok.events.at(-1)).toBe("close");
    const bad = withProgress();
    expect(await main(["run", "home"], bad.io, deps({ preflight: vi.fn(async () => { throw new Error("no key"); }) }))).toBe(1);
    expect(bad.events).toContain("fail check credentials: no key");
    expect(bad.events.at(-1)).toBe("close");
  });

  it("keeps progress off stdout: the results a script reads are exactly the ones printed before", async () => {
    const w = withProgress();
    await main(["run", "home"], w.io, deps());
    expect(w.out.join("\n")).toMatch(/^Stop reason: pass/m);
    expect(w.out.join("\n")).not.toMatch(/check credentials|begin |done /);
  });
});
