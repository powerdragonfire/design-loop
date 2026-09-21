import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listVersions,
  resumingGenerator,
  resumingMeasure,
  resumingRun,
  versionName,
  type RoundCursor,
} from "../../src/cli/resume.js";
import { runScreen } from "../../src/cli/run.js";
import { FakeGenerator, StitchGenerator, type Generator, type Screen } from "../../src/stitch/adapter.js";
import { readQuota } from "../../src/stitch/quota.js";
import { openExistingRun, openRun } from "../../src/store/store.js";
import type { LlmClient } from "../../src/critics/llm.js";
import type { ChairClient } from "../../src/chair/chair.js";
import type { Critique, MeasuredDoc } from "../../src/types.js";

const doc = (n: number): MeasuredDoc => ({ viewport: { w: 390, h: 844 }, nodes: Array(n).fill(null).map(() => ({
  selector: "#b1", tag: "button", role: null, text: "Go", bbox: { x: 0, y: 0, w: 48, h: 48 }, style: {},
})) });

const html = (n: number) => `<html><body>${n}</body></html>`;
const shot = (n: number) => ({ html: html(n), png: Buffer.from(`png${n}`) });

const seed = (versions: { html: string; png: Buffer; doc: MeasuredDoc; screenId: string }[]) => {
  const dir = mkdtempSync(join(tmpdir(), "dl-resume-"));
  versions.forEach((v, i) => {
    const base = join(dir, versionName(i));
    mkdirSync(base);
    writeFileSync(join(base, "screen.html"), v.html);
    writeFileSync(join(base, "screen.png"), v.png);
    writeFileSync(join(base, "digest.json"), JSON.stringify(v.doc));
    writeFileSync(join(base, "screen-id.txt"), v.screenId);
    writeFileSync(join(base, "composite.json"), JSON.stringify({ composite: 70, gatePass: false }));
  });
  return dir;
};

