import { describe, it, expect } from "vitest";
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
});
