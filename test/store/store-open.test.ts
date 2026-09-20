import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRun } from "../../src/store/store.js";
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
});
