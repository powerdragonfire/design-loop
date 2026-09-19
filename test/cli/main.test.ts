import { describe, it, expect, vi } from "vitest";
import { main, type Deps } from "../../src/cli/main.js";

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
  abDistiller: vi.fn(async () => ({ screens: [{ screen: "a", rawIssues: [], digestIssues: [], rawOnly: [{ critic: "typography", severity: "major", claim: "letter spacing" }] }], usd: 8 })),
  makeGenerator: vi.fn(() => ({ generate: vi.fn() }) as any),
  makeLlm: vi.fn(() => ({ critique: vi.fn() }) as any),
  makeChair: vi.fn(() => ({ synthesise: vi.fn() }) as any),
  committeePick: vi.fn(async () => "v01"),
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

  it("prints only the message, not a stack, for an ordinary error", async () => {
    const c = capture();
    const d = deps({ runScreen: vi.fn(async () => { throw new Error("Stitch quota too low"); }) });
    expect(await main(["run", "home"], c.io, d)).toBe(1);
    expect(c.err.join("\n")).toContain("Stitch quota too low");
    expect(c.err.join("\n")).not.toMatch(/\n\s+at /);
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

  it("ab-distiller prints the raw-only triage list", async () => {
    const c = capture();
    expect(await main(["ab-distiller"], c.io, deps())).toBe(0);
    expect(c.out.join("\n")).toContain("letter spacing");
  });
});
