import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = vi.fn((id: string) => ({
  generate: vi.fn(async () => ({
    id: `${id}-s1`, edit: vi.fn(), getHtml: async () => "", getImage: async () => "",
  })),
}));
vi.mock("@google/stitch-sdk", () => ({ stitch: { project: (id: string) => project(id) } }));

const { createStitchGenerator } = await import("../../src/stitch/adapter.js");

afterEach(() => { vi.unstubAllEnvs(); project.mockClear(); });

describe("createStitchGenerator", () => {
  const quotaDir = () => mkdtempSync(join(tmpdir(), "dl-"));

  it("names STITCH_API_KEY when it is missing", () => {
    vi.stubEnv("STITCH_API_KEY", "");
    vi.stubEnv("STITCH_PROJECT_ID", "p1");
    expect(() => createStitchGenerator({ quotaDir: quotaDir() })).toThrow(/STITCH_API_KEY/);
    expect(project).not.toHaveBeenCalled();
  });

  it("names STITCH_PROJECT_ID when it is missing", () => {
    vi.stubEnv("STITCH_API_KEY", "k");
    vi.stubEnv("STITCH_PROJECT_ID", "");
    expect(() => createStitchGenerator({ quotaDir: quotaDir() })).toThrow(/STITCH_PROJECT_ID/);
    expect(project).not.toHaveBeenCalled();
  });

  it("wires the project named by STITCH_PROJECT_ID", async () => {
    vi.stubEnv("STITCH_API_KEY", "k");
    vi.stubEnv("STITCH_PROJECT_ID", "p1");
    const gen = createStitchGenerator({ quotaDir: quotaDir() });
    expect(project).toHaveBeenCalledWith("p1");
    expect((await gen.generate("go")).id).toBe("p1-s1");
  });
});
