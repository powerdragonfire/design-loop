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

const readIfThere = (file: string): Promise<string | null> =>
  readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });

/**
 * The art directions a run fans out over, one per `## ` heading. The prose under a heading is appended to the
 * first prompt; the heading itself is only a label for a human reader.
 *
 * `directions/<screen>.md` is read first, then the folder-wide `directions.md`. Directions are usually written
 * for one screen ("Tile grid … Account, Albums"), and a folder-wide file handed them to every screen in the
 * folder. A missing file is not an error: a design folder that has not opted in runs one family with no rider.
 *
 * `first` puts that direction first, keeping the rest in order after it: family 0 — the only family a Figma or
 * agent-mode run has — then takes it, so one run per direction (`run --direction N`) is how such a folder
 * explores its directions. Out of range is an error rather than a silent fall back to direction 0.
 */
export async function readDirections(designDir: string, screen?: string, first?: number): Promise<string[]> {
  const raw =
    (screen !== undefined ? await readIfThere(join(designDir, "directions", `${screen}.md`)) : null) ??
    (await readIfThere(join(designDir, "directions.md")));
  if (raw === null) return [];
  // Normalize line endings so CRLF files and LF files behave identically, and multi-paragraph
  // directions don't retain internal \r\n.
  const normalized = raw.replace(/\r\n/g, "\n");
  const out: string[] = [];
  for (const section of normalized.split(/^## .*$/m).slice(1)) {
    const prose = section.trim();
    if (prose !== "") out.push(prose);
  }
  if (first === undefined || first === 0) return out;
  if (!Number.isInteger(first) || first < 0 || first >= out.length) {
    throw new Error(
      `no direction ${first}: ${out.length === 0 ? "this screen has no directions" : `directions are numbered 0 to ${out.length - 1}`}`,
    );
  }
  return [...out.slice(first), ...out.slice(0, first)];
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
  /** The direction family 0 takes; see `readDirections`. */
  direction?: number;
}

/**
 * One seed per family, then that family's variants of it. A family whose variants call fails keeps its
 * seed: losing four candidates to one 5xx is worse than running the stage with fewer, and the seed is
 * already paid for. A failed SEED is fatal — there is nothing to vary and nothing to iterate.
 */
export async function generateCandidates(opts: GenerateOptions): Promise<Candidate[]> {
  const { contract, screen, designDir, generator, cfg, progress } = opts;
  const directions = await readDirections(designDir, screen, opts.direction);
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
  /**
   * `RunOptions.measure`, passed through. Without it the stage always rendered in Chromium, whatever the
   * caller injected: a replayed run re-rendered every candidate rather than read the stored doc.
   */
  measure?: (html: string) => Promise<MeasuredDoc>;
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
  const measureDoc = opts.measure ?? measure;
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
      doc = await measureDoc(html);
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
    // Before ANY read of `committee`: the CALLING CONTRACT on AgentLlmClient holds at every `runCommittee`
    // call site, not only the edit loop's. A pending critic and a failed one arrive here identically, so reading
    // first would mark a candidate that is only waiting as failed, and record each waiting critic as a
    // degradation. Unreachable in agent mode today (loadContract refuses a multi-candidate agent config, and
    // run.ts routes the single candidate around this stage) and a no-op for the API client. It is here so the
    // next change to either of those cannot quietly break the contract.
    opts.llm.throwIfPending?.();
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
