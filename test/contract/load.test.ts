import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { loadContract } from "../../src/contract/load.js";

const FIX = new URL("../fixtures/design/", import.meta.url).pathname;

describe("loadContract", () => {
  it("loads a valid contract", async () => {
    const c = await loadContract(FIX);
    expect(c.config.maxRounds).toBe(5);
    expect(c.screens.home).toContain("Conker");
  });

  it("rejects weights that do not sum to 1.0", async () => {
    await expect(loadContract(FIX, { weights: { typography: 0.24 } }))
      .rejects.toThrow(/weights must sum to 1.0, got 0.99/);
  });

  it("rejects a null sigma", async () => {
    await expect(loadContract(FIX, { sigma: null }))
      .rejects.toThrow(/sigma is null — run `design-loop calibrate` first/);
  });

  it("rejects a missing screen spec", async () => {
    await expect(loadContract(FIX, {}, "nonexistent"))
      .rejects.toThrow(/no screen spec: nonexistent/);
  });

  it("allows a null sigma only when explicitly asked (calibrate needs this)", async () => {
    const c = await loadContract(FIX, { sigma: null }, undefined, { allowNullSigma: true });
    expect(c.config.sigma).toBeNull();
  });

  it("rejects batchMode true, so the 50% discount is never silently not applied", async () => {
    await expect(loadContract(FIX, { batchMode: true }))
      .rejects.toThrow(/batchMode is not implemented in v1/);
  });

  it("refuses agent mode with more than one candidate, naming the fields and the fix", async () => {
    await expect(loadContract(FIX, { criticMode: "agent", candidates: { families: 2 } }))
      .rejects.toThrow(/agent mode does not yet support multiple candidates.*candidates\.families.*candidates\.variantsPerFamily/);
    await expect(loadContract(FIX, { criticMode: "agent", candidates: { variantsPerFamily: 3 } }))
      .rejects.toThrow(/agent mode does not yet support multiple candidates/);
    // The same candidates block is fine in api mode, and one candidate is fine in agent mode.
    await expect(loadContract(FIX, { criticMode: "api", candidates: { families: 2, variantsPerFamily: 3 } })).resolves.toBeDefined();
    await expect(loadContract(FIX, { criticMode: "agent" })).resolves.toBeDefined();
  });

  describe("generator", () => {
    const figma = { fileKey: "Hd1q4ePvrHOmZerZZNmk9b", pageId: "266:2" };

    it("defaults to stitch, so an existing design folder behaves exactly as before", async () => {
      const c = await loadContract(FIX);
      expect(c.config.generator).toBe("stitch");
      expect(c.config.figma).toBeUndefined();
    });

    it("accepts figma in agent mode with a figma block", async () => {
      const c = await loadContract(FIX, { criticMode: "agent", generator: "figma", figma });
      expect(c.config.generator).toBe("figma");
      expect(c.config.figma).toEqual(figma);
    });

    it("refuses figma outside agent mode, naming the fix", async () => {
      await expect(loadContract(FIX, { generator: "figma", figma }))
        .rejects.toThrow(/Figma generator runs in agent mode.*"criticMode": "agent"/);
    });

    it("refuses figma without a figma block", async () => {
      await expect(loadContract(FIX, { criticMode: "agent", generator: "figma" }))
        .rejects.toThrow(/needs a "figma" block naming the file/);
    });

    it("rejects an unknown generator and unknown keys in the figma block", async () => {
      await expect(loadContract(FIX, { generator: "pencil" as never }))
        .rejects.toThrow(/invalid config\.json.*generator/s);
      await expect(loadContract(FIX, { criticMode: "agent", generator: "figma", figma: { ...figma, token: "x" } as never }))
        .rejects.toThrow(/invalid config\.json.*figma/s);
    });

    it("still refuses multiple candidates for a figma run, since it is agent mode", async () => {
      await expect(loadContract(FIX, { criticMode: "agent", generator: "figma", figma, candidates: { families: 2 } }))
        .rejects.toThrow(/agent mode does not yet support multiple candidates/);
    });
  });

  it("defaults the candidates block to today's single generation", async () => {
    const { config } = await loadContract(FIX);
    expect(config.candidates).toEqual({ families: 1, variantsPerFamily: 0, creativeRange: "EXPLORE", aspects: [] });
  });

  it("accepts a candidates block and keeps its values", async () => {
    const { config } = await loadContract(FIX, {
      candidates: { families: 2, variantsPerFamily: 2, creativeRange: "REIMAGINE", aspects: ["LAYOUT", "COLOR_SCHEME"] },
    } as never);
    expect(config.candidates.variantsPerFamily).toBe(2);
  });

  it("refuses more than five variants per family, Stitch's own cap", async () => {
    await expect(loadContract(FIX, { candidates: { variantsPerFamily: 6 } } as never))
      .rejects.toThrow(/candidates.variantsPerFamily/);
  });

  it("refuses a creativeRange Stitch does not accept", async () => {
    await expect(loadContract(FIX, { candidates: { creativeRange: "WILD" } } as never))
      .rejects.toThrow(/candidates.creativeRange/);
  });

  it("accepts variantsPerFamily: 0, the compatibility default", async () => {
    const { config } = await loadContract(FIX, { candidates: { variantsPerFamily: 0 } } as never);
    expect(config.candidates.variantsPerFamily).toBe(0);
  });

  it("accepts variantsPerFamily: 5, Stitch's own cap", async () => {
    const { config } = await loadContract(FIX, { candidates: { variantsPerFamily: 5 } } as never);
    expect(config.candidates.variantsPerFamily).toBe(5);
  });

  it("refuses a negative variantsPerFamily", async () => {
    await expect(loadContract(FIX, { candidates: { variantsPerFamily: -1 } } as never))
      .rejects.toThrow(/candidates.variantsPerFamily/);
  });

  it("refuses families: 0", async () => {
    await expect(loadContract(FIX, { candidates: { families: 0 } } as never))
      .rejects.toThrow(/candidates.families/);
  });

  it("accepts families: 1", async () => {
    const { config } = await loadContract(FIX, { candidates: { families: 1 } } as never);
    expect(config.candidates.families).toBe(1);
  });

  describe("malformed tokens.json", () => {
    const tmpDirs: string[] = [];

    afterEach(() => {
      for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    function withTokens(raw: string): string {
      const dir = mkdtempSync(join(tmpdir(), "design-loop-contract-"));
      tmpDirs.push(dir);
      cpSync(FIX, dir, { recursive: true, filter: (src) => !src.includes(".design-loop") });
      writeFileSync(join(dir, "tokens.json"), raw);
      return dir;
    }

    it("rejects invalid JSON", async () => {
      await expect(loadContract(withTokens("{not json")))
        .rejects.toThrow(/tokens\.json is not valid JSON: /);
    });

    it("rejects an array root", async () => {
      await expect(loadContract(withTokens("[1,2]")))
        .rejects.toThrow(/tokens\.json must be a JSON object/);
    });

    it("rejects a null root", async () => {
      await expect(loadContract(withTokens("null")))
        .rejects.toThrow(/tokens\.json must be a JSON object/);
    });

    it("rejects an empty object", async () => {
      await expect(loadContract(withTokens("{}")))
        .rejects.toThrow(/tokens\.json defines no tokens/);
    });
  });

  describe("criticMode", () => {
    const tmpDirs: string[] = [];

    afterEach(() => {
      for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    function setup(): string {
      const dir = mkdtempSync(join(tmpdir(), "design-loop-contract-"));
      tmpDirs.push(dir);
      cpSync(FIX, dir, { recursive: true, filter: (src) => !src.includes(".design-loop") });
      return dir;
    }

    it("defaults criticMode to api when config.json omits it", async () => {
      const dir = setup();
      expect((await loadContract(dir)).config.criticMode).toBe("api");
    });

    it("accepts criticMode agent", async () => {
      const dir = setup();
      const file = join(dir, "config.json");
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...cfg, criticMode: "agent" }));
      expect((await loadContract(dir)).config.criticMode).toBe("agent");
    });

    it("rejects an unknown criticMode", async () => {
      const dir = setup();
      const file = join(dir, "config.json");
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...cfg, criticMode: "robots" }));
      await expect(loadContract(dir)).rejects.toThrow(/invalid config\.json.*criticMode/s);
    });
  });
});
