import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { loadContract } from "../contract/load.js";
import { measure } from "../measure/measure.js";
import { deterministicCritique } from "../critics/deterministic.js";
import { distill } from "../distill/distill.js";
import { LLM_CRITICS, runCommittee, type CriticInput, type LlmClient } from "../critics/llm.js";
import { AgentLlmClient, WorkOrderPending } from "../critics/agent.js";
import { composite, renormalise } from "../scoring/score.js";
import { versionName, writeAtomic } from "../store/store.js";
import { costUsd } from "./pricing.js";
import { committeeHooks, noProgress, type Progress } from "./progress.js";
import type { Config, Contract, CriticName, MeasuredDoc, Usage } from "../types.js";

export interface CalibrationResult {
  sigma: number;
  perCritic: Record<string, number>;
  repeats: number;
  screens: string[];
  usd: number | null;
}

export interface AbIssue {
  critic: string;
  severity: string;
  claim: string;
}

export interface AbResult {
  screens: { screen: string; rawIssues: AbIssue[]; digestIssues: AbIssue[]; rawOnly: AbIssue[] }[];
  usd: number | null;
}

interface ReferenceScreen {
  screen: string;
  html: string;
  png: Buffer;
}

const DEFAULT_REPEATS = 5;
// An issue is "the same claim" when at least this share of its content words is shared.
const CLAIM_MATCH = 0.4;

const noUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
const addUsage = (total: Usage, more: Usage | undefined): void => {
  if (!more) return;
  total.inputTokens += more.inputTokens;
  total.outputTokens += more.outputTokens;
  total.cachedTokens += more.cachedTokens;
};

/**
 * Every `<name>.html` under `<designDir>/reference/` with the `<name>.png` beside it, sorted by name. A Figma
 * design folder's reference screens are node trees, so `<name>.json` is read the same way.
 */
async function readReference(designDir: string): Promise<ReferenceScreen[]> {
  const refDir = join(designDir, "reference");
  const files = await readdir(refDir).catch(() => [] as string[]);
  const sources = files.filter((f) => f.endsWith(".html") || f.endsWith(".json")).sort();
  if (sources.length === 0) throw new Error(`no reference screens in ${refDir}`);
  const screens: ReferenceScreen[] = [];
  for (const file of sources) {
    const screen = basename(file, extname(file));
    if (screens.some((s) => s.screen === screen)) throw new Error(`reference screen ${screen} has both an .html and a .json`);
    const png = await readFile(join(refDir, `${screen}.png`)).catch(() => {
      throw new Error(`reference screen ${file} has no ${screen}.png beside it`);
    });
    screens.push({ screen, html: await readFile(join(refDir, file), "utf8"), png });
  }
  return screens;
}

async function writeEvidence(designDir: string, name: string, body: unknown): Promise<void> {
  const dir = join(designDir, ".design-loop");
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, name), JSON.stringify(body, null, 2) + "\n");
}

// Fail on an unpriced model before any spend, as a run does; a client that reports no usage needs no price.
function priceCheck(cfg: Config, llm: LlmClient): void {
  if (llm.takeUsage) costUsd(cfg.models.critic, noUsage());
}

function pricedTotal(cfg: Config, llm: LlmClient, total: Usage): number | null {
  return llm.takeUsage ? costUsd(cfg.models.critic, total) : null;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
// Sample variance (n - 1): the population form understates the noise floor by sqrt((n-1)/n), the unsafe direction.
const sampleVariance = (xs: number[]): number => {
  const m = mean(xs);
  return xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1);
};
// sqrt of the mean of the per-screen variances: noise WITHIN a screen, never the spread between screens.
const withinScreenStd = (perScreen: number[][]): number => Math.sqrt(mean(perScreen.map(sampleVariance)));

/**
 * Measure the composite's noise floor (sigma): re-run the whole committee `repeats` times over each
 * reference screen and write the result into config.json. No generator, so no Stitch quota is used.
 */
