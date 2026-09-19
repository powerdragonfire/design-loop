import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadContract } from "../contract/load.js";
import { measure } from "../measure/measure.js";
import { deterministicCritique } from "../critics/deterministic.js";
import { distill } from "../distill/distill.js";
import { runCommittee, type CriticInput, type LlmClient } from "../critics/llm.js";
import { composite, renormalise } from "../scoring/score.js";
import { writeAtomic } from "../store/store.js";
import { costUsd } from "./pricing.js";
import type { Config, Contract, CriticName, Usage } from "../types.js";

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

/** Every `<name>.html` under `<designDir>/reference/` with the `<name>.png` beside it, sorted by name. */
async function readReference(designDir: string): Promise<ReferenceScreen[]> {
  const refDir = join(designDir, "reference");
  const files = await readdir(refDir).catch(() => [] as string[]);
  const names = files.filter((f) => f.endsWith(".html")).map((f) => basename(f, ".html")).sort();
  if (names.length === 0) throw new Error(`no reference screens in ${refDir}`);
  const screens: ReferenceScreen[] = [];
  for (const screen of names) {
    const png = await readFile(join(refDir, `${screen}.png`)).catch(() => {
      throw new Error(`reference screen ${screen}.html has no ${screen}.png beside it`);
    });
    screens.push({ screen, html: await readFile(join(refDir, `${screen}.html`), "utf8"), png });
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
}): Promise<CalibrationResult> {
  const { designDir, llm, log } = opts;
  const repeats = opts.repeats ?? DEFAULT_REPEATS;
  if (!Number.isInteger(repeats) || repeats < 2) {
    throw new Error(`repeats must be an integer >= 2 (got ${repeats}): one sample has no spread`);
  }
  const contract = await loadContract(designDir, {}, undefined, { allowNullSigma: true });
  const cfg = contract.config;
  const reference = await readReference(designDir);
  priceCheck(cfg, llm);

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
    for (let r = 0; r < repeats; r++) {
      const committee = await runCommittee(input, cfg, llm);
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

  const sigma = withinScreenStd(composites);
  const perCritic: Record<string, number> = {};
  for (const [critic, perScreen] of raw) perCritic[critic] = withinScreenStd(perScreen);
  const screens = reference.map((s) => s.screen);

  await writeEvidence(designDir, "calibration.json", {
    sigma,
    perCritic,
    repeats,
    screens,
    criticModel: cfg.models.critic,
    weights: cfg.weights,
    measuredAt: new Date().toISOString(),
  });
  // Re-read rather than reuse the parsed contract, so every field of the file survives untouched.
  const configPath = join(designDir, "config.json");
  const rawConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  rawConfig.sigma = sigma;
  await writeAtomic(configPath, JSON.stringify(rawConfig, null, 2) + "\n");

  return { sigma, perCritic, repeats, screens, usd: pricedTotal(cfg, llm, usage) };
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
  const run = async (digest: string): Promise<AbIssue[]> => {
    const committee = await runCommittee({ ...base, digest }, contract.config, llm);
    addUsage(usage, llm.takeUsage?.());
    // A run with no critic would make every issue of the other run look "only" in it.
    if (committee.critiques.length === 0) {
      throw new Error(`committee unavailable: ${committee.failures.map((f) => `${f.critic}: ${f.error}`).join("; ")}`);
    }
    return committee.critiques.flatMap((c) => c.issues.map((i) => ({ critic: c.critic, severity: i.severity, claim: i.claim })));
  };
  const digestIssues = await run(distill(doc));
  const rawIssues = await run(ref.html);
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
}): Promise<AbResult> {
  const { designDir, llm, log } = opts;
  const contract = await loadContract(designDir, {}, undefined, { allowNullSigma: true });
  const reference = await readReference(designDir);
  priceCheck(contract.config, llm);

  const usage = noUsage();
  const screens: AbResult["screens"] = [];
  for (const ref of reference) {
    const { raw, digest } = await critiqueBoth(contract, ref, llm, usage);
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
