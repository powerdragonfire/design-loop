import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Critique, Issue, MeasuredDoc } from "../types.js";
import type { StopReason } from "../scoring/stop.js";

export interface Spend {
  stitchGenerations: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  usd: number;
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
}

export interface Run {
  /** The run directory, claimed by this call and by nothing else. */
  dir: string;
  /** Returns the version directory name, e.g. "v00". */
  writeVersion(v: VersionInput): Promise<string>;
  finalise(m: Finalisation): Promise<void>;
  approve(version: string): Promise<void>;
}

interface VersionSummary {
  version: string;
  composite: number;
  gatePass: boolean;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const isExists = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "EEXIST";

/** Refuses a name that could point outside the runs directory. */
function assertSegment(what: string, value: string): void {
  if (value === "" || value === "." || value === ".." || /[/\\\0]/.test(value)) {
    throw new Error(`Invalid ${what} ${JSON.stringify(value)}: it becomes part of a directory name`);
  }
}

/** The temp file sits beside its target: rename is only atomic within one filesystem. */
export async function writeAtomic(file: string, content: string): Promise<void> {
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

/** Builds a Run over `dir` from what is already known; `openRun` starts empty, `openExistingRun` rebuilds. */
function makeRun(dir: string, screen: string, date: string, versions: VersionSummary[], existing: Manifest | null): Run {
  let manifest = existing;
  const manifestFile = join(dir, "manifest.json");
  const written = (version: string): boolean => versions.some((s) => s.version === version);

  return {
    dir,

    async writeVersion(v) {
      if (!Number.isInteger(v.index) || v.index < 0 || v.index > 99) {
        throw new Error(`Invalid version index ${v.index}: expected an integer from 0 to 99`);
      }
      if (manifest) throw new Error("Cannot write a version: the run is finalised");
      const critics = v.critiques.map((c) => c.critic);
      const dup = critics.find((c, i) => critics.indexOf(c) !== i);
      if (dup !== undefined) throw new Error(`duplicate critique for ${dup}`);

      if (v.parent != null && !written(v.parent)) throw new Error(`no such version ${v.parent} as the parent`);

      const version = `v${String(v.index).padStart(2, "0")}`;
      const base = join(dir, version);
      try {
        await mkdir(base);
      } catch (err) {
        if (isExists(err)) throw new Error(`version ${version} already exists`);
        throw err;
      }
      await mkdir(join(base, "critiques"));
      await Promise.all([
        writeFile(join(base, "screen.png"), v.png),
        writeFile(join(base, "screen.html"), v.html),
        writeFile(join(base, "digest.json"), json(v.doc)),
        writeFile(join(base, "composite.json"), json({ composite: v.composite, gatePass: v.gatePass })),
        writeFile(join(base, "prompt.txt"), v.prompt),
        writeFile(join(base, "open-issues.json"), json(v.openIssues)),
        ...v.critiques.map((c) => writeFile(join(base, "critiques", `${c.critic}.json`), json(c))),
        ...(v.parent != null ? [writeFile(join(base, "parent.txt"), v.parent)] : []),
        ...(v.changes
          ? [writeFile(join(base, "changes.json"), json({
              requested: v.changes.requested,
              applied: v.changes.applied.map((i) => ({
                id: i.id, severity: i.severity, effort: i.effort, claim: i.claim, fix: i.fix,
                selector: i.evidence.selector,
              })),
            }))]
          : []),
      ]);
      versions.push({ version, composite: v.composite, gatePass: v.gatePass });
      return version;
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
      });
      await writeAtomic(manifestFile, json(next));
      manifest = next;
    },

    async approve(version) {
      if (!manifest) throw new Error("run is not finalised: finalise it before approving a version");
      if (!written(version)) throw new Error(`no such version ${version}`);
      // The manifest's humanPick is the only ground truth, so it must never lag the approval: write the new
      // approval, then the manifest, and only then clear the old approvals. A failure in between leaves at worst
      // a stale second approved.json, which a retry clears; readers treat manifest.humanPick as authoritative.
      await writeAtomic(join(dir, version, "approved.json"), json({ version, approvedAt: new Date().toISOString() }));
      const next = { ...manifest, humanPick: version, agreedWithTop: version === manifest.committeeRank[0] };
      await writeAtomic(manifestFile, json(next));
      manifest = next;
      await Promise.all(
        versions.filter((s) => s.version !== version).map((s) => rm(join(dir, s.version, "approved.json"), { force: true })),
      );
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

  // Only an unfinalised run needs these, to write its manifest later. The `-N` collision suffix is
  // indistinguishable from a screen name ending in `-N`, so this reading is a best effort.
  const named = /^(\d{4}-\d{2}-\d{2})-(.+?)(?:-\d+)?$/.exec(basename(runDir));
  const screen = typeof manifest?.screen === "string" ? manifest.screen : (named?.[2] ?? basename(runDir));
  const date = typeof manifest?.date === "string" ? manifest.date : (named?.[1] ?? "");
  return makeRun(runDir, screen, date, versions, manifest);
}
