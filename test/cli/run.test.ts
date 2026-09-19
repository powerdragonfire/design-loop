import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScreen } from "../../src/cli/run.js";
import { FakeGenerator } from "../../src/stitch/adapter.js";
import { reserve, MONTHLY_LIMIT } from "../../src/stitch/quota.js";
import type { CriticInput, LlmClient } from "../../src/critics/llm.js";
import type { ChairClient, ChairInput } from "../../src/chair/chair.js";
import type { CriticName, Critique, Issue } from "../../src/types.js";

const FIX = new URL("../fixtures/design/", import.meta.url).pathname;
const DATE = "2026-09-18";
const setup = () => { const d = mkdtempSync(join(tmpdir(), "dl-")); cpSync(FIX, d, { recursive: true }); return d; };
const runDir = (d: string) => join(d, "runs", `${DATE}-home`);
const manifest = (d: string) => JSON.parse(readFileSync(join(runDir(d), "manifest.json"), "utf8"));
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const page = (btn: number, color = "#0B0B0F") =>
  `<!doctype html><html><body style="margin:0;background:#0B0B0F">
   <button id="b1" style="width:${btn}px;height:${btn}px;background:#FF7A1A;color:${color}">Go</button>
   </body></html>`;
const shot = (btn: number, png = "p", color?: string) => ({ html: page(btn, color), png: Buffer.from(png) });
const major = (id: string): Issue =>
  ({ id, severity: "major", evidence: { selector: "#b1", observed: "o" }, claim: "c", fix: "f", effort: "low" });

// Per-critic call counters, so a critic's "round" never depends on call order.
type Hook = (critic: CriticName, round: number) => Partial<Critique> | Error | undefined;
const llmOf = (scores: number[], hook: Hook = () => undefined) => {
  const seen: { critic: CriticName; input: CriticInput }[] = [];
  const counts: Partial<Record<CriticName, number>> = {};
  const llm: LlmClient = {
    critique: async (critic, input) => {
      const round = (counts[critic] = (counts[critic] ?? -1) + 1);
      seen.push({ critic, input });
      const extra = hook(critic, round);
      if (extra instanceof Error) throw extra;
      return { critic, score: scores[Math.min(round, scores.length - 1)], issues: [], resolved: { claimed: [], verified: [] }, ...extra };
    },
    takeUsage: () => ({ inputTokens: 1000, outputTokens: 100, cachedTokens: 0 }),
  };
  return { llm, seen };
};
const chairOf = (failFirst = 0) => {
  const inputs: ChairInput[] = [];
  let calls = 0;
  const client: ChairClient = {
    synthesise: async (input) => {
      calls++; inputs.push(input);
      if (calls <= failFirst) throw new Error("chair down");
      return { prompt: "make the button bigger", changes: [] };
    },
    takeUsage: () => ({ inputTokens: 500, outputTokens: 50, cachedTokens: 0 }),
  };
  return { client, inputs, calls: () => calls };
};
const run = (dir: string, gen: FakeGenerator, llm: LlmClient, chairClient: ChairClient, extra: object = {}) =>
  runScreen({ designDir: dir, screen: "home", date: DATE, generator: gen, llm, chairClient, ...extra });

