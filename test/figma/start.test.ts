import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStart, stepRun, type RunStart } from "../../src/cli/step.js";
import { FigmaClient, type FetchLike, type FetchResponse } from "../../src/figma/client.js";
import { FigmaGenerator, figmaMeasure } from "../../src/figma/generator.js";
import type { FigmaNode } from "../../src/figma/serialise.js";
import type { CriticName } from "../../src/types.js";

/**
 * How a Figma run starts: from nothing (the default), from an existing frame scored as v00 (`--from`), or from
 * a frame duplicated into v00 (`--seed`), and on which art direction (`--direction`). Stubbed network only.
 */

const FIX = new URL("../fixtures/design/", import.meta.url).pathname;
const CRITICS: CriticName[] = ["typography", "behavioural", "accessibility", "feasibility"];
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

const frame = (id: string): FigmaNode => ({
  id, name: "Home", type: "FRAME",
  absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
  fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
  children: [{ id: `${id}1`, name: "Card", type: "FRAME", absoluteBoundingBox: { x: 20, y: 100, width: 350, height: 200 } }],
});
const FRAMES: Record<string, FigmaNode> = { "10:1": frame("10:1"), "10:2": frame("10:2") };

const api = (): FetchLike => {
  const res = (body: unknown, bytes = new ArrayBuffer(0)): FetchResponse =>
    ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => bytes });
  return async (url) => {
    const u = new URL(url);
    if (u.hostname === "img.test") return res({}, PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length));
    const id = u.searchParams.get("ids")!;
    if (u.pathname.endsWith("/nodes")) return res({ nodes: FRAMES[id] ? { [id]: { document: FRAMES[id] } } : {} });
    return res({ images: { [id]: FRAMES[id] ? `https://img.test/${id}.png` : null } });
  };
};

const setup = (directions?: string) => {
  const d = mkdtempSync(join(tmpdir(), "dl-start-"));
  cpSync(FIX, d, { recursive: true, filter: (src) => !src.includes(".design-loop") });
  const cfgFile = join(d, "config.json");
  writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, "utf8")), criticMode: "agent" }));
  if (directions) {
    mkdirSync(join(d, "directions"));
    writeFileSync(join(d, "directions", "home.md"), directions);
  }
  return d;
};

const step = (designDir: string, opts: { runDir?: string; start?: RunStart; seed?: string } = {}) =>
  stepRun({
    designDir, screen: "home", date: "2026-10-01", runDir: opts.runDir, start: opts.start,
    generator: new FigmaGenerator({ client: new FigmaClient("FILEKEY", "figd_test", { fetch: api() }), seed: opts.seed }),
    measure: figmaMeasure(),
    snapshotDesigns: true,
    figma: { fileKey: "FILEKEY", pageId: "266:2" },
  });

const orderOf = (out: unknown) => JSON.parse(readFileSync((out as { workOrder: string }).workOrder, "utf8"));

describe("starting a Figma run", () => {
  it("--from scores the existing frame as v00, with no design order", async () => {
    const designDir = setup();
    const first = await step(designDir, { start: { from: "10-1" } });
    expect(orderOf(first).kind).toBe("critics");
    expect(readFileSync(join(first.runDir, "v00", "screen-id.txt"), "utf8").trim()).toBe("10:1");
    expect(JSON.parse(readFileSync(join(first.runDir, "v00", "screen.json"), "utf8")).document.id).toBe("10:1");
    expect(await readStart(first.runDir)).toEqual({ from: "10-1" });

    for (const critic of CRITICS) {
      mkdirSync(join(first.runDir, "v00", "inbox"), { recursive: true });
      writeFileSync(join(first.runDir, "v00", "inbox", `${critic}.json`),
        JSON.stringify({ critic, score: 95, issues: [], resolved: { claimed: [], verified: [] } }));
    }
    const done = await step(designDir, { runDir: first.runDir });
    expect(done.done).toBe(true);
  });

  it("--seed builds v00 by duplicating the seed frame, and refuses the seed itself as the answer", async () => {
    const designDir = setup();
    const first = await step(designDir, { start: { seed: "10:1" }, seed: "10:1" });
    const order = orderOf(first);
    expect(order.kind).toBe("design");
    expect(order.units[0].inputs.editFrom).toBe("10:1");
    expect(order.units[0].inputs.editFromVersion).toBeNull();
    expect(order.instruction).toMatch(/Duplicate frame 10:1 \(the existing screen/);

    writeFileSync(join(first.runDir, "v00", "screen-id.txt"), "10:1\n");
    await expect(step(designDir, { runDir: first.runDir, seed: "10:1" })).rejects.toThrow(/built FROM/);

    writeFileSync(join(first.runDir, "v00", "screen-id.txt"), "10:2\n");
    expect(orderOf(await step(designDir, { runDir: first.runDir, seed: "10:1" })).kind).toBe("critics");
  });

  it("--direction puts that direction into the first prompt, and is kept across steps", async () => {
    const designDir = setup("## Grid\nLead with tiles.\n\n## List\nLead with rows.\n");
    const first = await step(designDir, { start: { direction: 1 } });
    expect(readFileSync(join(first.runDir, "v00", "design-prompt.txt"), "utf8")).toContain("Art direction: Lead with rows.");
    expect(await readStart(first.runDir)).toEqual({ direction: 1 });
  });

  it("refuses a direction the screen does not have", async () => {
    const designDir = setup("## Grid\nLead with tiles.\n");
    await expect(step(designDir, { start: { direction: 3 } })).rejects.toThrow(/no direction 3: directions are numbered 0 to 0/);
  });
});
