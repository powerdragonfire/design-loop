import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, cpSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrate, abDistiller } from "../../src/cli/calibrate.js";
import type { LlmClient } from "../../src/critics/llm.js";
import type { CriticName } from "../../src/types.js";

const FIX = new URL("../fixtures/design/", import.meta.url).pathname;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dl-")); cpSync(FIX, dir, { recursive: true }); });

// Score depends on the screen (so screens truly differ) and, optionally, on how many
// times THIS critic has seen THIS screen (so repeats can vary).
const llmOf = (base: Record<string, number>, wobble: number[] = [0]): LlmClient => {
  const seen: Record<string, number> = {};
  return {
    critique: async (critic: CriticName, input) => {
      const k = `${critic}:${input.screen}`;
      const n = (seen[k] = (seen[k] ?? -1) + 1);
      return { critic, score: base[input.screen] + wobble[n % wobble.length], issues: [], resolved: { claimed: [], verified: [] } };
    },
    takeUsage: () => ({ inputTokens: 1000, outputTokens: 100, cachedTokens: 0 }),
  };
};
const BASE = { a: 60, b: 90, c: 75 };

describe("calibrate", () => {
  it("reports sigma zero when repeats agree, even though the screens differ", async () => {
    const out = await calibrate({ designDir: dir, llm: llmOf(BASE), repeats: 3 });
    expect(out.sigma).toBeCloseTo(0, 9);
  });

  it("measures repeat-to-repeat noise within a screen, with the unbiased (n-1) estimator", async () => {
    // each critic scores 70, 80, 90 across three repeats: SAMPLE std 10 (the population form
    // would give 8.16 and understate the noise floor by 18%); the four LLM critics carry weight
    // 0.8 and the deterministic dimension is constant, so the composite's std is 8
    const out = await calibrate({ designDir: dir, llm: llmOf({ a: 80, b: 80, c: 80 }, [-10, 0, 10]), repeats: 3 });
    expect(out.sigma).toBeCloseTo(8, 6);
    expect(out.perCritic.typography).toBeCloseTo(10, 6);
  });

  it("does not fold the difference BETWEEN screens into sigma", async () => {
    const out = await calibrate({ designDir: dir, llm: llmOf(BASE, [-10, 0, 10]), repeats: 3 });
    expect(out.sigma).toBeCloseTo(8, 6);
  });

  it("refuses fewer than 2 repeats: one sample has no spread and would set sigma to 0", async () => {
    await expect(calibrate({ designDir: dir, llm: llmOf(BASE), repeats: 1 })).rejects.toThrow(/repeats/);
  });

  it("refuses a design folder with no reference screens", async () => {
    rmSync(join(dir, "reference"), { recursive: true });
    await expect(calibrate({ designDir: dir, llm: llmOf(BASE), repeats: 2 })).rejects.toThrow(/reference/);
  });

  it("writes sigma into config.json and the evidence into calibration.json, leaving no temp files", async () => {
    const out = await calibrate({ designDir: dir, llm: llmOf({ a: 80, b: 80, c: 80 }, [-10, 0, 10]), repeats: 3 });
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).sigma).toBeCloseTo(out.sigma, 9);
    expect(readdirSync(join(dir, ".design-loop")).sort()).toEqual(["calibration.json"]);
    expect(readdirSync(dir).filter(f => f.includes(".tmp"))).toEqual([]);
    const cal = JSON.parse(readFileSync(join(dir, ".design-loop", "calibration.json"), "utf8"));
    expect(cal).toMatchObject({ repeats: 3, screens: ["a", "b", "c"] });
    expect(cal.sigma).toBeCloseTo(out.sigma, 9);
    expect(cal.criticModel).toBe("claude-sonnet-5");
    expect(Object.keys(cal.weights)).toContain("typography");
  });

  it("refuses to calibrate when any critic is dropped in any repeat, and writes nothing", async () => {
    // a repeat scored on fewer critics is rescaled by renormalise(), a systematic shift that
    // would inflate sigma, and every later run trusts the written value
    const before = readFileSync(join(dir, "config.json"), "utf8");
    let n = 0;
    const flaky: LlmClient = {
      critique: async (critic, input) => {
        if (critic === "feasibility" && ++n === 2) throw Object.assign(new Error("boom"), { status: 400 });
        return { critic, score: 80, issues: [], resolved: { claimed: [], verified: [] } };
      },
    };
    await expect(calibrate({ designDir: dir, llm: flaky, repeats: 3 })).rejects.toThrow(/calibration aborted.*feasibility.*boom/s);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, ".design-loop", "calibration.json"))).toBe(false);
  });

  it("prices the run from the client's token usage", async () => {
    const out = await calibrate({ designDir: dir, llm: llmOf(BASE), repeats: 2 });
    // 3 screens x 2 repeats = 6 committee rounds x (1000 in, 100 out) on Sonnet 5
    expect(out.usd).toBeCloseTo((6000 * 2 + 600 * 10) / 1e6, 9);
  });

  it("loads the contract while sigma is still null", async () => {
    const path = join(dir, "config.json");
    const cfg = JSON.parse(readFileSync(path, "utf8")); cfg.sigma = null;
    (await import("node:fs")).writeFileSync(path, JSON.stringify(cfg));
    await expect(calibrate({ designDir: dir, llm: llmOf(BASE), repeats: 2 })).resolves.toBeDefined();
  });

  it("consumes no Stitch generations: it never touches the quota ledger", async () => {
    await calibrate({ designDir: dir, llm: llmOf(BASE), repeats: 2 });
    expect(existsSync(join(dir, ".design-loop", "quota.json"))).toBe(false);
  });
}, 120_000);

