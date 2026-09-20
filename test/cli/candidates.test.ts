import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir as mkdirAsync, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDirections, generateCandidates } from "../../src/cli/candidates.js";
import { noProgress } from "../../src/cli/progress.js";
import type { Config } from "../../src/types.js";

describe("readDirections", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dl-")); });

  it("returns the prose under each heading, in file order", async () => {
    await writeFile(join(dir, "directions.md"), "# Directions\n\n## Agent first\n\nLead with the agent.\n\n## Form first\n\nLead with the form.\n");
    expect(await readDirections(dir)).toEqual(["Lead with the agent.", "Lead with the form."]);
  });

  it("joins a multi-paragraph direction into one block", async () => {
    await writeFile(join(dir, "directions.md"), "## One\n\nFirst line.\n\nSecond line.\n");
    expect(await readDirections(dir)).toEqual(["First line.\n\nSecond line."]);
  });

  it("returns nothing when the file is absent, so an existing design folder is unchanged", async () => {
    expect(await readDirections(dir)).toEqual([]);
  });

  it("returns nothing when the file has no level-two headings", async () => {
    await writeFile(join(dir, "directions.md"), "Just prose, no headings.\n");
    expect(await readDirections(dir)).toEqual([]);
  });

  it("skips a heading with no prose under it rather than yielding an empty direction", async () => {
    await writeFile(join(dir, "directions.md"), "## Empty\n\n## Real\n\nSomething.\n");
    expect(await readDirections(dir)).toEqual(["Something."]);
  });

  it("rejects rather than silencing when directions.md exists but cannot be read", async () => {
    // Create a directory named directions.md to provoke EISDIR or equivalent.
    await mkdirAsync(join(dir, "directions.md"));
    await expect(readDirections(dir)).rejects.toBeDefined();
  });

  it("normalises CRLF to LF in multi-paragraph directions", async () => {
    // Write with CRLF line endings; expect internal \r\n to become \n.
    await writeFile(join(dir, "directions.md"), "## One\r\n\r\nFirst line.\r\n\r\nSecond line.\r\n", "utf8");
    const result = await readDirections(dir);
    expect(result).toEqual(["First line.\n\nSecond line."]);
    expect(result[0]).not.toContain("\r");
  });
});

function cfg(over: Partial<Config["candidates"]> = {}): Config {
  return {
    sigma: 3, maxRounds: 5, convergenceSigmas: 1, convergenceRounds: 2,
    models: { critic: "claude-sonnet-5", chair: "claude-opus-5" },
    weights: { typography: 0.25, behavioural: 0.2, accessibility: 0.2, tokenConformance: 0.2, feasibility: 0.15 },
    batchMode: false,
    candidates: { families: 1, variantsPerFamily: 0, creativeRange: "EXPLORE", aspects: [], ...over },
  };
}

describe("generateCandidates", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dl-")); });

  const contract = { tokens: { color: { a: "#000000" } }, brief: "B", config: cfg(), screens: { home: "S" } } as any;
  const screenStub = (id: string) => ({ id, edit: async () => screenStub(id), getHtml: async () => "<p/>", getImage: async () => Buffer.from("") });

  it("makes one seed per family and the configured variants of each", async () => {
    const generate = vi.fn(async (p: string) => screenStub(`seed${generate.mock.calls.length}`));
    const variants = vi.fn(async (_s: any, _p: string, o: any) => Array.from({ length: o.variantCount }, (_, i) => screenStub(`v${i}`)));
    const out = await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate, variants } as any,
      cfg: cfg({ families: 2, variantsPerFamily: 2 }), progress: noProgress,
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(variants).toHaveBeenCalledTimes(2);
    expect(out.map((c) => c.id)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
    expect(out.map((c) => c.family)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it("appends each direction to its family's prompt, and leaves extra families bare", async () => {
    await writeFile(join(dir, "directions.md"), "## A\n\nLead with the agent.\n");
    const generate = vi.fn(async (_p: string) => screenStub("s"));
    await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate, variants: async () => [] } as any,
      cfg: cfg({ families: 2, variantsPerFamily: 0 }), progress: noProgress,
    });
    expect(generate.mock.calls[0]![0]).toContain("Art direction: Lead with the agent.");
    expect(generate.mock.calls[1]![0]).not.toContain("Art direction:");
  });

  it("skips the variants call entirely when variantsPerFamily is zero", async () => {
    // The backwards-compatibility guarantee: a design folder that has not opted in must get exactly
    // one generation and no variants calls, proved directly on the generate spy, not just on the
    // output length.
    const generate = vi.fn(async () => screenStub("s"));
    const variants = vi.fn(async () => []);
    const out = await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate, variants } as any,
      cfg: cfg({ families: 1, variantsPerFamily: 0 }), progress: noProgress,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(variants).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
  });

  it("keeps the seed when a family's variants call fails, rather than losing the family", async () => {
    const variants = vi.fn(async () => { throw new Error("503 from Stitch"); });
    const out = await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate: async () => screenStub("s"), variants } as any,
      cfg: cfg({ families: 1, variantsPerFamily: 2 }), progress: noProgress,
    });
    expect(out.map((c) => c.id)).toEqual(["c0"]);
  });

  it("keeps the seed when a family's variants call rejects with a non-Error value", async () => {
    // A rejection that isn't an Error (a thrown string, or an object with no .message) must not
    // throw again from inside the catch itself, which would lose the seed the catch exists to save.
    const variants = vi.fn(async () => { throw "boom"; });
    const out = await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate: async () => screenStub("s"), variants } as any,
      cfg: cfg({ families: 1, variantsPerFamily: 2 }), progress: noProgress,
    });
    expect(out.map((c) => c.id)).toEqual(["c0"]);
  });

  it("propagates a failed seed rather than skipping the family, and never attempts its variants", async () => {
    const variants = vi.fn(async () => []);
    await expect(generateCandidates({
      contract, screen: "home", designDir: dir,
      generator: { generate: async () => { throw new Error("503 from Stitch"); }, variants } as any,
      cfg: cfg({ families: 1, variantsPerFamily: 2 }), progress: noProgress,
    })).rejects.toThrow("503 from Stitch");
    expect(variants).not.toHaveBeenCalled();
  });
});
