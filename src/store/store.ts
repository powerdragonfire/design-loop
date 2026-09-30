import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Critique, Issue, MeasuredDoc } from "../types.js";
import type { StopReason } from "../scoring/stop.js";

export interface Spend {
  stitchGenerations: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** null when the critics were subagents: their tokens never reach this process, so there is nothing to price. */
  usd: number | null;
  /** Which mode produced this spend, so a reader of the manifest alone can tell a real zero from an unmetered run. */
  criticMode: "api" | "agent";
}

/** A critic dropped from a round, with its cause, so a round is never silently scored on fewer critics (spec §14). */
export interface Degradation {
  version: string;
  critic: string;
  error: string;
}

export interface VersionInput {
  index: number;
  png: Buffer;
  html: string;
  doc: MeasuredDoc;
  critiques: Critique[];
  composite: number;
  gatePass: boolean;
  /** The edit prompt that produced this version. */
  prompt: string;
  /** The issues still open after the gate; not recomputable once carry-forward exists. */
  openIssues: Issue[];
  /**
   * The version this one was edited from; null (or absent) for the first. After a regression that is the best
   * version, not the previous one, so the issue lifecycle on the review page is measured against it.
   */
  parent?: string | null;
  /**
   * The chair changes the edit that PRODUCED this version was asked to make: `applied` after the three-change
   * cap, `requested` how many the chair named before it. Absent for a version no chair edit produced (round 0).
   * Without it a regression cannot be read back: nothing else records what a round was trying to fix.
   */
  changes?: { requested: number; applied: Issue[] };
  /** The Stitch screen id, so a later step can rebuild the handle without a network call. */
  screenId?: string;
  /** `distill(doc)`, the text the critics actually read. */
  digest?: string;
  /** The issues carried in from earlier rounds. */
  carriedIssues?: Issue[];
  /** Deterministic findings; the accessibility critic alone is shown these. */
  measurements?: Issue[];
}

export interface GeneratedInput {
  png: Buffer;
  html: string;
  doc: MeasuredDoc;
  /** The edit prompt that produced this version. */
  prompt: string;
  /** The Stitch screen id, so a later step can rebuild the handle without a network call. */
  screenId?: string;
  parent?: string | null;
}

export interface CommitteeInputs {
  /** `distill(doc)`, the text the critics actually read. */
  digest: string;
  /** The issues carried in from earlier rounds. */
  carriedIssues: Issue[];
  /** Deterministic findings; the accessibility critic alone is shown these. */
  measurements: Issue[];
}

export interface ScoredInput {
  /** The scored critiques: validated, resolutions promoted, deterministic critique included. */
  critiques: Critique[];
  /**
   * The committee's answers exactly as they arrived, BEFORE `validateEvidence` dropped the issues whose
   * selectors are absent from the measured document. Written to `critiques-raw/`, and it is what a replayed
   * round is served — the same reason `writeChair` archives the chair's answer before `chair()`'s cap is
   * applied: **replay must reproduce the computation, not its result.** `validateEvidence` re-drops the same
   * issues and recounts the same hallucination rate; handed the validated copy it would find nothing to drop
   * and record 0, and `manifest.json`'s `hallucinationRate` would fall by a factor of the number of rounds
   * replayed. That number is the instrumented success criterion for agent mode, so it has to survive a resume.
   *
   * Optional because the one-shot `writeVersion` path has no separate raw form — the critiques it is handed
   * have not been through `validateEvidence`, so they already ARE the raw answers. A caller that validates
   * before writing, as the loop does, must pass both.
   */
  rawCritiques?: Critique[];
  composite: number;
  gatePass: boolean;
  openIssues: Issue[];
  changes?: { requested: number; applied: Issue[] };
}

/** A claimed but not-yet-scored version directory: the shape an agent critic needs before it can critique anything. */
export interface VersionHandle {
  version: string;
  dir: string;
  writeGenerated(g: GeneratedInput): Promise<void>;
  writeCommitteeInputs(i: CommitteeInputs): Promise<void>;
  finish(f: ScoredInput): Promise<void>;
}

/** The payload every screen directory holds, whether it lands under a run's root (a version) or under `candidates/`. */
type ScreenPayload = Omit<VersionInput, "index" | "parent" | "changes">;

