import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepRun } from "../../src/cli/step.js";
import { FigmaClient, type FetchLike, type FetchResponse } from "../../src/figma/client.js";
import { FigmaGenerator, figmaMeasure } from "../../src/figma/generator.js";
import type { FigmaNode } from "../../src/figma/serialise.js";
import type { CriticName } from "../../src/types.js";

/**
 * The whole Figma loop against a stubbed Figma API: a design order, the operator recording a frame, the frame
 * read back and scored by the committee, the chair's edit handed back as a second design order. Everything but
 * the network is real — the generator, the client, the serialiser, the resume layer, the run loop, the store.
 */

const FIX = new URL("../fixtures/design/", import.meta.url).pathname;
const DATE = "2026-09-29";
const CRITICS: CriticName[] = ["typography", "behavioural", "accessibility", "feasibility"];
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

/** A frame with one unpainted, untexted card: nothing for the deterministic critic to object to. */
const frame = (id: string, cardId: string): FigmaNode => ({
  id,
  name: "Settings",
  type: "FRAME",
  absoluteBoundingBox: { x: 15445, y: 0, width: 390, height: 844 },
  fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
  children: [
    { id: cardId, name: "Card", type: "FRAME", absoluteBoundingBox: { x: 15465, y: 100, width: 350, height: 200 } },
  ],
});
const FRAMES: Record<string, FigmaNode> = { "10:1": frame("10:1", "10:11"), "10:2": frame("10:2", "10:21") };

const figmaApi = (): { fetch: FetchLike; reads: string[] } => {
  const reads: string[] = [];
  const res = (body: unknown, bytes = new ArrayBuffer(0)): FetchResponse =>
    ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => bytes });
  const fetch: FetchLike = async (url) => {
    const u = new URL(url);
    if (u.hostname === "img.test") return res({}, PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length));
    const id = u.searchParams.get("ids")!;
    if (u.pathname.endsWith("/nodes")) {
      reads.push(id);
      return res({ nodes: FRAMES[id] ? { [id]: { document: FRAMES[id] } } : {} });
    }
    if (u.pathname.startsWith("/v1/images/")) return res({ images: { [id]: FRAMES[id] ? `https://img.test/${id}.png` : null } });
    return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { fetch, reads };
};

const setup = () => {
  const d = mkdtempSync(join(tmpdir(), "dl-figma-"));
  cpSync(FIX, d, { recursive: true, filter: (src) => !src.includes(".design-loop") });
  const cfgFile = join(d, "config.json");
  writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, "utf8")), criticMode: "agent" }));
  return d;
};

const step = (designDir: string, api = figmaApi(), runDir?: string) =>
  stepRun({
    designDir, screen: "home", date: DATE, runDir,
    generator: new FigmaGenerator({ client: new FigmaClient("FILEKEY", "figd_test", { fetch: api.fetch }) }),
    measure: figmaMeasure(),
    snapshotDesigns: true,
    figma: { fileKey: "FILEKEY", pageId: "266:2" },
  });

const orderOf = (out: unknown) => JSON.parse(readFileSync((out as { workOrder: string }).workOrder, "utf8"));
const record = (runDir: string, version: string, id: string) => writeFileSync(join(runDir, version, "screen-id.txt"), `${id}\n`);
const answer = (runDir: string, version: string, score: number, issues: unknown[] = []) => {
  const dir = join(runDir, version, "inbox");
  mkdirSync(dir, { recursive: true });
  for (const critic of CRITICS) {
    writeFileSync(join(dir, `${critic}.json`), JSON.stringify({
      critic, score, issues: critic === "typography" ? issues : [], resolved: { claimed: [], verified: [] },
    }));
  }
};
/** Cites a node that really exists in the serialised frame. A selector that does not exist is dropped as a
 * hallucination, the round would then pass on v00, and the edit path this file exists to test never runs. */
const majorOn = (selector: string) =>
  ({ id: "t-1", severity: "major", evidence: { selector, observed: "too tight" }, claim: "c", fix: "f", effort: "low" });