export async function calibrate(opts: {
  designDir: string;
  llm: LlmClient;
  repeats?: number;
  log?: (line: string) => void;
  progress?: Progress;
}): Promise<CalibrationResult> {
  const { designDir, llm, log } = opts;
  const progress = opts.progress ?? noProgress;
  const repeats = opts.repeats ?? DEFAULT_REPEATS;
  if (!Number.isInteger(repeats) || repeats < 2) {
    throw new Error(`repeats must be an integer >= 2 (got ${repeats}): one sample has no spread`);
  }
  const contract = await loadContract(designDir, {}, undefined, { allowNullSigma: true });
  const cfg = contract.config;
  const reference = await readReference(designDir);
  priceCheck(cfg, llm);
  progress.header([
    `calibrate · design ${designDir}`,
    `${reference.length} reference screen${reference.length === 1 ? "" : "s"} x ${repeats} repeats x 4 critics = ${reference.length * repeats * 4} critic calls · critic ${cfg.models.critic}`,
  ]);

  const usage = noUsage();
  const composites: number[][] = [];
  const raw = new Map<CriticName, number[][]>();

  for (const { screen, html, png } of reference) {
    const doc = await measure(html);
    const det = deterministicCritique(doc, contract.tokens);
    const input: CriticInput = {
      contract,
      screen,
      digest: distill(doc),
      imagePng: png,
      openIssues: [],
      measurements: det.critique.issues.filter((i) => !i.id.startsWith("det-token-")),
    };
    const scores: number[] = [];
    const perCriticScores = new Map<CriticName, number[]>();
    progress.banner(`${screen} · ${repeats} repeats`, { fraction: composites.length / reference.length });
    for (let r = 0; r < repeats; r++) {
      const committee = await progress.phase(
        `${screen} repeat ${r + 1}/${repeats}`,
        () => runCommittee(input, cfg, llm, committeeHooks(progress, false)),
        (c) => `${c.critiques.length}/${c.critiques.length + c.failures.length} critics ok`,
      );
      addUsage(usage, llm.takeUsage?.());
      if (committee.critiques.length === 0) {
        throw new Error(`committee unavailable: ${committee.failures.map((f) => `${f.critic}: ${f.error}`).join("; ")}`);
      }
      // A repeat scored on fewer critics is rescaled by renormalise(), a systematic shift that would inflate sigma,
      // and every later run trusts the written value. Nothing is written yet, so refusing here loses nothing.
      if (committee.failures.length > 0) {
        throw new Error(
          `calibration aborted: ${screen}, repeat ${r + 1}: ${committee.failures.map((f) => `${f.critic}: ${f.error}`).join("; ")}`,
        );
      }
      // The deterministic critique is the tokenConformance dimension, exactly as in a run.
      const scored = [...committee.critiques, det.critique];
      scores.push(composite(scored, renormalise(cfg.weights, scored.map((c) => c.critic))));
      for (const c of committee.critiques) perCriticScores.set(c.critic, [...(perCriticScores.get(c.critic) ?? []), c.score]);
    }
    composites.push(scores);
    for (const [critic, s] of perCriticScores) raw.set(critic, [...(raw.get(critic) ?? []), s]);
    log?.(`${screen}: ${repeats} repeats, composite ${Math.min(...scores).toFixed(1)}..${Math.max(...scores).toFixed(1)}`);
  }

  const screens = reference.map((s) => s.screen);
  const { sigma, perCritic } = await recordCalibration(designDir, cfg, composites, raw, repeats, screens);
  return { sigma, perCritic, repeats, screens, usd: pricedTotal(cfg, llm, usage) };
}

/**
 * Turns the per-screen scores into sigma, and writes it where a run reads it: `calibration.json` (with the critic
 * mode it was measured in, so a run in the other mode is warned) and `config.json`'s `sigma`.
 */
async function recordCalibration(
  designDir: string, cfg: Config, composites: number[][], raw: Map<CriticName, number[][]>, repeats: number, screens: string[],
): Promise<{ sigma: number; perCritic: Record<string, number> }> {
  const sigma = withinScreenStd(composites);
  const perCritic: Record<string, number> = {};
  for (const [critic, perScreen] of raw) perCritic[critic] = withinScreenStd(perScreen);

  await writeEvidence(designDir, "calibration.json", {
    sigma,
    perCritic,
    repeats,
    screens,
    criticModel: cfg.models.critic,
    criticMode: cfg.criticMode,
    weights: cfg.weights,
    measuredAt: new Date().toISOString(),
  });
  // Re-read rather than reuse the parsed contract, so every field of the file survives untouched.
  const configPath = join(designDir, "config.json");
  const rawConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  rawConfig.sigma = sigma;
  await writeAtomic(configPath, JSON.stringify(rawConfig, null, 2) + "\n");
  return { sigma, perCritic };
}

/** Where agent-mode calibration keeps its inputs and the subagents' answers: `<screen>/vNN/` per repeat. */
export const agentCalibrationDir = (designDir: string): string => join(designDir, ".design-loop", "calibrate-agent");

export type AgentCalibration = ({ done: true } & CalibrationResult) | { done: false; workOrder: string };