/**
 * The same payload a version takes, keyed by a candidate id instead of a round index. Keeping the shape
 * identical to `ScreenPayload` is what makes `promoteCandidate` a plain recursive copy: a candidate and
 * the version it becomes are, on disk, the same directory.
 */
export interface CandidateInput extends ScreenPayload {
  id: string;
  family: number;
}

/** A summary of one scored candidate, enough to render a selection without re-reading every candidate directory. */
export interface CandidateSummary {
  id: string;
  family: number;
  composite: number;
  blockers: number;
  gatePass: boolean;
  failed?: string;
}

export interface SelectionInput {
  winner: string;
  rows: CandidateSummary[];
}

export interface Finalisation {
  /** "aborted" is a run cut short by a Stitch, quota or chair failure; every version already written is kept (spec §14). */
  stopReason: StopReason | "aborted";
  abortReason?: string;
  committeeRank: string[];
  spend: Spend;
  hallucinationRate: Record<string, number>;
  degradations: Degradation[];
  /** The noise floor the run's stopping behaviour was judged against (spec §18). */
  sigma: number;
  /**
   * The calibration that sigma came from, so a later reader can tell whether this run's stopping rule rested
   * on a measurement or on a hand-typed number (spec §18 step 3), and notice a stale one (spec §16 risk 2).
   * `null` records that no calibration was found; it is never simply left out.
   */
  calibration?: { sigma: number; criticModel: string; weights: Record<string, number>; measuredAt: string } | null;
  /**
   * The candidate stage's own rows and the one it picked, kept at the manifest's top level too (not only
   * in `candidates/selection.json`) so a reader of manifest.json alone sees the whole stage. Optional
   * because a caller with no candidate stage of its own — today, only tests exercising `finalise` in
   * isolation — never has this to give; `finalise` then records an empty stage rather than omitting it.
   */
  candidates?: CandidateSummary[];
  selection?: SelectionInput | null;
}

export interface Run {
  /** The run directory, claimed by this call and by nothing else. */
  dir: string;
  /** Claims `vNN` before anything about it is known, so an agent critic has somewhere to read from and write to. */
  openVersion(index: number): Promise<VersionHandle>;
  /**
   * Adopts a `vNN` this process did not claim: the suspend state of an agent-mode run, where an earlier
   * process claimed the directory, wrote everything the critics read, and exited waiting for their answers.
   *
   * Deliberately NOT a tolerant `openVersion`. That call's claim-or-fail contract is what makes two live
   * handles for one index impossible, and `openRun`'s `-2`/`-3` collision suffixes rest on the same
   * non-recursive-mkdir claim; loosening it would quietly turn a colliding run into an overwriting one. A
   * caller that means to re-enter a directory says so by name, and this refuses anything that is not that
   * state: a version that does not exist, or one already scored.
   */
  reopenVersion(index: number): Promise<VersionHandle>;
  /** Returns the version directory name, e.g. "v00". */
  writeVersion(v: VersionInput): Promise<string>;
  /** Writes `candidates/<id>/`. Returns the candidate id. */
  writeCandidate(c: CandidateInput): Promise<string>;
  /** Writes `candidates/selection.json`, the record of which candidate won and why. */
  writeSelection(s: SelectionInput): Promise<void>;
  /**
   * Copies `candidates/<id>/` to `v00/` and registers it as a version. Returns `"v00"`. `v00` is given
   * what every other version directory carries and a candidate directory does not: the Stitch screen id the
   * resume layer rebuilds its handle from, and the committee's inputs. Both are optional only so the store's
   * own tests can promote a bare candidate.
   */
  promoteCandidate(id: string, version?: { screenId?: string; inputs?: CommitteeInputs }): Promise<string>;
  finalise(m: Finalisation): Promise<void>;
  /** Accepts a version id (`vNN`) or a written candidate id (`cN`). */
  approve(id: string): Promise<void>;
}

