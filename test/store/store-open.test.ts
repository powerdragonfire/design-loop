import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExistingRun, openRun, runIdentity } from "../../src/store/store.js";
import type { Critique, Issue, MeasuredDoc } from "../../src/types.js";

const doc: MeasuredDoc = { viewport: { w: 390, h: 844 }, nodes: [] };
const issue = (id: string): Issue =>
  ({ id, severity: "major", evidence: { selector: "#b1", observed: "o" }, claim: "c", fix: "f", effort: "low" });
const critique = (): Critique =>
  ({ critic: "typography", score: 70, issues: [], resolved: { claimed: [], verified: [] } });

const newRun = async () => openRun(mkdtempSync(join(tmpdir(), "dl-store-")), "home", "2026-09-20");

describe("openVersion", () => {
  it("claims the directory and writes the committee's inputs before any critique exists", async () => {
    const run = await newRun();
    const v = await run.openVersion(0);
    expect(v.version).toBe("v00");
    await v.writeGenerated({ png: Buffer.from("p"), html: "<html></html>", doc, prompt: "make it", screenId: "sc-1", parent: null });
    await v.writeCommitteeInputs({ digest: "viewport: 390x844", carriedIssues: [issue("typography-001")], measurements: [issue("det-001")] });

    expect(readFileSync(join(v.dir, "screen-id.txt"), "utf8")).toBe("sc-1");
    expect(readFileSync(join(v.dir, "digest.txt"), "utf8")).toBe("viewport: 390x844");
    expect(JSON.parse(readFileSync(join(v.dir, "carried-issues.json"), "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(v.dir, "measurements.json"), "utf8"))[0].id).toBe("det-001");
    expect(existsSync(join(v.dir, "composite.json"))).toBe(false);
  });

  it("refuses to claim a version twice", async () => {
    const run = await newRun();
    await run.openVersion(0);
    await expect(run.openVersion(0)).rejects.toThrow(/version v00 already exists/);
  });

  it("finish writes the scored half", async () => {
    const run = await newRun();
    const v = await run.openVersion(0);
    await v.writeGenerated({ png: Buffer.from("p"), html: "<html></html>", doc, prompt: "make it", screenId: "sc-1", parent: null });
    await v.finish({ critiques: [critique()], composite: 70, gatePass: false, openIssues: [issue("typography-001")] });
    expect(JSON.parse(readFileSync(join(v.dir, "composite.json"), "utf8"))).toEqual({ composite: 70, gatePass: false });
    expect(existsSync(join(v.dir, "critiques", "typography.json"))).toBe(true);
  });
});

describe("writeVersion still works as before", () => {
  it("produces the same files in one call", async () => {
    const run = await newRun();
    const version = await run.writeVersion({
      index: 0, png: Buffer.from("p"), html: "<html></html>", doc, critiques: [critique()],
      composite: 70, gatePass: false, prompt: "make it", openIssues: [], parent: null,
    });
    expect(version).toBe("v00");
    expect(existsSync(join(run.dir, "v00", "composite.json"))).toBe(true);
    expect(existsSync(join(run.dir, "v00", "screen.png"))).toBe(true);
  });

  it("passes the committee inputs through to the version directory", async () => {
    const run = await newRun();
    await run.writeVersion({
      index: 0, png: Buffer.from("p"), html: "<html></html>", doc, critiques: [critique()],
      composite: 70, gatePass: false, prompt: "make it", openIssues: [], parent: null,
      screenId: "sc-1", digest: "viewport: 390x844",
      carriedIssues: [issue("typography-001")], measurements: [issue("det-001")],
    });
    const base = join(run.dir, "v00");
    expect(readFileSync(join(base, "screen-id.txt"), "utf8")).toBe("sc-1");
    expect(readFileSync(join(base, "digest.txt"), "utf8")).toBe("viewport: 390x844");
    expect(JSON.parse(readFileSync(join(base, "carried-issues.json"), "utf8"))[0].id).toBe("typography-001");
    expect(JSON.parse(readFileSync(join(base, "measurements.json"), "utf8"))[0].id).toBe("det-001");
  });

  it("writes no digest.txt when digest is omitted, even with critiques present", async () => {
    const run = await newRun();
    await run.writeVersion({
      index: 0, png: Buffer.from("p"), html: "<html></html>", doc, critiques: [critique()],
      composite: 70, gatePass: false, prompt: "make it", openIssues: [], parent: null,
    });
    expect(existsSync(join(run.dir, "v00", "digest.txt"))).toBe(false);
  });
});

describe("reopenVersion", () => {
  // The suspend state of an agent-mode run: the directory is claimed and everything a critic reads is in it,
  // but nothing has scored it yet. `openVersion` refuses it by design; this is how a later step gets back in.
  const suspended = async () => {
    const run = await newRun();
    const first = await run.openVersion(0);
    await first.writeGenerated({ png: Buffer.from("p"), html: "<html></html>", doc, prompt: "make it", screenId: "sc-1" });
    await first.writeCommitteeInputs({ digest: "d", carriedIssues: [], measurements: [] });
    return run;
  };
  const scored = { critiques: [critique()], composite: 70, gatePass: false, openIssues: [] };

  it("adopts a claimed-but-unscored directory that openVersion refuses", async () => {
    const run = await suspended();
    await expect(run.openVersion(0)).rejects.toThrow(/version v00 already exists/);

    const again = await run.reopenVersion(0);
    expect(again.version).toBe("v00");
    expect(again.dir).toBe(join(run.dir, "v00"));
    await again.finish(scored);
    expect(existsSync(join(run.dir, "v00", "composite.json"))).toBe(true);
  });

  it("refuses a version nobody claimed: there is nothing to adopt", async () => {
    const run = await newRun();
    await expect(run.reopenVersion(0)).rejects.toThrow(/no such version v00 to reopen/);
  });

  it("refuses a version that is already scored, so a past score cannot be rewritten", async () => {
    const run = await suspended();
    await (await run.reopenVersion(0)).finish(scored);
    await expect(run.reopenVersion(0)).rejects.toThrow(/already scored/);
  });

  it("refuses a finalised run, exactly as openVersion does", async () => {
    const run = await suspended();
    await (await run.reopenVersion(0)).finish(scored);
    await run.finalise({
      stopReason: "pass", committeeRank: ["v00"], hallucinationRate: {}, degradations: [], sigma: 3,
      spend: { stitchGenerations: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: 0, criticMode: "api" },
    });
    await expect(run.reopenVersion(1)).rejects.toThrow(/the run is finalised/);
  });
});

describe("runIdentity", () => {
  it("reads the screen and date from the manifest when there is one", async () => {
    const run = await newRun();
    await run.writeVersion({
      index: 0, png: Buffer.from("p"), html: "<html></html>", doc, critiques: [critique()],
      composite: 70, gatePass: false, prompt: "p", openIssues: [],
    });
    await run.finalise({
      stopReason: "pass", committeeRank: ["v00"], hallucinationRate: {}, degradations: [], sigma: 3,
      spend: { stitchGenerations: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: 0, criticMode: "api" },
    });
    expect(await runIdentity(run.dir)).toEqual({ screen: "home", date: "2026-09-20" });
  });

  it("falls back to the directory's name, collision suffix and all, for a run still in flight", async () => {
    const designDir = mkdtempSync(join(tmpdir(), "dl-ident-"));
    const first = await openRun(designDir, "home", "2026-09-20");
    const second = await openRun(designDir, "home", "2026-09-20");
    expect(second.dir).toBe(`${first.dir}-2`);
    // No manifest yet: both are answered from the name, and the `-2` is not read as part of the screen.
    expect(await runIdentity(first.dir)).toEqual({ screen: "home", date: "2026-09-20" });
    expect(await runIdentity(second.dir)).toEqual({ screen: "home", date: "2026-09-20" });
  });

  it("answers for a run directory that holds no version at all, where openExistingRun refuses", async () => {
    const run = await openRun(mkdtempSync(join(tmpdir(), "dl-ident-")), "checkout", "2026-01-02");
    await expect(openExistingRun(run.dir)).rejects.toThrow(/no version directory/);
    expect(await runIdentity(run.dir)).toEqual({ screen: "checkout", date: "2026-01-02" });
  });
});