describe("the Figma loop, end to end", () => {
  it("reads a recorded frame from Figma, scores it, and finishes when it passes", async () => {
    const designDir = setup();
    const first = await step(designDir);
    expect(orderOf(first).kind).toBe("design");
    const runDir = first.runDir;

    record(runDir, "v00", "10:1");
    const scored = await step(designDir, figmaApi(), runDir);
    expect(orderOf(scored).kind).toBe("critics");
    // The frame is frozen into the version directory as the node tree, and measured natively from it.
    expect(JSON.parse(readFileSync(join(runDir, "v00", "screen.html"), "utf8")).id).toBe("10:1");
    expect(readFileSync(join(runDir, "v00", "screen.png")).subarray(0, 4)).toEqual(PNG.subarray(0, 4));
    const doc = JSON.parse(readFileSync(join(runDir, "v00", "digest.json"), "utf8"));
    expect(doc.nodes.map((n: { selector: string }) => n.selector)).toEqual(["10:11"]);
    expect(doc.nodes[0].bbox).toEqual({ x: 20, y: 100, w: 350, h: 200 }); // frame-relative, not x=15465

    answer(runDir, "v00", 95);
    const done = await step(designDir, figmaApi(), runDir);
    expect(done.done).toBe(true);
    expect((done as { result: { stopReason: string } }).result.stopReason).toBe("pass");
  });

  it("hands the chair's edit back as a design order, and reads the duplicate it gets back", async () => {
    const designDir = setup();
    const runDir = (await step(designDir)).runDir;
    record(runDir, "v00", "10:1");
    await step(designDir, figmaApi(), runDir);
    answer(runDir, "v00", 60, [majorOn("10:11")]);
    expect(orderOf(await step(designDir, figmaApi(), runDir)).kind).toBe("chair");
    writeFileSync(join(runDir, "v00", "inbox", "chair.json"),
      JSON.stringify({ prompt: "give the card more room", changeIds: ["t-1"] }));

    const edit = orderOf(await step(designDir, figmaApi(), runDir));
    expect(edit.kind).toBe("design");
    expect(edit.version).toBe("v01");
    expect(edit.units[0].inputs.editFrom).toBe("10:1");
    expect(edit.units[0].inputs.editFromVersion).toBe("v00");

    // The operator records the duplicate using the id straight from a Figma link.
    record(runDir, "v01", "10-2");
    const api = figmaApi();
    const next = await step(designDir, api, runDir);
    expect(orderOf(next).kind).toBe("critics");
    expect(orderOf(next).version).toBe("v01");
    expect(JSON.parse(readFileSync(join(runDir, "v01", "screen.html"), "utf8")).id).toBe("10:2");
    // v00 was already frozen on disk, so only the new frame was read from Figma.
    expect(api.reads).toEqual(["10:2"]);
    expect(existsSync(join(runDir, "manifest.json"))).toBe(false);
  });

  it("refuses an edit made in place on the frame it was meant to be built from", async () => {
    const designDir = setup();
    const runDir = (await step(designDir)).runDir;
    record(runDir, "v00", "10:1");
    await step(designDir, figmaApi(), runDir);
    answer(runDir, "v00", 60, [majorOn("10:11")]);
    await step(designDir, figmaApi(), runDir);
    writeFileSync(join(runDir, "v00", "inbox", "chair.json"), JSON.stringify({ prompt: "more room", changeIds: ["t-1"] }));
    await step(designDir, figmaApi(), runDir);

    record(runDir, "v01", "10:1");
    await expect(step(designDir, figmaApi(), runDir)).rejects.toThrow(/built FROM \(v00\)\. Duplicate that frame/);
    // A plain failure: nothing snapshotted, nothing finalised, so recording the right id and stepping recovers.
    expect(existsSync(join(runDir, "v01", "screen.html"))).toBe(false);
    expect(existsSync(join(runDir, "manifest.json"))).toBe(false);
    record(runDir, "v01", "10:2");
    expect(orderOf(await step(designDir, figmaApi(), runDir)).kind).toBe("critics");
  });

  it("fails plainly on an id Figma does not have, and recovers once it is corrected", async () => {
    const designDir = setup();
    const runDir = (await step(designDir)).runDir;
    record(runDir, "v00", "99:99");
    await expect(step(designDir, figmaApi(), runDir)).rejects.toThrow(/has no node 99:99/);
    expect(existsSync(join(runDir, "v00", "screen.html"))).toBe(false);
    expect(existsSync(join(runDir, "manifest.json"))).toBe(false);

    record(runDir, "v00", "10:1");
    expect(orderOf(await step(designDir, figmaApi(), runDir)).kind).toBe("critics");
  });
});
