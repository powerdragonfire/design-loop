import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { runScreen, type RunOptions } from "../../src/cli/run.js";
import { recordProgress } from "../helpers/recordProgress.js";
import { FakeGenerator, type Generator } from "../../src/stitch/adapter.js";
import { reserve, MONTHLY_LIMIT } from "../../src/stitch/quota.js";
import type { CriticInput, LlmClient } from "../../src/critics/llm.js";
import type { ChairClient, ChairInput } from "../../src/chair/chair.js";
import type { CriticName, Critique, Issue } from "../../src/types.js";

const FIX = new URL("../fixtures/design/", import.meta.url).pathname;
const DATE = "2026-09-18";
const setup = () => { const d = mkdtempSync(join(tmpdir(), "dl-")); cpSync(FIX, d, { recursive: true, filter: (src) => !src.includes(".design-loop") }); return d; };
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
const chairOf = (failFirst = 0, changes: Issue[] = []) => {
  const inputs: ChairInput[] = [];
  let calls = 0;
  const client: ChairClient = {
    synthesise: async (input) => {
      calls++; inputs.push(input);
      if (calls <= failFirst) throw new Error("chair down");
      return { prompt: "make the button bigger", changes };
    },
    takeUsage: () => ({ inputTokens: 500, outputTokens: 50, cachedTokens: 0 }),
  };
  return { client, inputs, calls: () => calls };
};
const run = (dir: string, gen: FakeGenerator, llm: LlmClient, chairClient: ChairClient, extra: object = {}) =>
  runScreen({ designDir: dir, screen: "home", date: DATE, generator: gen, llm, chairClient, ...extra });

const currentMonth = () => new Date().toISOString().slice(0, 7);
/** Pre-spends the quota down to `remaining` generations left this month, without the async round trip
 * through `reserve()` — `opts()` below has to stay synchronous so it can be passed straight to `runScreen`. */
const setQuota = (dir: string, remaining: number) => {
  mkdirSync(join(dir, ".design-loop"), { recursive: true });
  writeFileSync(join(dir, ".design-loop", "quota.json"), JSON.stringify({ month: currentMonth(), used: MONTHLY_LIMIT - remaining }));
};

/**
 * Builds `RunOptions` for a fresh design folder: `cfgOver` is merged into config.json, and generator/llm/
 * chairClient default to a script that gates clean on the very first screen, so a test only has to
 * override what it is actually exercising. `extra.quotaRemaining` pre-spends the quota.
 */
const opts = (cfgOver: Record<string, unknown> = {}, extra: { quotaRemaining?: number } & Partial<RunOptions> = {}): RunOptions => {
  const dir = setup();
  if (Object.keys(cfgOver).length > 0) {
    const cfg = readJson(join(dir, "config.json"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ...cfg, ...cfgOver }));
  }
  const { quotaRemaining, ...rest } = extra;
  if (quotaRemaining !== undefined) setQuota(dir, quotaRemaining);
  return {
    designDir: dir, screen: "home", date: DATE,
    generator: new FakeGenerator(Array(30).fill(shot(48))),
    llm: llmOf([90]).llm,
    chairClient: chairOf().client,
    ...rest,
  };
};

/** Wraps `o.llm` to count every critique() call, across the candidate stage and the edit loop alike. */
const runWithCountingLlm = async (o: RunOptions) => {
  let critiqueCalls = 0;
  const inner = o.llm;
  const llm: LlmClient = {
    critique: (critic, input, model) => { critiqueCalls++; return inner.critique(critic, input, model); },
    takeUsage: inner.takeUsage?.bind(inner),
  };
  const res = await runScreen({ ...o, llm });
  return { res, critiqueCalls };
};

/** Wraps `o.generator` to count generate()/variants() calls directly, proving the backwards-compatibility
 * guarantee on the calls themselves rather than on some derived count. */
