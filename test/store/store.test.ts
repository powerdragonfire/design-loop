import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRun, openExistingRun } from "../../src/store/store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dl-")); });

const R = "2026-09-18-home";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const v = (index: number, composite: number, gatePass = false) => ({
  index, png: Buffer.from("png"), html: "<p>h</p>",
  doc: { viewport: { w: 393, h: 852 }, nodes: [] },
  critiques: [], composite, gatePass, prompt: `P${index}`, openIssues: [],
});
const spend = { stitchGenerations: 3, inputTokens: 1, outputTokens: 1, cachedTokens: 0, usd: 0.58 };
const fin = (over: Record<string, unknown> = {}) => ({
  stopReason: "converged" as const, committeeRank: ["v00"], spend,
  hallucinationRate: {}, degradations: [], sigma: 3, ...over,
});

describe("store", () => {
  it("writes each version into its own zero-padded directory, with its prompt and open issues", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    expect(await run.writeVersion(v(0, 70))).toBe("v00");
    const base = join(dir, "runs", R, "v00");
    for (const f of ["screen.png", "screen.html", "digest.json", "composite.json", "prompt.txt", "open-issues.json"])
      expect(existsSync(join(base, f))).toBe(true);
    expect(readFileSync(join(base, "prompt.txt"), "utf8")).toBe("P0");
    expect(read(join(base, "composite.json"))).toEqual({ composite: 70, gatePass: false });
  });

  it("writes one file per critique", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    const c = { critic: "typography" as const, score: 70, issues: [], resolved: { claimed: [], verified: [] } };
    await run.writeVersion({ ...v(0, 70), critiques: [c] });
    expect(read(join(dir, "runs", R, "v00", "critiques", "typography.json")).score).toBe(70);
  });

  it("retains a regressed version rather than overwriting the best", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 80));
    await run.writeVersion(v(1, 60));
    expect(existsSync(join(dir, "runs", R, "v01"))).toBe(true);
    expect(read(join(dir, "runs", R, "v00", "composite.json")).composite).toBe(80);
  });

  it("refuses to overwrite a version that already exists", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 80));
    await expect(run.writeVersion(v(0, 10))).rejects.toThrow(/already exists/);
    expect(read(join(dir, "runs", R, "v00", "composite.json")).composite).toBe(80);
  });

  it("never reuses a run directory: a second run of the same screen on the same day gets its own", async () => {
    const a = await openRun(dir, "home", "2026-09-18");
    const b = await openRun(dir, "home", "2026-09-18");
    expect(a.dir.endsWith(R)).toBe(true);
    expect(b.dir.endsWith(`${R}-2`)).toBe(true);
    expect(existsSync(a.dir) && existsSync(b.dir)).toBe(true);
  });

  it("records the stop reason, spend, sigma, versions, degradations and hallucination rates in the manifest", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70)); await run.writeVersion(v(1, 85, true));
    const degradations = [{ version: "v01", critic: "feasibility", error: "HTTP 400" }];
    await run.finalise(fin({ stopReason: "pass", committeeRank: ["v01", "v00"], hallucinationRate: { typography: 0.1 }, degradations }));
    const m = read(join(dir, "runs", R, "manifest.json"));
    expect(m.stopReason).toBe("pass");
    expect(m.spend.usd).toBe(0.58);
    expect(m.sigma).toBe(3);
    expect(m.best).toBe("v01");
    expect(m.hallucinationRate).toEqual({ typography: 0.1 });
    expect(m.degradations).toEqual(degradations);
    expect(m.versions).toEqual([{ version: "v00", composite: 70, gatePass: false }, { version: "v01", composite: 85, gatePass: true }]);
  });

  it("records agreement when the human picks the committee's top", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70)); await run.writeVersion(v(1, 90));
    await run.finalise(fin({ committeeRank: ["v01", "v00"] }));
    await run.approve("v01");
    const m = read(join(dir, "runs", R, "manifest.json"));
    expect(m.humanPick).toBe("v01");
    expect(m.agreedWithTop).toBe(true);
    expect(existsSync(join(dir, "runs", R, "v01", "approved.json"))).toBe(true);
  });

  it("records disagreement when the human picks anything else", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70)); await run.writeVersion(v(1, 90));
    await run.finalise(fin({ committeeRank: ["v01", "v00"] }));
    await run.approve("v00");
    expect(read(join(dir, "runs", R, "manifest.json")).agreedWithTop).toBe(false);
  });

  it("refuses to approve a version that was never written", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70));
    await run.finalise(fin({ stopReason: "budget" }));
    await expect(run.approve("v09")).rejects.toThrow(/no such version/);
  });

  it("refuses to approve before the run is finalised", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70));
    await expect(run.approve("v00")).rejects.toThrow(/not finalised/);
  });

  it("moves the approval when the human changes their mind: exactly one approved.json remains", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70)); await run.writeVersion(v(1, 90));
    await run.finalise(fin({ committeeRank: ["v01", "v00"] }));
    await run.approve("v00");
    await run.approve("v01");
    expect(existsSync(join(dir, "runs", R, "v00", "approved.json"))).toBe(false);
    expect(existsSync(join(dir, "runs", R, "v01", "approved.json"))).toBe(true);
    expect(read(join(dir, "runs", R, "manifest.json")).humanPick).toBe("v01");
  });

  it("finalises an aborted run, keeping every version and recording why it stopped", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70));
    await run.finalise(fin({ stopReason: "aborted", abortReason: "Stitch quota exhausted" }));
    const m = read(join(dir, "runs", R, "manifest.json"));
    expect(m.stopReason).toBe("aborted");
    expect(m.abortReason).toBe("Stitch quota exhausted");
    expect(m.best).toBe("v00");
  });
});

describe("openExistingRun", () => {
  it("rebuilds a finalised run from disk so a LATER process can approve it", async () => {
    const first = await openRun(dir, "home", "2026-09-18");
    await first.writeVersion(v(0, 70)); await first.writeVersion(v(1, 90));
    await first.finalise(fin({ committeeRank: ["v01", "v00"] }));
    const later = await openExistingRun(first.dir);
    await later.approve("v01");
    const m = read(join(first.dir, "manifest.json"));
    expect(m.humanPick).toBe("v01");
    expect(m.agreedWithTop).toBe(true);
    expect(m.versions).toHaveLength(2);
    expect(existsSync(join(first.dir, "v01", "approved.json"))).toBe(true);
  });

  it("moves an earlier approval when a reopened run is approved again", async () => {
    const first = await openRun(dir, "home", "2026-09-18");
    await first.writeVersion(v(0, 70)); await first.writeVersion(v(1, 90));
    await first.finalise(fin({ committeeRank: ["v01", "v00"] }));
    await first.approve("v00");
    await (await openExistingRun(first.dir)).approve("v01");
    expect(existsSync(join(first.dir, "v00", "approved.json"))).toBe(false);
    expect(read(join(first.dir, "manifest.json")).humanPick).toBe("v01");
  });

  it("refuses a directory that is not a run", async () => {
    await expect(openExistingRun(join(dir, "nope"))).rejects.toThrow(/no such run/);
  });

  it("reopens an unfinalised run but cannot approve it", async () => {
    const first = await openRun(dir, "home", "2026-09-18");
    await first.writeVersion(v(0, 70));
    const later = await openExistingRun(first.dir);
    await expect(later.approve("v00")).rejects.toThrow(/not finalised/);
  });
});