/**
 * `calibrate` for `criticMode: "agent"`. The critics are subagents this process cannot call, so it works as `step`
 * does: every reference screen gets one directory per repeat holding what a critic reads, and while any answer is
 * missing it writes ONE work order naming every critic in every repeat and returns. Called again once they have
 * answered, it reads the answers back and measures sigma exactly as the API path does.
 *
 * Each repeat is a separate subagent reading identical inputs, so the spread between them is the noise an
 * agent-mode run's stop rule has to see past — which is what an API-mode sigma never measured.
 */
export async function calibrateAgent(opts: {
  designDir: string;
  repeats?: number;
  measure?: (html: string) => Promise<MeasuredDoc>;
  log?: (line: string) => void;
}): Promise<AgentCalibration> {
  const { designDir, log } = opts;
  const repeats = opts.repeats ?? DEFAULT_REPEATS;
  if (!Number.isInteger(repeats) || repeats < 2) {
    throw new Error(`repeats must be an integer >= 2 (got ${repeats}): one sample has no spread`);
  }
  const contract = await loadContract(designDir, {}, undefined, { allowNullSigma: true });
  const cfg = contract.config;
  if (cfg.criticMode !== "agent") throw new Error('calibrateAgent needs "criticMode": "agent"');
  const reference = await readReference(designDir);
  const measureDoc = opts.measure ?? measure;
  const workDir = agentCalibrationDir(designDir);

  const units: unknown[] = [];
  const composites: number[][] = [];
  const raw = new Map<CriticName, number[][]>();

  for (const { screen, html, png } of reference) {
    const doc = await measureDoc(html);
    const det = deterministicCritique(doc, contract.tokens);
    const digest = distill(doc);
    const measurements = det.critique.issues.filter((i) => !i.id.startsWith("det-token-"));
    const source = html.trimStart().startsWith("{") ? "screen.json" : "screen.html";
    const input: CriticInput = { contract, screen, digest, imagePng: png, openIssues: [], measurements };
    const screenDir = join(workDir, screen);
    const scores: number[] = [];
    const perCritic = new Map<CriticName, number[]>();

    for (let r = 0; r < repeats; r++) {
      const version = versionName(r);
      const dir = join(screenDir, version);
      await mkdir(join(dir, "inbox"), { recursive: true });
      await Promise.all([
        writeAtomic(join(dir, "digest.txt"), digest),
        writeAtomic(join(dir, "digest.json"), JSON.stringify(doc, null, 2)),
        writeAtomic(join(dir, "screen.png"), png),
        writeAtomic(join(dir, source), html),
        writeAtomic(join(dir, "carried-issues.json"), "[]\n"),
        writeAtomic(join(dir, "measurements.json"), JSON.stringify(measurements, null, 2)),
      ]);

      const client = new AgentLlmClient({ runDir: screenDir, cursor: { index: r } });
      const committee = await runCommittee(input, cfg, client);
      try {
        client.throwIfPending();
      } catch (err) {
        if (!(err instanceof WorkOrderPending)) throw err;
        const rel = (file: string): string => `${screen}/${version}/${file}`;
        for (const u of err.units) {
          units.push({
            critic: u.critic,
            agent: `design-loop-${u.critic}`,
            output: rel(`inbox/${u.critic}.json`),
            nextIssueId: u.nextIssueId,
            inputs: {
              digest: rel("digest.txt"),
              screenshot: rel("screen.png"),
              html: rel(source),
              // No screen spec: a reference screen is judged against the brief and tokens alone, as the API path does.
              screenSpec: null,
              brief: "brief.md",
              tokens: "tokens.json",
              carriedIssues: rel("carried-issues.json"),
              measurements: u.critic === "accessibility" ? rel("measurements.json") : null,
            },
          });
        }
        continue;
      }
      // Same refusal as the API path: a repeat scored on fewer critics is rescaled, which would inflate sigma.
      if (committee.failures.length > 0) {
        throw new Error(
          `calibration aborted: ${screen}, repeat ${r + 1}: ${committee.failures.map((f) => `${f.critic}: ${f.error}`).join("; ")}. ` +
            `Fix or re-dispatch that critic's answer under ${dir}/inbox/ and run calibrate again.`,
        );
      }
      const scored = [...committee.critiques, det.critique];
      scores.push(composite(scored, renormalise(cfg.weights, scored.map((c) => c.critic))));
      for (const c of committee.critiques) perCritic.set(c.critic, [...(perCritic.get(c.critic) ?? []), c.score]);
    }
    if (scores.length === repeats) {
      composites.push(scores);
      for (const [critic, s] of perCritic) raw.set(critic, [...(raw.get(critic) ?? []), s]);
      log?.(`${screen}: ${repeats} repeats, composite ${Math.min(...scores).toFixed(1)}..${Math.max(...scores).toFixed(1)}`);
    }
  }

  if (units.length > 0) {
    const file = join(workDir, "work-order.json");
    // Ordered as a run's work order is: by screen, repeat, then the committee's own critic order.
    const order = (u: any): string => `${u.output.split("/inbox/")[0]}/${LLM_CRITICS.indexOf(u.critic)}`;
    units.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
    await writeAtomic(file, `${JSON.stringify({
      kind: "critics",
      version: "calibration",
      screen: reference.map((s) => s.screen).join(", "),
      designDir: resolve(designDir),
      runDir: resolve(workDir),
      concurrency: 4,
      units,
    }, null, 2)}\n`);
    return { done: false, workOrder: file };
  }

  const screens = reference.map((s) => s.screen);
  const { sigma, perCritic } = await recordCalibration(designDir, cfg, composites, raw, repeats, screens);
  return { done: true, sigma, perCritic, repeats, screens, usd: null };
}

