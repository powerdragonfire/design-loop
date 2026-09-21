import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFirstPrompt } from "./prompt.js";
import type { Generator, Screen } from "../stitch/adapter.js";
import type { Config, Contract, CriticName, Critique, Issue, MeasuredDoc } from "../types.js";
import { errorText, type Progress } from "./progress.js";
import { measure } from "../measure/measure.js";
import { distill } from "../distill/distill.js";
import { deterministicCritique } from "../critics/deterministic.js";
import { runCommittee, type LlmClient } from "../critics/llm.js";
import { validateEvidence } from "../evidence/validate.js";
import { composite, gate, openIssues, renormalise } from "../scoring/score.js";

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

    // The try wraps only the call, not the push loop below: a bug in the loop must surface as
    // itself, not be swallowed as an indistinguishable "variants failed" warning.
    let made: Screen[] | null = null;
    try {
      made = await progress.phase(
        `stitch variants ${family + 1}/${families}`,
        () => generator.variants(seed, prompt, { variantCount: variantsPerFamily, creativeRange, aspects }),
        (v) => `${v.length} variant${v.length === 1 ? "" : "s"}`,
      );
    } catch (err) {
      progress.warn(`family ${family + 1} variants failed, keeping its seed: ${errorText(err)}`);
    }
    if (made) for (const handle of made) out.push({ id: `c${out.length}`, family, prompt, handle });
  }
  return out;
}

export interface CandidateRow {
  id: string;
  family: number;
  composite: number;
  blockers: number;
  gatePass: boolean;
  png: Buffer;
  html: string;
  doc: MeasuredDoc;
  critiques: Critique[];
  open: Issue[];
  /**
   * Per-critic evidence hallucination rate for THIS candidate alone (see `validateEvidence`). Empty
   * when nothing was validated: a candidate that never reached the committee, whether because it
   * could not be measured or because the committee itself failed, has no critiques to check evidence
   * against.
   */
  hallucinationRate: Partial<Record<CriticName, number>>;
  prompt: string;
  handle: Screen;
  failed?: string;
}

export interface Selection {
  winner: CandidateRow;
  rows: CandidateRow[];
}

export type SelectOptions = GenerateOptions & {
  llm: LlmClient;
  sigma: number;
  onDegraded(critic: CriticName, error: string, id: string): void;
  /**
   * Called once per candidate, in generation order, as soon as that candidate is fully scored (or
   * marked failed) — before the next candidate starts and, critically, before `pickWinner` runs.
   * `pickWinner` throws when every candidate fails, and every candidate has already been generated
   * and paid for by then; a caller that persists from here (as run.ts does) keeps every candidate on
   * disk even when that throw stops `selectCandidate` from ever returning.
   */
  onCandidate?(row: CandidateRow): Promise<void> | void;
};

/** The numeric suffix of a `c<N>` candidate id, so "c10" sorts after "c2" rather than before it. */
const candidateNumber = (id: string): number => Number(id.slice(1));

/**
 * Composite is a weighted mean of critic opinion; the gate is a count of blockers. Selecting on
 * composite alone can hand the loop a candidate that reads better and gates worse, and the chair
 * never sees the blockers it did not inherit. So: everything within one sigma of the leader is a tie,
 * and a tie is broken by the cleaner screen.
 *
 * Read `blockers` as "deterministic blockers" whenever evidence validation is dropping the critics'
 * issues; see the caveat in the design doc.
 */
export function pickWinner(rows: CandidateRow[], sigma: number): CandidateRow {
  const scored = rows.filter((r) => r.failed === undefined);
  // Every row's own `failed` already names its critic and cause; losing that here would leave an operator
  // staring at "every committee failed" with no way to tell an expired API key from a genuine outage.
  if (scored.length === 0) {
    const why = rows.map((r) => `${r.id}: ${r.failed}`).join("; ");
    throw new Error(`no candidate could be scored: ${why}`);
  }
  const leader = Math.max(...scored.map((r) => r.composite));
  const tied = scored.filter((r) => r.composite >= leader - sigma);
  return tied.sort((a, b) => a.blockers - b.blockers || b.composite - a.composite || candidateNumber(a.id) - candidateNumber(b.id))[0]!;
}

/**
 * Scores every candidate and picks the winner. Candidates are scored one at a time, not in parallel:
 * runCommittee already fans out four critics per candidate, and six candidates at once would be
 * twenty-four concurrent calls into the same rate limit.
 */
export async function selectCandidate(opts: SelectOptions): Promise<Selection> {
  const candidates = await generateCandidates(opts);
  const rows: CandidateRow[] = [];
  const record = async (row: CandidateRow): Promise<void> => {
    rows.push(row);
    await opts.onCandidate?.(row);
  };
  for (const c of candidates) {
    const [html, png] = [await c.handle.getHtml(), await c.handle.getImage()];
    const base = { id: c.id, family: c.family, prompt: c.prompt, handle: c.handle, png, html };
    // A candidate measure() cannot parse is exactly as unusable as one whose committee fails, and no
    // more fatal: the stage already paid for it, so it is marked failed and the rest still run,
    // rather than one malformed screen losing every candidate's spend.
    let doc: MeasuredDoc;
    try {
      doc = await measure(html);
    } catch (err) {
      await record({
        ...base,
        doc: { viewport: { w: 0, h: 0 }, nodes: [] },
        composite: 0, blockers: 0, gatePass: false, critiques: [], open: [], hallucinationRate: {},
        failed: `could not be measured: ${errorText(err)}`,
      });
      continue;
    }
    const det = deterministicCritique(doc, opts.contract.tokens);
    const committee = await runCommittee(
      {
        contract: opts.contract,
        screen: opts.screen,
        digest: distill(doc),
        imagePng: png,
        openIssues: [],
        measurements: det.critique.issues.filter((i) => !i.id.startsWith("det-token-")),
      },
      opts.cfg,
      opts.llm,
    );
    for (const f of committee.failures) opts.onDegraded(f.critic, f.error, c.id);
    if (committee.critiques.length === 0) {
      await record({
        ...base, doc, composite: 0, blockers: 0, gatePass: false, critiques: [], open: [], hallucinationRate: {},
        failed: `committee unavailable: ${committee.failures.map((f) => `${f.critic}: ${f.error}`).join("; ")}`,
      });
      continue;
    }
    const validated = validateEvidence(committee.critiques, doc);
    const critiques = [...validated.critiques, det.critique];
    const open = openIssues(critiques);
    await record({
      ...base,
      doc,
      critiques,
      open,
      hallucinationRate: validated.hallucinationRate,
      // A critic dropped upstream is simply absent here; the weights of the survivors are
      // renormalised to 1 so a partial committee scores instead of throwing (see run.ts's
      // scoring round, which the same rule protects).
      composite: composite(critiques, renormalise(opts.cfg.weights, critiques.map((cr) => cr.critic))),
      blockers: open.filter((i) => i.severity === "blocker").length,
      gatePass: gate(critiques, det.measurementsPass).pass,
    });
  }
  return { winner: pickWinner(rows, opts.sigma), rows };
}