const runWithCountingGenerator = async (o: RunOptions) => {
  let generate = 0;
  let variants = 0;
  const inner = o.generator;
  const generator: Generator = {
    generate: (prompt) => { generate++; return inner.generate(prompt); },
    variants: (seed, prompt, vo) => { variants++; return inner.variants(seed, prompt, vo); },
  };
  const res = await runScreen({ ...o, generator });
  return { generate, variants, res };
};

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
    // The only round here is the candidate stage's: the degradation is keyed by the candidate id it
    // happened on, not by the version id the candidate is later promoted to.
    expect(d[0]).toMatchObject({ version: "c0", critic: "feasibility" });
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
    // v02 was edited from the BEST version, not from the regressed v01, and round 0 has no parent
    expect(readFileSync(join(runDir(dir), "v02", "parent.txt"), "utf8")).toBe("v00");
    expect(existsSync(join(runDir(dir), "v00", "parent.txt"))).toBe(false);
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

  it("rethrows, writing no manifest, when every LLM critic is unavailable on the only candidate", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(48)]);
    const denied = Object.assign(new Error("invalid x-api-key"), { status: 401 });
    // The candidate stage runs before anything is written: a wholly unscoreable candidate (and, with
    // one family and no variants, the only candidate there is) leaves pickWinner nothing to choose.
    await expect(run(dir, gen, llmOf([90], () => denied).llm, chairOf().client))
      .rejects.toThrow(/no candidate could be scored.*typography: invalid x-api-key/);
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

  it("never lets a critic verify a deterministic issue away: the measured blocker stays open", async () => {
    const dir = setup(); const c = chairOf();
    // The button grows but stays under 44px, so det-tap-#b1 is re-measured as failing every round.
    const gen = new FakeGenerator([shot(30), ...Array(5).fill(shot(36))]);
    const hook: Hook = (critic, round) =>
      critic === "accessibility" && round >= 1 ? { resolved: { claimed: ["det-tap-#b1"], verified: [] } } : undefined;
    await run(dir, gen, llmOf([70, 80], hook).llm, c.client);
    const open = readJson(join(runDir(dir), "v01", "open-issues.json")).map((i: Issue) => i.id);
    expect(open).toContain("det-tap-#b1");
    expect(c.inputs[1].openIssues.map(i => i.id)).toContain("det-tap-#b1");
    const a11y = readJson(join(runDir(dir), "v01", "critiques", "accessibility.json"));
    expect(a11y.resolved.verified).toEqual([]);
  });

  it("records on each version the chair changes the edit that produced it was asked to make", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(30), shot(48)]);
    const two = ["a", "b"].map(id => major(`typography-${id}`));
    await run(dir, gen, llmOf([70, 80]).llm, chairOf(0, two).client);
    expect(existsSync(join(runDir(dir), "v00", "changes.json"))).toBe(false);
    const ch = readJson(join(runDir(dir), "v01", "changes.json"));
    expect(ch.requested).toBe(2);
    expect(ch.applied.map((i: { id: string }) => i.id)).toEqual(["typography-a", "typography-b"]);
    expect(gen.prompts[1]).toBe("make the button bigger");
  });

  it("truncates a chair that overran the three-change cap: it says so, and Stitch gets the capped prompt", async () => {
    const dir = setup(); const gen = new FakeGenerator([shot(30), shot(48)]); const lines: string[] = [];
    const five = ["a", "b", "c", "d", "e"].map(id => ({ ...major(`typography-${id}`), fix: `FIX-${id}` }));
    await run(dir, gen, llmOf([70, 80]).llm, chairOf(0, five).client, { log: (l: string) => lines.push(l) });
    expect(lines).toContain("chair returned 5 changes; keeping the top 3");
    expect(gen.prompts[1]).toContain("Make exactly these 3 changes and nothing else:");
    expect(gen.prompts[1]).toContain("FIX-a (element: #b1)");
    expect(gen.prompts[1]).not.toContain("FIX-d");
    const ch = readJson(join(runDir(dir), "v01", "changes.json"));
    expect(ch.requested).toBe(5);
    expect(ch.applied.map((i: { id: string }) => i.id)).toEqual(["typography-a", "typography-b", "typography-c"]);
  });

  it("groups the chair's token blockers by value, while the store keeps one issue per element", async () => {
    const dir = setup(); const c = chairOf();
    const offToken = `<!doctype html><html><body style="margin:0;background:#0B0B0F">
       <p id="t1" style="color:#9A9A9A">one</p>
       <p id="t2" style="color:#9A9A9A">two</p>
       <button id="b1" style="width:48px;height:48px;background:#FF7A1A;color:#0B0B0F">Go</button>
       </body></html>`;
    const gen = new FakeGenerator(Array(6).fill({ html: offToken, png: Buffer.from("p") }));
    await run(dir, gen, llmOf([70, 75]).llm, c.client);
    const stored = readJson(join(runDir(dir), "v00", "open-issues.json")).map((i: Issue) => i.id);
    expect(stored).toContain("det-token-color-#t1");
    expect(stored).toContain("det-token-color-#t2");
    const seen = c.inputs[0].openIssues;
    expect(seen.map(i => i.id)).toContain("det-token-group-color-1");
    expect(seen.map(i => i.id)).not.toContain("det-token-color-#t1");
    expect(seen.find(i => i.id === "det-token-group-color-1")!.claim).toContain("#t1, #t2");
  });

  const CALIBRATION = {
    sigma: 3, perCritic: {}, repeats: 5, screens: ["a"],
    criticModel: "claude-sonnet-5",
    weights: { typography: 0.25, behavioural: 0.20, accessibility: 0.20, tokenConformance: 0.20, feasibility: 0.15 },
    measuredAt: "2026-09-17T09:00:00.000Z",
  };
  const writeCalibration = (d: string, over: object | string) => {
    mkdirSync(join(d, ".design-loop"), { recursive: true });
    writeFileSync(join(d, ".design-loop", "calibration.json"),
      typeof over === "string" ? over : JSON.stringify({ ...CALIBRATION, ...over }));
  };
  const logged = async (d: string, over: object | string | null) => {
    if (over !== null) writeCalibration(d, over);
    const lines: string[] = [];
    await run(d, new FakeGenerator([shot(48)]), llmOf([90]).llm, chairOf().client, { log: (l: string) => lines.push(l) });
    return lines.join("\n");
  };

  it("says when the Stitch quota is past its warning line", async () => {
    const dir = setup();
    await reserve(dir, 450);
    expect(await logged(dir, {})).toContain(`Stitch quota: 450/${MONTHLY_LIMIT} used this month`);
    expect(await logged(setup(), {})).not.toMatch(/Stitch quota:/);
  });

  it("references the calibration in the manifest and says nothing when it still matches the config", async () => {
    const dir = setup();
    const text = await logged(dir, {});
    expect(manifest(dir).calibration).toEqual({
      sigma: 3, criticModel: "claude-sonnet-5", weights: CALIBRATION.weights, measuredAt: CALIBRATION.measuredAt,
      criticMode: "api",
    });
    expect(text).not.toMatch(/WARNING/);
    expect(text).not.toMatch(/by hand/);
  });

  it("warns when the critic model, the weights or sigma have drifted from the calibration", async () => {
    expect(await logged(setup(), { criticModel: "claude-haiku-4-5" }))
      .toMatch(/WARNING.*claude-haiku-4-5.*claude-sonnet-5|WARNING.*critic/i);
    expect(await logged(setup(), { weights: { ...CALIBRATION.weights, typography: 0.9 } })).toMatch(/WARNING.*weights/i);
    expect(await logged(setup(), { sigma: 1.5 })).toMatch(/WARNING.*sigma/i);
  });

  it("says sigma was set by hand when there is no calibration at all, and records none", async () => {
    const dir = setup();
    expect(await logged(dir, null)).toMatch(/sigma 3 was set by hand; run `design-loop calibrate`/);
    expect(manifest(dir).calibration).toBeNull();
  });

  it("warns, rather than crashing, when the calibration file is corrupt", async () => {
    const dir = setup();
    const text = await logged(dir, "{ not json");
    expect(text).toMatch(/WARNING.*calibration\.json/i);
    expect(manifest(dir).calibration).toBeNull();
    expect(manifest(dir).stopReason).toBe("pass");
  });

  describe("the candidate stage", () => {
    it("reserves quota for the candidates as well as the edits", async () => {
      await expect(runScreen(opts({ candidates: { families: 2, variantsPerFamily: 2 }, maxRounds: 5 }, { quotaRemaining: 10 })))
        .rejects.toThrow(/11 generations/);
    });

    it("starts the loop from the winning candidate, and counts the candidates it generated", async () => {
      const res = await runScreen(opts({ candidates: { families: 2, variantsPerFamily: 0 } }));
      const m = JSON.parse(readFileSync(join(res.runDir, "manifest.json"), "utf8"));
      expect(m.spend.stitchGenerations).toBe(2 + m.versions.length - 1);
      expect(m.candidates).toHaveLength(2);
      expect(m.selection.winner).toMatch(/^c\d+$/);
    });

    // maxRounds must be a positive integer (ConfigSchema), so this proves "the winner is not re-critiqued"
    // by counting critique calls instead of by round count: a single candidate's committee is 4 calls
    // (one per LLM critic); a second, wasted round on the very same screen would add 4 more.
    it("does not measure or critique the winner twice", async () => {
      const { res, critiqueCalls } = await runWithCountingLlm(opts({ candidates: { families: 1, variantsPerFamily: 0 }, maxRounds: 1 }));
      expect(critiqueCalls).toBe(4);
      expect(res.versions).toBe(1);
    });

    it("generates exactly once when there is no candidates block and no directions.md", async () => {
      const { generate, variants } = await runWithCountingGenerator(opts({ maxRounds: 1 }));
      expect(generate).toBe(1);
      expect(variants).toBe(0);
    });

    it("reports a non-empty hallucination rate for a run that stops at v00", async () => {
      // Before spec fix 1, a run that never reached the edit loop finalised with hallucinationRate: {}
      // because selectCandidate computed it and threw it away; only the loop ever tallied it.
      const dir = setup(); const gen = new FakeGenerator([shot(48)]);
      const out = await run(dir, gen, llmOf([90]).llm, chairOf().client);
      expect(out.stopReason).toBe("pass");
      expect(out.versions).toBe(1);
      const rates = manifest(dir).hallucinationRate;
      expect(Object.keys(rates).length).toBeGreaterThan(0);
    });

    it("keeps every generated candidate on disk even when the whole committee fails", async () => {
      // Before spec fix 3, pickWinner's throw propagated out of selectCandidate before run.ts ever got
      // the rows to write, so a bad-credentials run spent every candidate generation and wrote nothing.
      const denied = Object.assign(new Error("invalid x-api-key"), { status: 401 });
      const o = opts(
        { candidates: { families: 2, variantsPerFamily: 0 } },
        { generator: new FakeGenerator([shot(48), shot(48)]), llm: llmOf([90], () => denied).llm },
      );
      await expect(runScreen(o)).rejects.toThrow(/no candidate could be scored/);
      const dir = runDir(o.designDir);
      expect(existsSync(join(dir, "candidates", "c0", "screen.png"))).toBe(true);
      expect(existsSync(join(dir, "candidates", "c1", "screen.png"))).toBe(true);
    });
  });

  describe("progress", () => {
    const strip = (events: string[]) => events.filter((e) => !e.startsWith("header ") && !e.startsWith("log "));

    it("opens with what is about to run and attaches the event log inside the run directory", async () => {
      const dir = setup(); const { progress, events } = recordProgress();
      await run(dir, new FakeGenerator([shot(48)]), llmOf([90]).llm, chairOf().client, { progress });
      expect(events[0]).toMatch(/^header run home · design /);
      expect(events[1]).toMatch(/^header critic claude-sonnet-5 \(api\) · chair claude-opus-5 · sigma 3 · up to \d+ edits$/);
      expect(events[2]).toMatch(new RegExp(`^header Stitch \\d+/${MONTHLY_LIMIT} used this month · results in ${runDir(dir)}$`));
      expect(events[3]).toBe(`log ${join(runDir(dir), "events.jsonl")}`);
    });

    it("shows every step of a two-version run in order, each opened and closed before the next", async () => {
      const dir = setup(); const { progress, events } = recordProgress();
      await run(dir, new FakeGenerator([shot(30), shot(48)]), llmOf([70, 80]).llm, chairOf().client, { progress });
      const steps = events
        .filter((e) => /^(banner|begin|done) /.test(e))
        .map((e) => e.replace(/: .*$/, "").replace(/ @[\d.]+$/, ""));
      const scored = ["begin fetch html + image", "done fetch html + image", "begin measure", "done measure", "begin critics", "done critics"];
      // v00 is now a candidate, not a loop round: the candidate stage only reports its own generation
      // (no fetch/measure/critics phases of its own), then the loop starts at v01 and reports as before.
      expect(steps).toEqual([
        "begin stitch generate 1/1", "done stitch generate 1/1",
        "banner candidates · 1 generated",
        "begin chair", "done chair",
        "banner v01 · edit 1 of at most 5", "begin stitch edit", "done stitch edit", ...scored,
      ]);
    });

    it("gives the bar the share of edits used, and the status the spend so far", async () => {
      const dir = setup(); const { progress, events } = recordProgress();
      await run(dir, new FakeGenerator([shot(30), shot(48)]), llmOf([70, 80]).llm, chairOf().client, { progress });
      const banners = events.filter((e) => e.startsWith("banner "));
      expect(banners).toEqual(["banner candidates · 1 generated @0", "banner v01 · edit 1 of at most 5 @0.2"]);
    });

    it("says what each step found, so a person can tell it is working", async () => {
      const dir = setup(); const { progress, events } = recordProgress();
      // A single, immediately-passing candidate would run no loop round at all, and so report none of
      // these phases; the second, gate-passing shot forces a real edit round to see them on.
      await run(dir, new FakeGenerator([shot(30), shot(48)]), llmOf([70, 90]).llm, chairOf().client, { progress });
      expect(events).toContainEqual(expect.stringMatching(/^done fetch html \+ image: \d+ KB html, \d+ KB png$/));
      expect(events).toContainEqual(expect.stringMatching(/^done measure: \d+ nodes$/));
      expect(events).toContain("done critics: 4/4 ok");
    });

    it("shows each critic as it finishes, and a dropped one with its reason", async () => {
      const dir = setup(); const { progress, events } = recordProgress();
      // The candidate stage never reports per-critic lines (no committeeHooks of its own); a second,
      // gate-passing shot forces a real edit round, which does.
      const llm = llmOf([70, 80], (critic) => (critic === "feasibility" ? Object.assign(new Error("400 no"), { status: 400 }) : undefined)).llm;
      await run(dir, new FakeGenerator([shot(30), shot(48)]), llm, chairOf().client, { progress });
      expect(events).toContainEqual(expect.stringMatching(/^info {3}✓ typography\s+80/));
      expect(events).toContainEqual(expect.stringMatching(/^info {3}✗ feasibility\s+dropped: 400 no$/));
      expect(events).toContain("done critics: 3/4 ok");
    });

    it("warns that the chair is being retried, and still finishes", async () => {
      const dir = setup(); const { progress, events } = recordProgress();
      const out = await run(dir, new FakeGenerator([shot(30), shot(48)]), llmOf([70, 80]).llm, chairOf(1).client, { progress });
      expect(out.versions).toBe(2);
      expect(events).toContain("fail chair: chair down");
      expect(events).toContain("warn chair failed, retrying once");
      expect(events.filter((e) => e.startsWith("done chair"))).toHaveLength(1);
    });

    it("prints token counts only through debug, which the reporter drops unless verbose", async () => {
      const dir = setup(); const { progress, events } = recordProgress();
      await run(dir, new FakeGenerator([shot(30), shot(48)]), llmOf([70, 80]).llm, chairOf().client, { progress });
      expect(events).toContain("debug   critics tokens: 1000 in, 100 out, 0 cached");
      expect(events).toContain("debug   chair tokens: 500 in, 50 out, 0 cached");
    });

    it("leaves the run itself unchanged: the same versions and manifest with or without a reporter", async () => {
      const a = setup(); const b = setup();
      const withP = await run(a, new FakeGenerator([shot(30), shot(48)]), llmOf([70, 80]).llm, chairOf().client, { progress: recordProgress().progress });
      const without = await run(b, new FakeGenerator([shot(30), shot(48)]), llmOf([70, 80]).llm, chairOf().client);
      expect({ ...withP, runDir: "" }).toEqual({ ...without, runDir: "" });
      expect(manifest(a).committeeRank).toEqual(manifest(b).committeeRank);
    });
  });
}, 240_000);