interface VersionSummary {
  version: string;
  composite: number;
  gatePass: boolean;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The file a screen's source is kept in. A Stitch screen is HTML; a Figma frame is its node tree as JSON, and
 * naming that `screen.html` told every critic who opened it to expect markup. Chosen by content, so the store
 * need not know which generator made it.
 */
export const sourceFile = (source: string): "screen.html" | "screen.json" =>
  source.trimStart().startsWith("{") ? "screen.json" : "screen.html";

/** Both names a screen's source may have: runs written before `screen.json` existed kept Figma JSON as `.html`. */
export const SOURCE_FILES = ["screen.html", "screen.json"] as const;

/** The stored source in `dir`, whichever name it has, or null when there is none. */
export async function readSource(dir: string): Promise<{ file: string; content: string } | null> {
  for (const name of SOURCE_FILES) {
    const content = await readFile(join(dir, name), "utf8").catch((err: NodeJS.ErrnoException) =>
      err.code === "ENOENT" ? null : Promise.reject(err));
    if (content !== null) return { file: name, content };
  }
  return null;
}

/** The on-disk name for a version index, e.g. 3 -> "v03". */
export function versionName(index: number): string {
  return `v${String(index).padStart(2, "0")}`;
}

/**
 * Which round the loop is on. The resuming generator sets it; the agent critic and chair clients read it to
 * find the version directory they belong to. `runScreen` performs exactly one generate-or-edit per round, in
 * order, so a counter incremented there IS the current version index. Nothing else may write to it.
 *
 * It lives here, beside `versionName`, rather than in the resume layer: the clients that read it sit below the
 * CLI, and making them import from `src/cli/` would invert the layering.
 */
export interface RoundCursor {
  index: number;
}

const isExists = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "EEXIST";

/** True/false for a file that is or is not there; any other failure is a real one and is not swallowed. */
const fileExists = async (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
      throw err;
    },
  );

/** Refuses a name that could point outside the runs directory. */
function assertSegment(what: string, value: string): void {
  if (value === "" || value === "." || value === ".." || /[/\\\0]/.test(value)) {
    throw new Error(`Invalid ${what} ${JSON.stringify(value)}: it becomes part of a directory name`);
  }
}

/** The temp file sits beside its target: rename is only atomic within one filesystem. */
export async function writeAtomic(file: string, content: string | Uint8Array): Promise<void> {
  const tmp = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, content);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

type Manifest = Record<string, unknown> & { committeeRank: string[] };

/**
 * Writes the directory layout shared by every version and candidate: `screen.png`, `screen.html`,
 * `digest.json`, `composite.json`, `prompt.txt`, `open-issues.json` and one file per critique. A version
 * and a candidate hold identical payloads, so this is the only place that layout is spelled out — if
 * `writeVersion` and `writeCandidate` ever wrote it differently, `promoteCandidate`'s plain recursive
 * copy would silently produce a malformed version directory.
 */
async function writeScreenDir(base: string, p: ScreenPayload): Promise<void> {
  try {
    await mkdir(base);
  } catch (err) {
    if (isExists(err)) throw new Error(`${basename(base)} already exists`);
    throw err;
  }
  await mkdir(join(base, "critiques"));
  await Promise.all([
    writeFile(join(base, "screen.png"), p.png),
    writeFile(join(base, sourceFile(p.html)), p.html),
    writeFile(join(base, "digest.json"), json(p.doc)),
    writeFile(join(base, "composite.json"), json({ composite: p.composite, gatePass: p.gatePass })),
    writeFile(join(base, "prompt.txt"), p.prompt),
    writeFile(join(base, "open-issues.json"), json(p.openIssues)),
    ...p.critiques.map((c) => writeFile(join(base, "critiques", `${c.critic}.json`), json(c))),
  ]);
}

/**
 * Builds a Run over `dir` from what is already known; `openRun` starts empty, `openExistingRun` rebuilds
 * both `versions` and `knownCandidates` from disk, since a fresh process is the only way the CLI ever
 * approves anything.
 */