describe("resumingGenerator", () => {
  it("returns the stored screen without calling the inner generator", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(1), screenId: "fake-0" }]);
    const inner = new FakeGenerator([shot(0), shot(1)]);
    const cursor: RoundCursor = { index: -1 };
    const gen = resumingGenerator({ runDir, inner, cursor });

    const screen = await gen.generate("first prompt");
    expect(inner.prompts).toEqual([]);          // no Stitch call, no quota
    expect(cursor.index).toBe(0);
    expect(await screen.getHtml()).toBe(html(0)); // read from disk, not the handle
  });

  it("falls through to the inner generator for a round not yet on disk", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(1), screenId: "fake-0" }]);
    const inner = new FakeGenerator([shot(0), shot(1)]);
    const cursor: RoundCursor = { index: -1 };
    const gen = resumingGenerator({ runDir, inner, cursor });

    const v00 = await gen.generate("first prompt");
    const v01 = await v00.edit("second prompt");
    expect(inner.prompts).toEqual(["second prompt"]);
    expect(cursor.index).toBe(1);
    expect(await v01.getHtml()).toBe(html(1));
  });

  it("reads the PNG from disk too: a rebuilt handle cannot download one", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(1), screenId: "fake-0" }]);
    const cursor: RoundCursor = { index: -1 };
    // fromId returns a handle whose downloads throw, exactly as a Stitch handle rebuilt from an id does.
    const refusing: Generator = {
      generate: async () => { throw new Error("generate must not be called"); },
      fromId: (id) => ({
        id,
        edit: async () => { throw new Error("edit must not be called"); },
        getHtml: async () => { throw new Error("screen was rebuilt from an id"); },
        getImage: async () => { throw new Error("screen was rebuilt from an id"); },
      }),
    };
    const screen = await resumingGenerator({ runDir, inner: refusing, cursor }).generate("first prompt");
    expect(await screen.getHtml()).toBe(html(0));
    expect((await screen.getImage()).toString()).toBe("png0");
    expect(screen.id).toBe("fake-0");
  });

  it("makes no Stitch call and reserves no quota for a replayed round", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(1), screenId: "sc-1" }]);
    const quotaDir = mkdtempSync(join(tmpdir(), "dl-quota-"));
    let generates = 0;
    const inner = new StitchGenerator({
      project: { generate: async () => { generates++; throw new Error("Stitch was called"); } },
      projectId: "proj-1",
      quotaDir,
    });
    const cursor: RoundCursor = { index: -1 };

    const screen = await resumingGenerator({ runDir, inner, cursor }).generate("first prompt");
    expect(await screen.getHtml()).toBe(html(0));
    expect(generates).toBe(0);
    expect((await readQuota(quotaDir)).used).toBe(0);
    expect(existsSync(join(quotaDir, ".design-loop", "quota.json"))).toBe(false);
  });

  it("regenerates when the inner generator cannot rebuild a handle from an id", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(1), screenId: "fake-0" }]);
    const prompts: string[] = [];
    const plain: Generator = {
      generate: async (prompt) => {
        prompts.push(prompt);
        return { id: "live-0", edit: async () => ({}) as Screen, getHtml: async () => html(9), getImage: async () => Buffer.from("live") };
      },
    };
    const cursor: RoundCursor = { index: -1 };
    const gen = resumingGenerator({ runDir, inner: plain, cursor });

    const screen = await gen.generate("first prompt");
    expect(prompts).toEqual(["first prompt"]);
    expect(await screen.getHtml()).toBe(html(9)); // the live handle's own HTML, not the stored version's
    expect(cursor.index).toBe(0);
    expect(gen.fromId).toBeUndefined();
  });

  it("does not mistake a half-written screen-id.txt for a screen id", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(1), screenId: "fake-0" }]);
    writeFileSync(join(runDir, "v00", "screen-id.txt"), "  \n"); // the store crashed mid-write
    const inner = new FakeGenerator([shot(5)]);
    const cursor: RoundCursor = { index: -1 };

    const screen = await resumingGenerator({ runDir, inner, cursor }).generate("first prompt");
    // Reported as replayed, it would serve the stored HTML and send the next edit to a screen that never existed.
    expect(inner.prompts).toEqual(["first prompt"]);
    expect(await screen.getHtml()).toBe(html(5));
  });

  it("lists the version directories already on disk, ignoring anything else", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(1), screenId: "fake-0" }, { ...shot(1), doc: doc(2), screenId: "fake-1" }]);
    mkdirSync(join(runDir, "notes"));
    writeFileSync(join(runDir, "manifest.json"), "{}");
    expect(await listVersions(runDir)).toEqual(["v00", "v01"]);
    expect(await listVersions(join(runDir, "nope"))).toEqual([]);
  });

  it("refuses a run directory it cannot read, rather than reporting no versions", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(1), screenId: "fake-0" }]);
    // "Nothing on disk" would quietly send every page back through a browser render instead of saying why.
    await expect(listVersions(join(runDir, "v00", "screen.html"))).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("resumingMeasure", () => {
  it("reads a stored doc instead of re-measuring, keyed by html content", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(3), screenId: "fake-0" }]);
    let calls = 0;
    const m = resumingMeasure({ runDir, inner: async () => { calls++; return doc(99); } });

    expect((await m(html(0))).nodes).toHaveLength(3);
    expect(calls).toBe(0);
  });

  it("measures html it has never seen", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(3), screenId: "fake-0" }]);
    let calls = 0;
    const m = resumingMeasure({ runDir, inner: async () => { calls++; return doc(99); } });

    expect((await m(html(7))).nodes).toHaveLength(99);
    expect(calls).toBe(1);
  });

  it("does not care what order the loop asks in", async () => {
    const runDir = seed([
      { ...shot(0), doc: doc(3), screenId: "fake-0" },
      { ...shot(1), doc: doc(5), screenId: "fake-1" },
    ]);
    let calls = 0;
    const m = resumingMeasure({ runDir, inner: async () => { calls++; return doc(99); } });

    expect((await m(html(1))).nodes).toHaveLength(5);
    expect((await m(html(0))).nodes).toHaveLength(3);
    expect((await m(html(1))).nodes).toHaveLength(5);
    expect(calls).toBe(0);
  });

  it("re-measures a version whose html is stored but whose doc is not", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(3), screenId: "fake-0" }]);
    const partial = join(runDir, "v01"); // claimed and generated, but never scored
    mkdirSync(partial);
    writeFileSync(join(partial, "screen.html"), html(1));
    let calls = 0;
    const m = resumingMeasure({ runDir, inner: async () => { calls++; return doc(99); } });

    expect((await m(html(1))).nodes).toHaveLength(99);
    expect(calls).toBe(1);
  });
});