describe("runScreen", () => {
  it("stops at round 0 with zero edits when the gate already passes", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(48)]); const c = chairOf();
    const out = await run(dir, gen, llmOf([90]).llm, c.client);
    expect(out.stopReason).toBe("pass");
    expect(out.versions).toBe(1);
    expect(gen.prompts).toHaveLength(1);
    expect(c.calls()).toBe(0);
  });

  it("edits until the deterministic blocker is cleared", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(30), shot(48)]);
    const out = await run(dir, gen, llmOf([70, 80]).llm, chairOf().client);
    expect(out.stopReason).toBe("pass");
    expect(out.versions).toBe(2);
  });

  it("survives a single dip and keeps going", async () => {
    const dir = setup(); const gen = new FakeGenerator(Array(6).fill(shot(30)));
    const out = await run(dir, gen, llmOf([70, 75, 74, 88]).llm, chairOf().client);
    expect(["converged", "budget"]).toContain(out.stopReason);
    expect(out.versions).toBeGreaterThan(3);
  });

  it("never exceeds maxRounds edits", async () => {
    const dir = setup(); const gen = new FakeGenerator(Array(10).fill(shot(30)));
    const out = await run(dir, gen, llmOf([10, 20, 30, 40, 50, 60, 70]).llm, chairOf().client);
    expect(out.stopReason).toBe("budget");
    expect(out.versions).toBeLessThanOrEqual(6);
  });

  it("builds the first Stitch prompt from the brief, the tokens and the screen spec", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(48)]);
    await run(dir, gen, llmOf([90]).llm, chairOf().client);
    const brief = readFileSync(join(dir, "brief.md"), "utf8").trim();
    const spec = readFileSync(join(dir, "screens", "home.md"), "utf8").trim();
    expect(gen.prompts[0]).toContain(brief);
    expect(gen.prompts[0]).toContain(spec);
    expect(gen.prompts[0]).toContain("#FF7A1A");
  });

  it("records each version's prompt, and the manifest's sigma, stop reason, versions and rank", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(30), shot(48)]);
    const out = await run(dir, gen, llmOf([70, 80]).llm, chairOf().client);
    const m = manifest(dir);
    expect(out.runDir).toBe(runDir(dir));
    expect(m.stopReason).toBe("pass");
    expect(m.sigma).toBe(3);
    expect(m.versions.map((v: any) => [v.version, v.gatePass])).toEqual([["v00", false], ["v01", true]]);
    expect(m.spend.stitchGenerations).toBe(2);
    expect(readFileSync(join(runDir(dir), "v00", "prompt.txt"), "utf8")).toBe(gen.prompts[0]);
    expect(readFileSync(join(runDir(dir), "v01", "prompt.txt"), "utf8")).toBe("make the button bigger");
    expect(gen.prompts[1]).toBe("make the button bigger");
  });

  it("prices spend from both clients' token usage", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(30), shot(48)]);
    await run(dir, gen, llmOf([70, 80]).llm, chairOf().client);
    const s = manifest(dir).spend;
    // 2 rounds of critics (1000 in / 100 out) on Sonnet 5, 1 chair call (500 / 50) on Opus 5
    expect(s.inputTokens).toBe(2500);
    expect(s.outputTokens).toBe(250);
    expect(s.usd).toBeCloseTo((2000 * 2 + 200 * 10 + 500 * 5 + 50 * 25) / 1e6, 9);
  });

  it("drops a failing critic, records why, and still scores the round", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(48)]);
    const boom = Object.assign(new Error("boom"), { status: 400 });
    const out = await run(dir, gen, llmOf([90], c => (c === "feasibility" ? boom : undefined)).llm, chairOf().client);
    expect(out.stopReason).toBe("pass");
    const d = manifest(dir).degradations;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ version: "v00", critic: "feasibility" });
    expect(d[0].error).toContain("boom");
  });

  it("carries an unverified LLM issue forward, so a critic cannot close it by going quiet", async () => {
    const dir = setup(); const gen = new FakeGenerator(Array(6).fill(shot(48))); const c = chairOf();
    const hook: Hook = (critic, round) => (critic === "typography" && round === 0 ? { issues: [major("typography-001")] } : undefined);
    const out = await run(dir, gen, llmOf([80], hook).llm, c.client);
    expect(out.stopReason).toBe("converged");
    expect(manifest(dir).versions.every((v: any) => !v.gatePass)).toBe(true);
    expect(c.inputs[1].openIssues.map(i => i.id)).toContain("typography-001");
  });

  it("closes a carried issue only when the critic claims it AND the element actually changed", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(48), shot(52)]);
    const hook: Hook = (critic, round) => {
      if (critic !== "typography") return undefined;
      return round === 0 ? { issues: [major("typography-001")] } : { resolved: { claimed: ["typography-001"], verified: [] } };
    };
    const out = await run(dir, gen, llmOf([80], hook).llm, chairOf().client);
    expect(out.stopReason).toBe("pass");
    expect(out.versions).toBe(2);
  });

  it("on a regression, hands the chair the BEST version's screenshot and issues plus the failed prompt", async () => {
    const dir = setup(); const c = chairOf();
    const gen = new FakeGenerator([shot(30, "BEST-PNG"), shot(30, "LATEST-PNG"), ...Array(4).fill(shot(30))]);
    const hook: Hook = (critic, round) => (critic === "typography" && round === 1 ? { issues: [major("typography-002")] } : undefined);
    const { llm, seen } = llmOf([80, 40], hook);
    await run(dir, gen, llm, c.client);
    const bestOpen = readJson(join(runDir(dir), "v00", "open-issues.json")).map((i: Issue) => i.id);
    const second = c.inputs[1];
    expect(second.imagePng.toString()).toBe("BEST-PNG");
    expect(second.openIssues.map(i => i.id)).toEqual(bestOpen);
    expect(second.regression).toMatchObject({ bestVersion: "v00", failedPrompt: "make the button bigger" });
    expect(second.regression!.delta).toBeLessThan(0);
    expect(second.regression!.introduced.map(i => i.id)).toEqual(["typography-002"]);
    expect(c.inputs[0].regression).toBeNull();
    // the next round builds on the BEST version, so the failed edit's own issue must not linger
    const typography = seen.filter(s => s.critic === "typography");
    expect(typography[2].input.openIssues.map(i => i.id)).not.toContain("typography-002");
  });

  it("ranks a passing version first even when an earlier failing version scored higher", async () => {
    const dir = setup();
    const out = await run(dir, new FakeGenerator([shot(30), shot(48)]), llmOf([95, 60]).llm, chairOf().client);
    expect(out.stopReason).toBe("pass");
    expect(out.best).toBe("v01");
    const m = manifest(dir);
    expect(m.committeeRank[0]).toBe("v01");
    expect(m.best).toBe("v01");
  });

  it("aborts mid-run keeping every version and recording why", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(30)]);
    const out = await run(dir, gen, llmOf([70]).llm, chairOf().client);
    expect(out.stopReason).toBe("aborted");
    expect(out.versions).toBe(1);
    expect(out.best).toBe("v00");
    const m = manifest(dir);
    expect(m.stopReason).toBe("aborted");
    expect(m.abortReason).toMatch(/script exhausted/);
    expect(existsSync(join(runDir(dir), "v00", "screen.png"))).toBe(true);
  });

  it("aborts before generating when the quota cannot cover a whole run", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(48)]);
    await reserve(dir, MONTHLY_LIMIT - 3);
    await expect(run(dir, gen, llmOf([90]).llm, chairOf().client)).rejects.toThrow(/quota/i);
    expect(gen.prompts).toHaveLength(0);
    expect(existsSync(join(dir, "runs"))).toBe(false);
  });

  it("rethrows when nothing was written yet, since there is nothing to preserve", async () => {
    const dir = setup();
    await expect(run(dir, new FakeGenerator([]), llmOf([90]).llm, chairOf().client)).rejects.toThrow(/script exhausted/);
    expect(existsSync(join(runDir(dir), "manifest.json"))).toBe(false);
  });

  it("aborts rather than scoring a round when every LLM critic is unavailable", async () => {
    const dir = setup();
    const auth = Object.assign(new Error("invalid x-api-key"), { status: 401 });
    const hook: Hook = (_c, round) => (round >= 1 ? auth : undefined);
    const out = await run(dir, new FakeGenerator([shot(30), shot(48)]), llmOf([70, 80], hook).llm, chairOf().client);
    expect(out.stopReason).toBe("aborted");
    expect(out.versions).toBe(1);
    expect(manifest(dir).abortReason).toMatch(/committee unavailable/);
    expect(manifest(dir).abortReason).toContain("invalid x-api-key");
  });

  it("rethrows, writing no manifest, when every LLM critic is unavailable at round 0", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(48)]);
    const denied = Object.assign(new Error("invalid x-api-key"), { status: 401 });
    // The deterministic critique alone would pass this screen's gate; no committee ever reviewed it.
    await expect(run(dir, gen, llmOf([90], () => denied).llm, chairOf().client))
      .rejects.toThrow(/committee unavailable.*typography: invalid x-api-key/);
    expect(existsSync(join(runDir(dir), "manifest.json"))).toBe(false);
  });

  it("retries a failing chair once and carries on", async () => {
    const dir = setup(); const c = chairOf(1);
    const out = await run(dir, new FakeGenerator([shot(30), shot(48)]), llmOf([70, 80]).llm, c.client);
    expect(out.stopReason).toBe("pass");
    expect(c.calls()).toBe(2);
  });

  it("aborts, keeping its versions, when the chair fails twice", async () => {
    const dir = setup(); const c = chairOf(99);
    const out = await run(dir, new FakeGenerator([shot(30), shot(48)]), llmOf([70, 80]).llm, c.client);
    expect(out.stopReason).toBe("aborted");
    expect(c.calls()).toBe(2);
    expect(manifest(dir).abortReason).toMatch(/chair down/);
  });

  it("reports progress through log()", async () => {
    const dir = setup(); const lines: string[] = [];
    await run(dir, new FakeGenerator([shot(30), shot(48)]), llmOf([70, 80]).llm, chairOf().client, { log: (l: string) => lines.push(l) });
    expect(lines.some(l => l.includes("v00"))).toBe(true);
    expect(lines.some(l => l.includes("v01"))).toBe(true);
  });

  it("refuses to start when a configured model has no price", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(48)]);
    const cfg = readJson(join(dir, "config.json"));
    cfg.models.critic = "claude-nope";
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
    await expect(run(dir, gen, llmOf([90]).llm, chairOf().client)).rejects.toThrow(/no price/i);
    expect(gen.prompts).toHaveLength(0);
  });

  it("gives the accessibility critic the measurements, without token drift", async () => {
    const dir = setup(); const { llm, seen } = llmOf([90]);
    await run(dir, new FakeGenerator(Array(6).fill(shot(30, "p", "#123456"))), llm, chairOf().client);
    const a11y = seen.find(s => s.critic === "accessibility")!.input.measurements.map(i => i.id);
    expect(a11y.some(id => id.startsWith("det-tap-"))).toBe(true);
    expect(a11y.some(id => id.startsWith("det-token-"))).toBe(false);
    const det = readJson(join(runDir(dir), "v00", "critiques", "tokenConformance.json")).issues.map((i: Issue) => i.id);
    expect(det.some((id: string) => id.startsWith("det-token-"))).toBe(true);
  });
}, 240_000);