function makeRun(
  dir: string,
  screen: string,
  date: string,
  versions: VersionSummary[],
  existing: Manifest | null,
  knownCandidates: string[] = [],
): Run {
  let manifest = existing;
  const manifestFile = join(dir, "manifest.json");
  const written = (version: string): boolean => versions.some((s) => s.version === version);
  // Populated as writeCandidate runs (and seeded from disk on reopen), so approve can recognise a
  // candidate id without it ever appearing in `versions` — that list stays reserved for what
  // finalise's committeeRank checks against.
  const candidateIds: string[] = [...knownCandidates];

  /** The two entry points agree on what may be written at all; only how the directory is obtained differs. */
  const writable = (index: number): string => {
    if (!Number.isInteger(index) || index < 0 || index > 99) {
      throw new Error(`Invalid version index ${index}: expected an integer from 0 to 99`);
    }
    if (manifest) throw new Error("Cannot write a version: the run is finalised");
    return versionName(index);
  };

  // Hoisted rather than referenced as `this.openVersion` from within the returned object literal: relying on
  // `this` there is fragile if `Run` is ever destructured, and `writeVersion` needs to call it too.
  const openVersion = async (index: number): Promise<VersionHandle> => {
    const version = writable(index);
    const base = join(dir, version);
    try {
      await mkdir(base);
    } catch (err) {
      if (isExists(err)) throw new Error(`version ${version} already exists`);
      throw err;
    }
    await mkdir(join(base, "critiques"));
    await mkdir(join(base, "inbox"));
    return handleFor(version, base);
  };

  /**
   * Re-enters a directory an earlier process claimed and did not score. It refuses a version that is missing
   * (nothing was claimed, so `openVersion` is the call) and one that is scored (rewriting it would change a
   * past score), which leaves exactly the suspend state. The subdirectories are remade tolerantly: a claim
   * that died between the three `mkdir`s left them behind, and there is nothing to lose by restoring them.
   */
  const reopenVersion = async (index: number): Promise<VersionHandle> => {
    const version = writable(index);
    const base = join(dir, version);
    const there = await stat(base).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
      throw err;
    });
    if (!there?.isDirectory()) throw new Error(`no such version ${version} to reopen`);
    if (await fileExists(join(base, "composite.json"))) {
      throw new Error(`version ${version} is already scored: it cannot be reopened`);
    }
    await mkdir(join(base, "critiques"), { recursive: true });
    await mkdir(join(base, "inbox"), { recursive: true });
    return handleFor(version, base);
  };

  const handleFor = (version: string, base: string): VersionHandle => {
    return {
      version,
      dir: base,

      async writeGenerated(g) {
        if (g.parent != null && !written(g.parent)) throw new Error(`no such version ${g.parent} as the parent`);
        await Promise.all([
          writeFile(join(base, "screen.png"), g.png),
          writeFile(join(base, sourceFile(g.html)), g.html),
          writeFile(join(base, "digest.json"), json(g.doc)),
          writeFile(join(base, "prompt.txt"), g.prompt),
          ...(g.screenId ? [writeFile(join(base, "screen-id.txt"), g.screenId)] : []),
          ...(g.parent != null ? [writeFile(join(base, "parent.txt"), g.parent)] : []),
        ]);
      },

      async writeCommitteeInputs(i) {
        await Promise.all([
          writeFile(join(base, "digest.txt"), i.digest),
          writeFile(join(base, "carried-issues.json"), json(i.carriedIssues)),
          writeFile(join(base, "measurements.json"), json(i.measurements)),
        ]);
      },

      async finish(f) {
        const duplicate = (list: Critique[]): string | undefined => {
          const critics = list.map((c) => c.critic);
          return critics.find((c, n) => critics.indexOf(c) !== n);
        };
        // The raw list is checked too: both are written one file per critic, so a duplicate there would
        // silently overwrite rather than be caught, and the replay would read whichever landed last.
        const dup = duplicate(f.critiques) ?? duplicate(f.rawCritiques ?? []);
        if (dup !== undefined) throw new Error(`duplicate critique for ${dup}`);
        // Made only when there is something to put in it, so a version written by the one-shot path does not
        // grow an empty directory that implies a raw record it never kept.
        if (f.rawCritiques?.length) await mkdir(join(base, "critiques-raw"), { recursive: true });
        await Promise.all([
          writeFile(join(base, "composite.json"), json({ composite: f.composite, gatePass: f.gatePass })),
          writeFile(join(base, "open-issues.json"), json(f.openIssues)),
          ...f.critiques.map((c) => writeFile(join(base, "critiques", `${c.critic}.json`), json(c))),
          // A sibling DIRECTORY, not `critiques/<critic>.raw.json`. Two things already read `critiques/` as a
          // whole: `report.ts` globs `*.json` there and would render every raw copy as an extra critique, and
          // a work order hands that directory to the chair agent — which would then see the very issues
          // `validateEvidence` threw out as invented. Keeping the raw record out of that directory costs
          // nothing and means neither reader has to learn a filename exception.
          ...(f.rawCritiques ?? []).map((c) => writeFile(join(base, "critiques-raw", `${c.critic}.json`), json(c))),
          ...(f.changes
            ? [writeFile(join(base, "changes.json"), json({
                requested: f.changes.requested,
                applied: f.changes.applied.map((i) => ({
                  id: i.id, severity: i.severity, effort: i.effort, claim: i.claim, fix: i.fix,
                  selector: i.evidence.selector,
                })),
              }))]
            : []),
        ]);
        // A claimed-but-unscored version is not yet a version: it must not appear in the manifest's `versions`
        // list or be a valid `parent` until it has actually been scored.
        versions.push({ version, composite: f.composite, gatePass: f.gatePass });
      },
    };
  };

  return {
    dir,

    openVersion,

    reopenVersion,

    async writeVersion(v) {
      const handle = await openVersion(v.index);
      await handle.writeGenerated({ png: v.png, html: v.html, doc: v.doc, prompt: v.prompt, screenId: v.screenId, parent: v.parent });
      if (v.digest !== undefined) {
        await handle.writeCommitteeInputs({ digest: v.digest, carriedIssues: v.carriedIssues ?? [], measurements: v.measurements ?? [] });
      }
      await handle.finish({ critiques: v.critiques, composite: v.composite, gatePass: v.gatePass, openIssues: v.openIssues, changes: v.changes });
      return handle.version;
    },

    async writeCandidate(c) {
      assertSegment("candidate id", c.id);
      // candidates/ may not exist yet on the first candidate of a run; writeScreenDir's mkdir(base)
      // is deliberately non-recursive so it still catches a genuine re-write of the same id.
      await mkdir(join(dir, "candidates"), { recursive: true });
      const base = join(dir, "candidates", c.id);
      await writeScreenDir(base, c);
      await writeAtomic(join(base, "family.txt"), String(c.family));
      candidateIds.push(c.id);
      return c.id;
    },

    async writeSelection(s) {
      await mkdir(join(dir, "candidates"), { recursive: true });
      await writeAtomic(join(dir, "candidates", "selection.json"), json(s));
    },

    /**
     * Copies rather than moves: `v00` must stay a complete version directory so `report`, `approve` and
     * the stop rule need no knowledge of candidates, and the candidate must stay readable in the
     * gallery. Registering `v00` in `versions` (not just writing it to disk) is what lets `finalise`
     * validate a committeeRank that names it and `approve("v00")` find it afterwards.
     */
    async promoteCandidate(id, extra = {}) {
      assertSegment("candidate id", id);
      const src = join(dir, "candidates", id);
      let summary: { composite: number; gatePass: boolean };
      try {
        summary = await parseFile(join(src, "composite.json"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`no such candidate ${id}`);
        throw err;
      }
      const dest = join(dir, "v00");
      // Claims v00 the same way writeVersion claims a version directory: a plain mkdir, so a second
      // promotion in the same run fails loudly instead of cp merging into (and versions gaining a
      // duplicate entry for) an already-complete v00.
      try {
        await mkdir(dest);
      } catch (err) {
        if (isExists(err)) throw new Error("version v00 already exists");
        throw err;
      }
      await cp(src, dest, { recursive: true });
      // Written into v00 alone, not into the candidate: these are what make it a version like any other —
      // `resumingGenerator` reads `screen-id.txt` to replay v00 instead of paying Stitch for a different
      // screen, and the committee inputs are the same three files `writeCommitteeInputs` leaves in every vNN.
      // Written before `versions.push`, so a v00 that is registered is also complete.
      const { screenId, inputs } = extra;
      await Promise.all([
        ...(screenId ? [writeFile(join(dest, "screen-id.txt"), screenId)] : []),
        ...(inputs
          ? [
              writeFile(join(dest, "digest.txt"), inputs.digest),
              writeFile(join(dest, "carried-issues.json"), json(inputs.carriedIssues)),
              writeFile(join(dest, "measurements.json"), json(inputs.measurements)),
            ]
          : []),
      ]);
      versions.push({ version: "v00", composite: summary.composite, gatePass: summary.gatePass });
      return "v00";
    },

    async finalise(m) {
      if (manifest) throw new Error("run is already finalised");
      if (m.committeeRank.length === 0) throw new Error("committeeRank is empty: a run needs a best version");
      for (const version of m.committeeRank) {
        if (!written(version)) throw new Error(`no such version ${version} in committeeRank`);
      }
      const next = structuredClone({
        screen,
        date,
        stopReason: m.stopReason,
        abortReason: m.abortReason,
        committeeRank: m.committeeRank,
        best: m.committeeRank[0],
        versions,
        spend: m.spend,
        hallucinationRate: m.hallucinationRate,
        degradations: m.degradations,
        sigma: m.sigma,
        calibration: m.calibration ?? null,
        candidates: m.candidates ?? [],
        selection: m.selection ?? null,
      });
      await writeAtomic(manifestFile, json(next));
      manifest = next;
    },

    async approve(id) {
      assertSegment("id", id);
      if (!manifest) throw new Error("run is not finalised: finalise it before approving a version");
      const isVersion = written(id);
      if (!isVersion && !candidateIds.includes(id)) throw new Error(`no such version ${id}`);
      const target = isVersion ? id : join("candidates", id);
      // The manifest's humanPick is the only ground truth, so it must never lag the approval: write the new
      // approval, then the manifest, and only then clear the old approvals. A failure in between leaves at worst
      // a stale second approved.json, which a retry clears; readers treat manifest.humanPick as authoritative.
      // A candidate approval takes this same path - the run is finalised long before a human reads the
      // report and picks, so there is always a manifest to update by the time anyone approves anything.
      await writeAtomic(join(dir, target, "approved.json"), json({ version: id, approvedAt: new Date().toISOString() }));
      const next = { ...manifest, humanPick: id, agreedWithTop: id === manifest.committeeRank[0] };
      await writeAtomic(manifestFile, json(next));
      manifest = next;
      await Promise.all([
        ...versions.filter((s) => s.version !== id).map((s) => rm(join(dir, s.version, "approved.json"), { force: true })),
        ...candidateIds.filter((c) => c !== id).map((c) => rm(join(dir, "candidates", c, "approved.json"), { force: true })),
      ]);
    },
  };
}