const critique = (): Critique => ({ critic: "typography", score: 70, issues: [], resolved: { claimed: [], verified: [] } });
const version = (index: number) => ({
  index, png: Buffer.from("png"), html: html(index), doc: doc(1), critiques: [critique()],
  composite: 70, gatePass: false, prompt: "p", openIssues: [],
});

const scoredRun = async () => {
  const designDir = mkdtempSync(join(tmpdir(), "dl-run-"));
  const run = await openRun(designDir, "home", "2026-09-20");
  await run.writeVersion(version(0));
  return { run, resumed: resumingRun(run, run.dir) };
};

describe("resumingRun", () => {
  it("returns the existing version rather than rewriting it", async () => {
    const { run, resumed } = await scoredRun();
    const before = readFileSync(join(run.dir, "v00", "screen.html"), "utf8");

    expect(await resumed.writeVersion({ ...version(0), html: "OVERWRITTEN" })).toBe("v00");
    expect(readFileSync(join(run.dir, "v00", "screen.html"), "utf8")).toBe(before);
  });

  it("hands back a no-op handle for an already-scored version instead of throwing", async () => {
    const { run, resumed } = await scoredRun();
    const handle = await resumed.openVersion(0);
    expect(handle.version).toBe("v00");
    expect(handle.dir).toBe(join(run.dir, "v00"));

    await handle.writeGenerated({ png: Buffer.from("X"), html: "OVERWRITTEN", doc: doc(9), prompt: "X" });
    await handle.writeCommitteeInputs({ digest: "X", carriedIssues: [], measurements: [] });
    await handle.finish({ critiques: [critique()], composite: 1, gatePass: true, openIssues: [] });

    expect(readFileSync(join(run.dir, "v00", "screen.html"), "utf8")).toBe(html(0));
    expect(JSON.parse(readFileSync(join(run.dir, "v00", "composite.json"), "utf8")))
      .toEqual({ composite: 70, gatePass: false });
  });

  it("never lets a replayed round finish a scored version twice into the manifest", async () => {
    const { run, resumed } = await scoredRun();
    for (const _ of [0, 1]) {
      const handle = await resumed.openVersion(0);
      await handle.finish({ critiques: [critique()], composite: 70, gatePass: false, openIssues: [] });
    }
    await resumed.finalise({
      stopReason: "pass", committeeRank: ["v00"], hallucinationRate: {}, degradations: [], sigma: 3,
      spend: { stitchGenerations: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: 0 },
    });
    const manifest = JSON.parse(readFileSync(join(run.dir, "manifest.json"), "utf8"));
    expect(manifest.versions).toEqual([{ version: "v00", composite: 70, gatePass: false }]);
  });

  // The path production takes. `scoredRun()` above writes v00 through the very Run it then wraps, so that
  // Run knows v00 as a side effect of having written it. A resumed run has no such history: it reopens the
  // directory, and `finalise` validates committeeRank against a list rebuilt from each vNN/composite.json.
  it("finalises a run it replayed into, when the Run was rebuilt from the directory", async () => {
    const designDir = mkdtempSync(join(tmpdir(), "dl-reopen-"));
    const first = await openRun(designDir, "home", "2026-09-20");
    await first.writeVersion(version(0));

    const resumed = resumingRun(await openExistingRun(first.dir), first.dir);
    expect(await resumed.writeVersion(version(0))).toBe("v00"); // replayed: returns the name, registers nothing
    expect(await resumed.writeVersion({ ...version(1), composite: 80, gatePass: true })).toBe("v01");
    await resumed.finalise({
      stopReason: "pass", committeeRank: ["v01", "v00"], hallucinationRate: {}, degradations: [], sigma: 3,
      spend: { stitchGenerations: 2, inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: 0 },
    });

    const manifest = JSON.parse(readFileSync(join(first.dir, "manifest.json"), "utf8"));
    expect(manifest.committeeRank).toEqual(["v01", "v00"]);
    expect(manifest.best).toBe("v01");
    expect(manifest.versions).toEqual([
      { version: "v00", composite: 70, gatePass: false },
      { version: "v01", composite: 80, gatePass: true },
    ]);
  });

  // The suspend state itself: v00 claimed and written, nothing scored. Before `reopenVersion` this threw
  // "version v00 already exists" and no agent-mode run could ever be resumed.
  it("adopts a claimed-but-unscored version instead of refusing it as an existing directory", async () => {
    const designDir = mkdtempSync(join(tmpdir(), "dl-suspend-"));
    const first = await openRun(designDir, "home", "2026-09-20");
    const claimed = await first.openVersion(0);
    await claimed.writeGenerated({ png: Buffer.from("png"), html: html(0), doc: doc(1), prompt: "p" });
    await claimed.writeCommitteeInputs({ digest: "d", carriedIssues: [], measurements: [] });

    const resumed = resumingRun(await openExistingRun(first.dir), first.dir);
    const handle = await resumed.openVersion(0);
    expect(handle.version).toBe("v00");
    // A real handle, not the no-op one: its `finish` actually scores the round and registers it, so the
    // resumed run can finalise with v00 in its committeeRank.
    await handle.finish({ critiques: [critique()], composite: 70, gatePass: false, openIssues: [] });
    expect(JSON.parse(readFileSync(join(first.dir, "v00", "composite.json"), "utf8")).composite).toBe(70);
    await resumed.finalise({
      stopReason: "pass", committeeRank: ["v00"], hallucinationRate: {}, degradations: [], sigma: 3,
      spend: { stitchGenerations: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: 0 },
    });
    expect(JSON.parse(readFileSync(join(first.dir, "manifest.json"), "utf8")).best).toBe("v00");
  });

  it("claims a real directory for a round that is not on disk yet", async () => {
    const { run, resumed } = await scoredRun();
    const handle = await resumed.openVersion(1);
    expect(handle.dir).toBe(join(run.dir, "v01"));
    expect(existsSync(join(run.dir, "v01", "critiques"))).toBe(true);
    await handle.finish({ critiques: [critique()], composite: 80, gatePass: true, openIssues: [] });
    expect(existsSync(join(run.dir, "v01", "composite.json"))).toBe(true);
  });
});

describe("runScreen with an injected measure", () => {
  const FIX = new URL("../fixtures/design/", import.meta.url).pathname;
  const llm: LlmClient = {
    critique: async (critic) => ({ critic, score: 90, issues: [], resolved: { claimed: [], verified: [] } }),
  };
  const chairClient: ChairClient = { synthesise: async () => ({ prompt: "bigger", changes: [] }) };

  it("measures through the injected function instead of rendering the page", async () => {
    const designDir = mkdtempSync(join(tmpdir(), "dl-measure-"));
    cpSync(FIX, designDir, { recursive: true, filter: (src) => !src.includes(".design-loop") });
    const seen: string[] = [];
    const out = await runScreen({
      designDir, screen: "home", date: "2026-09-20", generator: new FakeGenerator([shot(0)]), llm, chairClient,
      measure: async (page) => { seen.push(page); return doc(1); },
    });

    expect(out.stopReason).toBe("pass");
    expect(seen).toEqual([html(0)]);
    const stored = JSON.parse(readFileSync(join(designDir, "runs", "2026-09-20-home", "v00", "digest.json"), "utf8"));
    expect(stored).toEqual(doc(1));
  });
});
