import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFirstPrompt } from "./prompt.js";
import type { Generator, Screen } from "../stitch/adapter.js";
import type { Config, Contract } from "../types.js";
import type { Progress } from "./progress.js";

/**
 * The art directions a run fans out over, one per `## ` heading of `directions.md`. The prose under a
 * heading is appended to the first prompt; the heading itself is only a label for a human reader.
 * A missing file is not an error: a design folder that has not opted in runs one family with no rider.
 */
export async function readDirections(designDir: string): Promise<string[]> {
  const raw = await readFile(join(designDir, "directions.md"), "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (raw === null) return [];
  // Normalize line endings so CRLF files and LF files behave identically, and multi-paragraph
  // directions don't retain internal \r\n.
  const normalized = raw.replace(/\r\n/g, "\n");
  const out: string[] = [];
  for (const section of normalized.split(/^## .*$/m).slice(1)) {
    const prose = section.trim();
    if (prose !== "") out.push(prose);
  }
  return out;
}

export interface Candidate {
  id: string;
  family: number;
  prompt: string;
  handle: Screen;
}

export interface GenerateOptions {
  contract: Contract;
  screen: string;
  designDir: string;
  generator: Generator;
  cfg: Config;
  progress: Progress;
}

/**
 * One seed per family, then that family's variants of it. A family whose variants call fails keeps its
 * seed: losing four candidates to one 5xx is worse than running the stage with fewer, and the seed is
 * already paid for. A failed SEED is fatal — there is nothing to vary and nothing to iterate.
 */
export async function generateCandidates(opts: GenerateOptions): Promise<Candidate[]> {
  const { contract, screen, designDir, generator, cfg, progress } = opts;
  const directions = await readDirections(designDir);
  const base = buildFirstPrompt(contract, screen);
  const { families, variantsPerFamily, creativeRange, aspects } = cfg.candidates;
  const out: Candidate[] = [];

  for (let family = 0; family < families; family++) {
    const direction = directions[family];
    const prompt = direction ? `${base}\n\nArt direction: ${direction}` : base;
    const seed = await progress.phase(`stitch generate ${family + 1}/${families}`, () => generator.generate(prompt));
    out.push({ id: `c${out.length}`, family, prompt, handle: seed });
    if (variantsPerFamily === 0) continue;
    try {
      const made = await progress.phase(
        `stitch variants ${family + 1}/${families}`,
        () => generator.variants(seed, prompt, { variantCount: variantsPerFamily, creativeRange, aspects }),
        (v) => `${v.length} variant${v.length === 1 ? "" : "s"}`,
      );
      for (const handle of made) out.push({ id: `c${out.length}`, family, prompt, handle });
    } catch (err) {
      progress.warn(`family ${family + 1} variants failed, keeping its seed: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return out;
}