/**
 * Claims a run directory that did not exist. The claim is a non-recursive mkdir, so a second run of the same
 * screen on the same day lands in `-2`, `-3`, ... and never touches the first run's versions (spec §11).
 */
export async function openRun(designDir: string, screen: string, date: string): Promise<Run> {
  assertSegment("screen", screen);
  assertSegment("date", date);
  const runs = join(designDir, "runs");
  await mkdir(runs, { recursive: true });
  const name = `${date}-${screen}`;
  for (let n = 1; ; n++) {
    const dir = join(runs, n === 1 ? name : `${name}-${n}`);
    try {
      await mkdir(dir);
      return makeRun(dir, screen, date, [], null);
    } catch (err) {
      if (!isExists(err)) throw err;
    }
  }
}

const parseFile = async <T>(file: string): Promise<T> => {
  const raw = await readFile(file, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
};

/** The chair's raw, unranked answer for a round: a prompt and the change ids it was drawn from. */
export interface RawChair {
  prompt: string;
  changeIds: string[];
}

const isRawChair = (v: unknown): v is RawChair =>
  typeof v === "object" && v !== null &&
  typeof (v as RawChair).prompt === "string" &&
  Array.isArray((v as RawChair).changeIds);

const chairFile = (runDir: string, version: string, where: "version" | "inbox"): string =>
  where === "inbox" ? join(runDir, version, "inbox", "chair.json") : join(runDir, version, "chair.json");

/**
 * Archives the chair's raw answer so a replayed round does not re-pay for it. `chair()`'s ranking and
 * `MAX_CHANGES` truncation stay pure and are re-applied on every replay rather than stored here.
 */
export async function writeChair(runDir: string, version: string, raw: RawChair): Promise<void> {
  await writeAtomic(chairFile(runDir, version, "version"), json(raw));
}

/**
 * The chair's raw answer for a round, or null when it has not answered. Validated on the way out, not
 * the way in: in agent mode this file is written by a subagent, so it is untrusted input from disk. A
 * blank prompt would become an empty Stitch edit — a paid API call that asks for nothing.
 */
export async function readChair(
  runDir: string,
  version: string,
  where: "version" | "inbox" = "version",
): Promise<RawChair | null> {
  const file = chairFile(runDir, version, where);
  let parsed: unknown;
  try {
    parsed = await parseFile<unknown>(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!isRawChair(parsed)) throw new Error(`${file} is not a chair answer`);
  if (parsed.prompt.trim() === "") throw new Error(`${file} has an empty prompt`);
  return { prompt: parsed.prompt.trim(), changeIds: parsed.changeIds.map(String) };
}

/**
 * Reopens a run written by an earlier process, so a person can approve it after reading the report. A
 * `manifest.json` means the run was finalised, and its `versions` list is then authoritative: a stray `vNN`
 * beside it (a crash mid-writeVersion, or a live run being read) is ignored. Without one, versions come from
 * each `vNN/composite.json`, and a directory that has none is skipped rather than making the whole run
 * unopenable, so an aborted run's good versions can still be reviewed and approved.
 */
export async function openExistingRun(runDir: string): Promise<Run> {
  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") {
      throw new Error(`no such run: ${runDir} does not exist`);
    }
    throw err;
  }
  const names = entries.filter((e) => e.isDirectory() && /^v\d{2}$/.test(e.name)).map((e) => e.name).sort();
  if (names.length === 0) throw new Error(`no such run: ${runDir} holds no version directory`);

  let manifest: Manifest | null = null;
  try {
    manifest = await parseFile<Manifest>(join(runDir, "manifest.json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (manifest && !(Array.isArray(manifest.committeeRank) && manifest.committeeRank.length > 0)) {
    throw new Error(`${join(runDir, "manifest.json")} has no committeeRank`);
  }

  const listed = manifest?.versions;
  const versions: VersionSummary[] = [];
  if (Array.isArray(listed)) {
    for (const entry of listed as Partial<VersionSummary>[]) {
      if (typeof entry?.version === "string") {
        versions.push({ version: entry.version, composite: Number(entry.composite), gatePass: Boolean(entry.gatePass) });
      }
    }
  } else {
    for (const version of names) {
      let summary;
      try {
        summary = await parseFile<{ composite: number; gatePass: boolean }>(join(runDir, version, "composite.json"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // written only in part
        throw err;
      }
      versions.push({ version, composite: summary.composite, gatePass: summary.gatePass });
    }
  }

  // Only an unfinalised run needs these, to write its manifest later.
  const { screen, date } = identify(runDir, manifest);

  // The candidate directories are the same source of truth as the files `approve` writes into, so they
  // are scanned directly rather than trusted from `selection.json` - a run with no `candidates/` at all
  // (or a missing/malformed selection.json) still reopens exactly as before.
  let candidateIds: string[] = [];
  if (entries.some((e) => e.isDirectory() && e.name === "candidates")) {
    const sub = await readdir(join(runDir, "candidates"), { withFileTypes: true });
    candidateIds = sub.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  return makeRun(runDir, screen, date, versions, manifest, candidateIds);
}

/**
 * Which screen, on which date, a run directory is for. The manifest is authoritative when there is one; a run
 * still in flight has none, so the name it was given is read back instead. The `-N` collision suffix is
 * indistinguishable from a screen name ending in `-N`, so that reading is a best effort — which is why the
 * manifest wins, and why this parse lives in one place rather than beside every caller that needs it.
 */
function identify(runDir: string, manifest: Record<string, unknown> | null): { screen: string; date: string } {
  const named = /^(\d{4}-\d{2}-\d{2})-(.+?)(?:-\d+)?$/.exec(basename(runDir));
  return {
    screen: typeof manifest?.screen === "string" ? manifest.screen : (named?.[2] ?? basename(runDir)),
    date: typeof manifest?.date === "string" ? manifest.date : (named?.[1] ?? ""),
  };
}

/**
 * `identify` for a caller that has only the path — `dl step <runDir>`, which must name the screen and date
 * `runScreen` is resuming without the operator retyping either. Unlike `openExistingRun` this makes no demand
 * on the directory's contents: a run suspended before its first version was scored still answers.
 */
export async function runIdentity(runDir: string): Promise<{ screen: string; date: string }> {
  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = await parseFile<Record<string, unknown>>(join(runDir, "manifest.json"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
  }
  return identify(runDir, manifest);
}
