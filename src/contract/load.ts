import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import type { Config, Contract } from "../types.js";

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

const ConfigSchema = z.strictObject({
  sigma: z.number().nonnegative().nullable(),
  maxRounds: z.number().int().positive(),
  convergenceSigmas: z.number().nonnegative(),
  convergenceRounds: z.number().int().positive(),
  models: z.strictObject({ critic: z.string().min(1), chair: z.string().min(1) }),
  weights: z.strictObject({
    typography: z.number().nonnegative(),
    behavioural: z.number().nonnegative(),
    accessibility: z.number().nonnegative(),
    tokenConformance: z.number().nonnegative(),
    feasibility: z.number().nonnegative(),
  }),
  batchMode: z.boolean(),
});

const WEIGHT_EPSILON = 1e-9;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// A null override wins over the base value (that is how a caller nulls out sigma);
// only undefined means "no override".
function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (isPlainObject(base) && isPlainObject(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const key of Object.keys(over)) out[key] = deepMerge(base[key], over[key]);
    return out;
  }
  return over;
}

async function readJson(path: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`cannot read ${label}: ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${(e as Error).message}`);
  }
}

async function readScreens(dir: string): Promise<Record<string, string>> {
  const screensDir = join(dir, "screens");
  let files: string[];
  try {
    files = await readdir(screensDir);
  } catch {
    return {};
  }
  const screens: Record<string, string> = {};
  for (const file of files.filter((f) => extname(f) === ".md").sort()) {
    screens[basename(file, ".md")] = await readFile(join(screensDir, file), "utf8");
  }
  return screens;
}

/**
 * Load and validate a design/ folder. Validation runs cheapest-and-most-fundamental first
 * so that nothing downstream can spend money before a bad contract fails:
 * config parses -> weights sum to 1.0 -> batchMode off -> sigma measured -> screen exists.
 */
export async function loadContract(
  dir: string,
  overrides: DeepPartial<Config> = {},
  requireScreen?: string,
  opts: { allowNullSigma?: boolean } = {},
): Promise<Contract> {
  const rawConfig = await readJson(join(dir, "config.json"), "config.json");
  const parsed = ConfigSchema.safeParse(deepMerge(rawConfig, overrides));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid config.json: ${detail}`);
  }
  const config: Config = parsed.data;

  const sum = Object.values(config.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > WEIGHT_EPSILON) {
    throw new Error(`weights must sum to 1.0, got ${Number(sum.toPrecision(12))}`);
  }

  if (config.batchMode) {
    throw new Error("batchMode is not implemented in v1");
  }

  if (config.sigma === null && !opts.allowNullSigma) {
    throw new Error("sigma is null — run `design-loop calibrate` first");
  }

  const tokens = await readJson(join(dir, "tokens.json"), "tokens.json");
  if (!isPlainObject(tokens)) {
    throw new Error("tokens.json must be a JSON object");
  }
  const brief = await readFile(join(dir, "brief.md"), "utf8").catch(() => {
    throw new Error(`cannot read brief.md: ${join(dir, "brief.md")}`);
  });
  const screens = await readScreens(dir);

  if (requireScreen !== undefined && !Object.hasOwn(screens, requireScreen)) {
    throw new Error(`no screen spec: ${requireScreen}`);
  }

  return { tokens, brief, config, screens };
}
