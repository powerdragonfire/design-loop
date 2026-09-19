import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
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
}

export interface Finalisation {
  stopReason: StopReason;
  committeeRank: string[];
  spend: Spend;
  hallucinationRate: Record<string, number>;
  degradations: Degradation[];
  /** The noise floor the run's stopping behaviour was judged against (spec §18). */
  sigma: number;
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
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, content);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
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
  let dir = "";
  for (let n = 1; !dir; n++) {
    const candidate = join(runs, n === 1 ? name : `${name}-${n}`);
    try {
      await mkdir(candidate);
      dir = candidate;
    } catch (err) {
      if (!isExists(err)) throw err;
    }
  }

  const versions: VersionSummary[] = [];
  let manifest: Record<string, unknown> | null = null;
  let committeeRank: string[] = [];
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
        committeeRank: m.committeeRank,
        best: m.committeeRank[0],
        versions,
        spend: m.spend,
        hallucinationRate: m.hallucinationRate,
        degradations: m.degradations,
        sigma: m.sigma,
      });
      await writeAtomic(manifestFile, json(next));
      manifest = next;
      committeeRank = next.committeeRank;
    },

    async approve(version) {
      if (!manifest) throw new Error("run is not finalised: finalise it before approving a version");
      if (!written(version)) throw new Error(`no such version ${version}`);
      const approved = join(dir, version, "approved.json");
      await writeAtomic(approved, json({ version, approvedAt: new Date().toISOString() }));
      // Exactly one approval may exist, so a changed mind moves it rather than adding a second.
      await Promise.all(
        versions.filter((s) => s.version !== version).map((s) => rm(join(dir, s.version, "approved.json"), { force: true })),
      );
      await writeAtomic(manifestFile, json({ ...manifest, humanPick: version, agreedWithTop: version === committeeRank[0] }));
    },
  };
}
