import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

  it("records which version a version was edited from", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 80));
    await run.writeVersion({ ...v(1, 60), parent: "v00" });
    expect(readFileSync(join(dir, "runs", R, "v01", "parent.txt"), "utf8")).toBe("v00");
    expect(existsSync(join(dir, "runs", R, "v00", "parent.txt"))).toBe(false);
  });

  it("rejects a parent that was never written", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await expect(run.writeVersion({ ...v(0, 80), parent: "v07" })).rejects.toThrow(/no such version/);
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

  it("records the chair changes that produced a version, and how many the chair asked for", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    const applied = [{
      id: "typography-001", severity: "major" as const, evidence: { selector: "#b1", observed: "12px" },
      claim: "too small", fix: "use 16px", effort: "low" as const,
    }];
    await run.writeVersion(v(0, 70));
    await run.writeVersion({ ...v(1, 80), parent: "v00", changes: { requested: 5, applied } });
    const file = join(dir, "runs", R, "v01", "changes.json");
    expect(read(file)).toEqual({
      requested: 5,
      applied: [{ id: "typography-001", severity: "major", effort: "low", claim: "too small", fix: "use 16px", selector: "#b1" }],
    });
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(read(file), null, 2)}\n`);
  });

  it("writes no changes.json for a version no chair edit produced, such as round 0", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70));
    expect(existsSync(join(dir, "runs", R, "v00", "changes.json"))).toBe(false);
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

  it("references in the manifest the calibration the run's noise floor came from", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70));
    const calibration = {
      sigma: 3, criticModel: "claude-sonnet-5",
      weights: { typography: 0.25 }, measuredAt: "2026-09-17T09:00:00.000Z",
    };
    await run.finalise(fin({ calibration }));
    expect(read(join(dir, "runs", R, "manifest.json")).calibration).toEqual(calibration);
  });

  it("records that no calibration was found, rather than leaving the field out", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70));
    await run.finalise(fin({ calibration: null }));
    const m = read(join(dir, "runs", R, "manifest.json"));
    expect(Object.hasOwn(m, "calibration")).toBe(true);
    expect(m.calibration).toBeNull();
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

  const doc = { viewport: { w: 393, h: 852 }, nodes: [] };
  const critiques: never[] = [];

  it("writes a candidate directory with its critiques and prompt", async () => {
    const run = await openRun(dir, "home", "2026-09-20");
    const name = await run.writeCandidate({ id: "c0", family: 0, png: Buffer.from("p"), html: "<p/>", doc, critiques, composite: 80, gatePass: false, prompt: "P", openIssues: [] });
    expect(name).toBe("c0");
    expect(await readFile(join(run.dir, "candidates/c0/prompt.txt"), "utf8")).toBe("P");
    expect(await readFile(join(run.dir, "candidates/c0/family.txt"), "utf8")).toBe("0");
  });

  it("promotes a candidate to v00 by copying it, leaving the candidate in place", async () => {
    const run = await openRun(dir, "home", "2026-09-20");
    await run.writeCandidate({ id: "c1", family: 0, png: Buffer.from("png-bytes"), html: "<p/>", doc, critiques, composite: 80, gatePass: true, prompt: "P", openIssues: [] });
    expect(await run.promoteCandidate("c1")).toBe("v00");
    expect(await readFile(join(run.dir, "v00/screen.png"))).toEqual(Buffer.from("png-bytes"));
    expect(await readFile(join(run.dir, "candidates/c1/screen.png"))).toEqual(Buffer.from("png-bytes"));
  });

  it("approves a candidate id as readily as a version id", async () => {
    const run = await openRun(dir, "home", "2026-09-20");
    await run.writeCandidate({ id: "c2", family: 1, png: Buffer.from("p"), html: "<p/>", doc, critiques, composite: 80, gatePass: false, prompt: "P", openIssues: [] });
    await run.approve("c2");
    expect(JSON.parse(await readFile(join(run.dir, "candidates/c2/approved.json"), "utf8")).approved).toBe("c2");
  });

  it("refuses an id that could escape the run directory", async () => {
    const run = await openRun(dir, "home", "2026-09-20");
    await expect(run.promoteCandidate("../escape")).rejects.toThrow(/becomes part of a directory name/);
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

  it("ignores a stray version directory when a manifest says which versions the run has", async () => {
    const first = await openRun(dir, "home", "2026-09-18");
    await first.writeVersion(v(0, 70)); await first.writeVersion(v(1, 90));
    await first.finalise(fin({ committeeRank: ["v01", "v00"] }));
    // What a crash mid-writeVersion, or a report built during a live run, leaves behind.
    mkdirSync(join(first.dir, "v02"));
    writeFileSync(join(first.dir, "v02", "screen.png"), "png");
    const later = await openExistingRun(first.dir);
    await later.approve("v01");
    expect(read(join(first.dir, "manifest.json")).humanPick).toBe("v01");
  });

  it("skips a version with no composite.json when there is no manifest to trust", async () => {
    const first = await openRun(dir, "home", "2026-09-18");
    await first.writeVersion(v(0, 70));
    mkdirSync(join(first.dir, "v01"));
    const later = await openExistingRun(first.dir);
    await later.finalise(fin({ committeeRank: ["v00"] }));
    expect(read(join(first.dir, "manifest.json")).versions.map((s: { version: string }) => s.version)).toEqual(["v00"]);
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
