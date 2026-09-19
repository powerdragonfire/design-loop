import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRun, openExistingRun } from "../../src/store/store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dl-")); });

const R = "2026-09-18-home";
const v = (index: number, composite = 70) => ({
  index, png: Buffer.from("png"), html: "<p>h</p>",
  doc: { viewport: { w: 393, h: 852 }, nodes: [] },
  critiques: [], composite, gatePass: false, prompt: `P${index}`, openIssues: [],
});
const spend = { stitchGenerations: 3, inputTokens: 1, outputTokens: 1, cachedTokens: 0, usd: 0.58 };
const fin = (over: Record<string, unknown> = {}) => ({
  stopReason: "converged" as const, committeeRank: ["v00"], spend,
  hallucinationRate: {}, degradations: [], sigma: 3, ...over,
});

describe("store edges", () => {
  it("writes JSON 2-space indented with a trailing newline, and the prompt raw", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion({ ...v(0), prompt: "  make it bolder\n\n" });
    const base = join(dir, "runs", R, "v00");
    expect(readFileSync(join(base, "composite.json"), "utf8")).toBe('{\n  "composite": 70,\n  "gatePass": false\n}\n');
    expect(readFileSync(join(base, "open-issues.json"), "utf8")).toBe("[]\n");
    expect(readFileSync(join(base, "prompt.txt"), "utf8")).toBe("  make it bolder\n\n");
    expect(readFileSync(join(base, "screen.html"), "utf8")).toBe("<p>h</p>");
    expect(readFileSync(join(base, "screen.png"))).toEqual(Buffer.from("png"));
  });

  it("writes the digest and the open issues it was given", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    const issue = {
      id: "t1", severity: "major" as const, evidence: { selector: "h1", observed: "12px" },
      claim: "too small", fix: "16px", effort: "low" as const,
    };
    await run.writeVersion({ ...v(0), openIssues: [issue] });
    const base = join(dir, "runs", R, "v00");
    expect(JSON.parse(readFileSync(join(base, "open-issues.json"), "utf8"))).toEqual([issue]);
    expect(JSON.parse(readFileSync(join(base, "digest.json"), "utf8"))).toEqual(v(0).doc);
  });

  it("rejects a version index outside 0..99 or non-integer, and writes nothing", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    for (const bad of [-1, 100, 1.5, NaN, Infinity])
      await expect(run.writeVersion(v(bad))).rejects.toThrow(/version index/);
    expect(readdirSync(run.dir)).toEqual([]);
    expect(await run.writeVersion(v(99))).toBe("v99");
  });

  it("does not write two critiques of the same critic over each other", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    const c = { critic: "typography" as const, score: 70, issues: [], resolved: { claimed: [], verified: [] } };
    await expect(run.writeVersion({ ...v(0), critiques: [c, { ...c, score: 10 }] })).rejects.toThrow(/duplicate critique/);
  });

  it("does not mutate what the caller passed in", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    const version = v(0);
    const frozen = structuredClone({ ...version, png: undefined });
    await run.writeVersion(version);
    const f = fin({ committeeRank: ["v00"], degradations: [{ version: "v00", critic: "a", error: "b" }] });
    const before = structuredClone(f);
    await run.finalise(f as never);
    await run.approve("v00");
    expect({ ...version, png: undefined }).toEqual(frozen);
    expect(f).toEqual(before);
  });

  it("does not let a later change to the caller's objects reach the manifest", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0));
    const s = { ...spend };
    const rank = ["v00"];
    await run.finalise(fin({ spend: s, committeeRank: rank }));
    s.usd = 999; rank[0] = "v77";
    await run.approve("v00");
    const m = JSON.parse(readFileSync(join(dir, "runs", R, "manifest.json"), "utf8"));
    expect(m.spend.usd).toBe(0.58);
    expect(m.agreedWithTop).toBe(true);
  });

  it("records screen and date, and leaves no temp files behind", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0));
    await run.finalise(fin());
    await run.approve("v00");
    const m = JSON.parse(readFileSync(join(dir, "runs", R, "manifest.json"), "utf8"));
    expect(m).toMatchObject({ screen: "home", date: "2026-09-18", committeeRank: ["v00"], best: "v00" });
    expect(readdirSync(run.dir).sort()).toEqual(["manifest.json", "v00"]);
    expect(readdirSync(join(run.dir, "v00")).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("refuses a committee rank that is empty or names a version that was never written", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0));
    await expect(run.finalise(fin({ committeeRank: [] }))).rejects.toThrow(/committeeRank/);
    await expect(run.finalise(fin({ committeeRank: ["v05"] }))).rejects.toThrow(/no such version/);
    expect(existsSync(join(run.dir, "manifest.json"))).toBe(false);
  });

  it("refuses to finalise twice, or to add a version after finalising", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0));
    await run.finalise(fin());
    await expect(run.finalise(fin())).rejects.toThrow(/already finalised/);
    await expect(run.writeVersion(v(1))).rejects.toThrow(/finalised/);
    expect(existsSync(join(run.dir, "v01"))).toBe(false);
  });

  it("refuses a screen or date that would leave the runs directory", async () => {
    for (const bad of ["", ".", "..", "a/b", "..\\x", "a\0b"]) {
      await expect(openRun(dir, bad, "2026-09-18")).rejects.toThrow(/screen/);
      await expect(openRun(dir, "home", bad)).rejects.toThrow(/date/);
    }
    expect(existsSync(join(dir, "runs"))).toBe(false);
  });

  it("claims -2, -3 in turn, and two concurrent openRuns never share a directory", async () => {
    const runs = await Promise.all([1, 2, 3, 4].map(() => openRun(dir, "home", "2026-09-18")));
    expect(new Set(runs.map((r) => r.dir)).size).toBe(4);
    expect(readdirSync(join(dir, "runs")).sort()).toEqual([R, `${R}-2`, `${R}-3`, `${R}-4`]);
  });

  it("keeps aborted runs reviewable: no abortReason key on a normal finalise, and the run can still be approved", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0)); await run.writeVersion(v(1, 80));
    await run.finalise(fin({ stopReason: "aborted", abortReason: "quota", committeeRank: ["v01", "v00"] }));
    await run.approve("v00");
    const m = JSON.parse(readFileSync(join(dir, "runs", R, "manifest.json"), "utf8"));
    expect(m).toMatchObject({ stopReason: "aborted", abortReason: "quota", best: "v01", humanPick: "v00", agreedWithTop: false });
    const other = await openRun(dir, "other", "2026-09-18");
    await other.writeVersion(v(0));
    await other.finalise(fin());
    expect("abortReason" in JSON.parse(readFileSync(join(other.dir, "manifest.json"), "utf8"))).toBe(false);
  });

  it("a reopened finalised run keeps its manifest fields and refuses to write, re-finalise, or overwrite", async () => {
    const first = await openRun(dir, "home", "2026-09-18");
    await first.writeVersion(v(0, 70)); await first.writeVersion(v(1, 90));
    await first.finalise(fin({ committeeRank: ["v01", "v00"], degradations: [{ version: "v01", critic: "a", error: "b" }] }));
    const later = await openExistingRun(first.dir);
    expect(later.dir).toBe(first.dir);
    await expect(later.writeVersion(v(2))).rejects.toThrow(/finalised/);
    await expect(later.finalise(fin())).rejects.toThrow(/already finalised/);
    await later.approve("v00");
    await expect(later.approve("v09")).rejects.toThrow(/no such version/);
    const m = JSON.parse(readFileSync(join(first.dir, "manifest.json"), "utf8"));
    expect(m).toMatchObject({
      screen: "home", date: "2026-09-18", best: "v01", sigma: 3, humanPick: "v00", agreedWithTop: false,
      degradations: [{ version: "v01", critic: "a", error: "b" }],
    });
  });

  it("a reopened unfinalised run refuses to overwrite a version, can add the next, and can then be finalised", async () => {
    const first = await openRun(dir, "home", "2026-09-18");
    await first.writeVersion(v(0, 70));
    const later = await openExistingRun(first.dir);
    await expect(later.writeVersion(v(0, 10))).rejects.toThrow(/already exists/);
    expect(await later.writeVersion(v(1, 85))).toBe("v01");
    await later.finalise(fin({ committeeRank: ["v01", "v00"] }));
    const m = JSON.parse(readFileSync(join(first.dir, "manifest.json"), "utf8"));
    expect(m).toMatchObject({ screen: "home", date: "2026-09-18", best: "v01" });
    expect(m.versions).toEqual([{ version: "v00", composite: 70, gatePass: false }, { version: "v01", composite: 85, gatePass: false }]);
  });

  it("refuses a directory with no version in it, and a run whose manifest or composite is unreadable", async () => {
    const empty = await openRun(dir, "home", "2026-09-18");
    await expect(openExistingRun(empty.dir)).rejects.toThrow(/no such run/);
    const bad = await openRun(dir, "bad", "2026-09-18");
    await bad.writeVersion(v(0));
    await writeFile(join(bad.dir, "v00", "composite.json"), "{nope");
    await expect(openExistingRun(bad.dir)).rejects.toThrow(/composite\.json/);
  });
});
