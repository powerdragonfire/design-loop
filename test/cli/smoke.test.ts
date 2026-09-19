import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { smoke, isSkipped, type SmokeReport } from "../../src/cli/smoke.js";
import { FakeGenerator, type Generator } from "../../src/stitch/adapter.js";
import type { ChairClient } from "../../src/chair/chair.js";
import type { LlmClient } from "../../src/critics/llm.js";
import type { Critique, Usage } from "../../src/types.js";

const DESIGN = fileURLToPath(new URL("../fixtures/design/", import.meta.url));

// The smallest real PNG: the adapter is what checks the bytes, so the fake only has to be one.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const HTML = `<!doctype html><html><body style="margin:0;background:#0B0B0F">
  <button id="b1" style="width:30px;height:30px;background:#FF7A1A;color:#0B0B0F">Go</button>
  </body></html>`;

const critique = (): Critique =>
  ({ critic: "typography", score: 82, issues: [], resolved: { claimed: [], verified: [] } });

const llmOf = (usages: Usage[], fail = false): LlmClient => {
  let n = 0;
  return {
    critique: async () => { if (fail) throw new Error("400 output_config.format is not supported"); return critique(); },
    takeUsage: () => usages[Math.min(n++, usages.length - 1)]!,
  };
};
const used = (cachedTokens: number): Usage => ({ inputTokens: 2400, outputTokens: 300, cachedTokens });

const chairOf = (err?: Error): ChairClient => ({
  synthesise: async () => {
    if (err) throw err;
    return { prompt: "Enlarge the primary button to 48px tall.", changes: [] };
  },
  takeUsage: () => ({ inputTokens: 1200, outputTokens: 200, cachedTokens: 0 }),
});

const generatorOf = () => new FakeGenerator([{ html: HTML, png: PNG }, { html: HTML, png: PNG }]);
const brokenGenerator = (): Generator => ({ generate: async () => { throw new Error("Stitch is unreachable"); } });

const run = (over: Partial<Parameters<typeof smoke>[0]> = {}): Promise<SmokeReport> =>
  smoke({
    designDir: DESIGN,
    generator: generatorOf(),
    llm: llmOf([used(0), used(2100)]),
    chairClient: chairOf(),
    ...over,
  });

const step = (r: SmokeReport, name: string) => r.steps.find((s) => s.name === name)!;
const NAMES = ["critic call", "prompt cache", "chair call", "stitch generate", "stitch edit", "measure real page", "cost"];

describe("smoke", () => {
  it("runs every step in order and passes them all against healthy fakes", async () => {
    const r = await run();
    expect(r.steps.map((s) => s.name)).toEqual(NAMES);
    expect(r.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`)).toEqual([]);
    expect(r.usd).toBeCloseTo((2400 * 2 * 2 + 300 * 2 * 10 + 2100 * 0.2 + 1200 * 5 + 200 * 25) / 1e6, 9);
  });

  it("reports what each step found, so the operator can judge the numbers", async () => {
    const r = await run();
    expect(step(r, "critic call").detail).toContain("82");
    expect(step(r, "prompt cache").detail).toContain("2100");
    expect(step(r, "chair call").detail).toMatch(/prompt/i);
    expect(step(r, "measure real page").detail).toMatch(/node/i);
    expect(step(r, "measure real page").detail).toMatch(/det-tap-/);
    expect(step(r, "measure real page").detail).toMatch(/not rgb\(\)/);
    expect(step(r, "cost").detail).toContain("0.58");
  });

  it("keeps going through the Stitch steps when the critic call fails", async () => {
    const r = await run({ llm: llmOf([used(0)], true) });
    expect(step(r, "critic call").ok).toBe(false);
    expect(step(r, "critic call").detail).toContain("output_config.format");
    expect(isSkipped(step(r, "prompt cache"))).toBe(true);
    expect(step(r, "stitch generate").ok).toBe(true);
    expect(step(r, "stitch edit").ok).toBe(true);
    expect(step(r, "measure real page").ok).toBe(true);
  });

  it("marks the edit and the real-page measurement skipped when generate fails", async () => {
    const r = await run({ generator: brokenGenerator() });
    expect(step(r, "stitch generate").ok).toBe(false);
    expect(step(r, "stitch generate").detail).toContain("Stitch is unreachable");
    for (const name of ["stitch edit", "measure real page"]) {
      expect(isSkipped(step(r, name))).toBe(true);
      expect(step(r, name).ok).toBe(false);
    }
    expect(step(r, "cost").ok).toBe(true);
  });

  it("fails the cache step when the second call read nothing from the cache, and says why", async () => {
    const cold = await run({ llm: llmOf([used(0), used(0)]) });
    expect(step(cold, "prompt cache").ok).toBe(false);
    expect(step(cold, "prompt cache").detail).toMatch(/minimum cacheable/i);
    const warm = await run({ llm: llmOf([used(0), used(1500)]) });
    expect(step(warm, "prompt cache").ok).toBe(true);
  });

  it("suggests turning the fallbacks beta off when the chair is refused over it", async () => {
    const r = await run({ chairClient: chairOf(new Error("400 betas: server-side-fallback-2026-07-01 is not available")) });
    expect(step(r, "chair call").ok).toBe(false);
    expect(step(r, "chair call").detail).toMatch(/fallbacks: false/);
  });
}, 120_000);