describe("abDistiller", () => {
  // The raw-HTML run gets one extra issue about letter-spacing that the digest run misses.
  const abLlm = (): LlmClient => ({
    critique: async (critic, input) => {
      const raw = input.digest.includes("<html") || input.digest.includes("<!doctype");
      const issue = (claim: string) => ({ id: `${critic}-001`, severity: "major" as const, evidence: { selector: "x", observed: "o" }, claim, fix: "f", effort: "low" as const });
      const issues = critic === "typography"
        ? [issue("primary button label is too small to read"), ...(raw ? [issue("headline letter spacing is too wide and uneven")] : [])]
        : [];
      return { critic, score: 80, issues, resolved: { claimed: [], verified: [] } };
    },
    takeUsage: () => ({ inputTokens: 1000, outputTokens: 100, cachedTokens: 0 }),
  });

  it("lists raw-HTML issues that the digest run did not raise", async () => {
    const out = await abDistiller({ designDir: dir, llm: abLlm() });
    const a = out.screens.find(s => s.screen === "a")!;
    expect(a.rawOnly.map(i => i.claim)).toEqual(["headline letter spacing is too wide and uneven"]);
    expect(a.rawIssues.length).toBeGreaterThan(a.digestIssues.length);
  });

  it("does not report an issue both runs raised, worded differently", async () => {
    const llm: LlmClient = {
      critique: async (critic, input) => {
        const raw = input.digest.includes("<html") || input.digest.includes("<!doctype");
        const claim = raw ? "the primary button label is far too small to read" : "primary button label too small to read comfortably";
        return { critic, score: 80, resolved: { claimed: [], verified: [] },
          issues: critic === "typography" ? [{ id: "typography-001", severity: "major", evidence: { selector: "x", observed: "o" }, claim, fix: "f", effort: "low" }] : [] };
      },
    };
    const out = await abDistiller({ designDir: dir, llm });
    expect(out.screens.every(s => s.rawOnly.length === 0)).toBe(true);
  });

  it("writes the comparison to .design-loop/ab-distiller.json", async () => {
    await abDistiller({ designDir: dir, llm: abLlm() });
    expect(existsSync(join(dir, ".design-loop", "ab-distiller.json"))).toBe(true);
  });
}, 120_000);
