import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordProgress } from "../helpers/recordProgress.js";

/**
 * The shape that made the live smoke run fail: a progress component carrying an empty `screens` array
 * ahead of the component holding the real screen. SDK 0.3.5's own projection picks the empty one and
 * throws "Incomplete API response from edit_screens: expected object at projection path".
 */
const RESPONSE = {
  outputComponents: [
    { progressUpdates: {}, design: { screens: [] } },
    { design: { screens: [{ id: "s1", htmlCode: { downloadUrl: "https://x/html" }, screenshot: { downloadUrl: "https://x/png" } }] } },
  ],
};

const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => RESPONSE);
vi.mock("@google/stitch-sdk", () => ({
  stitch: { callTool: (name: string, args: Record<string, unknown>) => callTool(name, args) },
}));

const { defaultDeps } = await import("../../src/cli/main.js");

const io = { out: () => {}, err: () => {} };
const dir = () => mkdtempSync(join(tmpdir(), "dl-"));

afterEach(() => { vi.unstubAllEnvs(); callTool.mockClear(); });

const generatorWith = (mode: "normal" | "quiet" | "verbose") => {
  vi.stubEnv("STITCH_PROJECT_ID", "p1");
  vi.stubEnv("STITCH_API_KEY", "k");
  const { progress, events } = recordProgress();
  return { gen: defaultDeps(dir(), io, progress, mode).makeGenerator(), events };
};

// The wiring itself: adapter hook -> promptLines -> progress.info. The pieces are unit-tested either
// side of this; what this pins is that production actually connects them.
describe("the prompt the CLI sends to Stitch", () => {
  it("is printed under the step that sends it, for a generate and for an edit", async () => {
    const { gen, events } = generatorWith("normal");
    await (await gen.generate("a simple mobile login screen")).edit("make the button larger");
    expect(events).toEqual([
      "info   → generate: a simple mobile login screen",
      "info   → edit: make the button larger",
    ]);
  });

  it("survives the response shape that broke the live run, instead of throwing", async () => {
    const { gen } = generatorWith("normal");
    const screen = await gen.generate("a simple mobile login screen");
    expect(screen.id).toBe("s1");
    const edited = await screen.edit("make the button larger");
    expect(edited.id).toBe("s1");
    expect(callTool).toHaveBeenLastCalledWith("edit_screens", expect.objectContaining({
      projectId: "p1",
      selectedScreenIds: ["s1"],
      // The chair's prompt, plus the suffix that stops Stitch answering with a dom_operations patch.
      prompt: "make the button larger\n\nReturn the complete updated screen, not a partial edit.",
    }));
  });

  it("expands a multi-line prompt under --verbose", async () => {
    const { gen, events } = generatorWith("verbose");
    await gen.generate("Conker\n\nDesign tokens:\n{ \"bg\": \"#0B0B0F\" }");
    expect(events).toEqual([
      "info   → generate:",
      "info     Conker",
      "info     ",
      "info     Design tokens:",
      'info     { "bg": "#0B0B0F" }',
    ]);
  });
});