const contentWords = (claim: string): Set<string> =>
  new Set((claim.toLowerCase().match(/\p{L}+/gu) ?? []).filter((w) => w.length >= 4));

function claimsMatch(a: string, b: string): boolean {
  const x = contentWords(a);
  const y = contentWords(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  const union = x.size + y.size - shared;
  // With no content words on either side there is nothing to compare, so only identical text matches.
  if (union === 0) return a === b;
  return shared / union >= CLAIM_MATCH;
}

async function critiqueBoth(
  contract: Contract,
  ref: ReferenceScreen,
  llm: LlmClient,
  usage: Usage,
  progress: Progress,
): Promise<{ raw: AbIssue[]; digest: AbIssue[] }> {
  const doc = await measure(ref.html);
  const det = deterministicCritique(doc, contract.tokens);
  const base = {
    contract,
    screen: ref.screen,
    imagePng: ref.png,
    openIssues: [],
    measurements: det.critique.issues.filter((i) => !i.id.startsWith("det-token-")),
  };
  const run = async (what: string, digest: string): Promise<AbIssue[]> => {
    const committee = await progress.phase(
      `${ref.screen} ${what}`,
      () => runCommittee({ ...base, digest }, contract.config, llm, committeeHooks(progress, false)),
      (c) => `${c.critiques.length}/${c.critiques.length + c.failures.length} critics ok`,
    );
    addUsage(usage, llm.takeUsage?.());
    // A run with no critic would make every issue of the other run look "only" in it.
    if (committee.critiques.length === 0) {
      throw new Error(`committee unavailable: ${committee.failures.map((f) => `${f.critic}: ${f.error}`).join("; ")}`);
    }
    return committee.critiques.flatMap((c) => c.issues.map((i) => ({ critic: c.critic, severity: i.severity, claim: i.claim })));
  };
  const digestIssues = await run("digest critique", distill(doc));
  const rawIssues = await run("raw HTML critique", ref.html);
  return { raw: rawIssues, digest: digestIssues };
}

/**
 * One-off check that the digest loses no signal a critic needs: critique each reference screen on the digest
 * and on the raw HTML, and list the raw-HTML issues no digest issue's claim matches. Selectors are not compared
 * (a raw-HTML critique cites classes and tags, a digest critique measured selectors), and the list is a triage
 * aid for a human, not a verdict.
 */
export async function abDistiller(opts: {
  designDir: string;
  llm: LlmClient;
  log?: (line: string) => void;
  progress?: Progress;
}): Promise<AbResult> {
  const { designDir, llm, log } = opts;
  const progress = opts.progress ?? noProgress;
  const contract = await loadContract(designDir, {}, undefined, { allowNullSigma: true });
  const reference = await readReference(designDir);
  priceCheck(contract.config, llm);
  progress.header([
    `ab-distiller · design ${designDir}`,
    `${reference.length} reference screen${reference.length === 1 ? "" : "s"} x 2 critiques (digest, raw HTML) x 4 critics · critic ${contract.config.models.critic}`,
  ]);

  const usage = noUsage();
  const screens: AbResult["screens"] = [];
  for (const ref of reference) {
    const { raw, digest } = await critiqueBoth(contract, ref, llm, usage, progress);
    const rawOnly = raw.filter((r) => !digest.some((d) => claimsMatch(r.claim, d.claim)));
    screens.push({ screen: ref.screen, rawIssues: raw, digestIssues: digest, rawOnly });
    log?.(`${ref.screen}: ${raw.length} raw issues, ${digest.length} digest issues, ${rawOnly.length} raw only`);
  }

  const result: AbResult = { screens, usd: pricedTotal(contract.config, llm, usage) };
  await writeEvidence(designDir, "ab-distiller.json", {
    ...result,
    criticModel: contract.config.models.critic,
    measuredAt: new Date().toISOString(),
  });
  return result;
}
