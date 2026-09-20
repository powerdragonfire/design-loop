import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
