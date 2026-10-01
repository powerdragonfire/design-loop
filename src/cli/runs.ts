import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Issue } from "../types.js";
import { listVersions, readOptional } from "./resume.js";
import { readStart, type RunStart } from "./step.js";

/** One version of a run, as a glance needs it: its score, the gate, and what is still open. */
export interface VersionSummary {
  version: string;
  /** Absent for a version that was claimed but never scored (a run suspended on it). */
  composite?: number;
  gatePass?: boolean;
  blockers?: number;
  majors?: number;
  /** Figma runs: the frame this version is. */
  frameId?: string;
}

/**
 * Everything a one-way view of a design folder (a Notion database, a dashboard) shows about one run, built
 * from the run directory alone. `key` is the run directory's name: unique within the folder and never
 * renamed by the tool, so it is what such a view upserts on.
 */
export interface RunSummary {
  key: string;
  screen: string;
  date: string;
  dir: string;
  /** done: the stop rule fired (manifest.json exists). waiting: suspended on a work order. empty: nothing yet. */
  state: "done" | "waiting" | "empty";
  stopReason?: string;
  /** For a waiting run: what it is waiting for. */
  waitingOn?: "design" | "critics" | "chair";
  /** The version a waiting run is suspended on. */
  waitingVersion?: string;
  best?: string;
  versions: VersionSummary[];
  approved?: { version: string; agreedWithTop: boolean };
  start: RunStart;
  /** Absolute path to report.html when one has been built. */
  report?: string;
  /** The H1 of the screen's spec, when the spec still exists. */
  title?: string;
}

const RUN_DIR = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

/** null for a file that is missing or unreadable as JSON: one corrupt run must not hide every other run. */
const json = async <T>(file: string): Promise<T | null> => {
  const raw = await readOptional(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

async function versionSummary(runDir: string, version: string): Promise<VersionSummary> {
  const dir = join(runDir, version);
  const out: VersionSummary = { version };
  const score = await json<{ composite: number; gatePass: boolean }>(join(dir, "composite.json"));
  if (score) {
    out.composite = score.composite;
    out.gatePass = score.gatePass;
    const open = (await json<Issue[]>(join(dir, "open-issues.json"))) ?? [];
    out.blockers = open.filter((i) => i.severity === "blocker").length;
    out.majors = open.filter((i) => i.severity === "major").length;
  }
  const frame = (await readOptional(join(dir, "screen-id.txt")))?.trim();
  if (frame) out.frameId = frame.replace("-", ":");
  return out;
}

/** The newest version's work order, if the run is suspended on one. */
async function waiting(runDir: string, versions: string[]): Promise<{ on: RunSummary["waitingOn"]; version: string } | null> {
  const last = versions.at(-1);
  if (!last) return null;
  const order = await json<{ kind?: string }>(join(runDir, last, "work-order.json"));
  const kind = order?.kind;
  return kind === "design" || kind === "critics" || kind === "chair" ? { on: kind, version: last } : null;
}

async function specTitle(designDir: string, screen: string): Promise<string | undefined> {
  const spec = await readOptional(join(designDir, "screens", `${screen}.md`));
  return spec?.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

export async function summariseRun(designDir: string, runDir: string): Promise<RunSummary> {
  const dir = resolve(runDir);
  const key = dir.split("/").at(-1)!;
  const manifest = await json<{
    screen?: string; date?: string; stopReason?: string; best?: string; committeeRank?: string[];
    humanPick?: string; agreedWithTop?: boolean;
  }>(join(dir, "manifest.json"));
  // A run directory's name is `<date>-<screen>` with an optional `-N` for a second run the same day; the
  // manifest, once written, is authoritative.
  const named = key.match(RUN_DIR);
  const screen = manifest?.screen ?? named?.[2]?.replace(/-\d+$/, "") ?? key;
  const date = manifest?.date ?? named?.[1] ?? "";
  const names = await listVersions(dir);
  const versions = await Promise.all(names.map((v) => versionSummary(dir, v)));
  const pending = manifest ? null : await waiting(dir, names);

  const summary: RunSummary = {
    key, screen, date, dir,
    state: manifest ? "done" : names.length > 0 ? "waiting" : "empty",
    versions,
    start: await readStart(dir),
  };
  if (manifest?.stopReason) summary.stopReason = manifest.stopReason;
  if (manifest?.best) summary.best = manifest.best;
  if (pending) {
    summary.waitingOn = pending.on;
    summary.waitingVersion = pending.version;
  }
  if (manifest?.humanPick) {
    summary.approved = { version: manifest.humanPick, agreedWithTop: manifest.agreedWithTop ?? manifest.humanPick === manifest.committeeRank?.[0] };
  }
  if (await exists(join(dir, "report.html"))) summary.report = join(dir, "report.html");
  const title = await specTitle(designDir, screen);
  if (title) summary.title = title;
  return summary;
}

/** Every run in the design folder, oldest first. A folder with no `runs/` has none. */
export async function listRuns(designDir: string): Promise<RunSummary[]> {
  const runs = join(designDir, "runs");
  const entries = await readdir(runs, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) =>
    err.code === "ENOENT" ? [] : Promise.reject(err));
  const dirs = entries.filter((e) => e.isDirectory() && RUN_DIR.test(e.name)).map((e) => e.name).sort();
  return Promise.all(dirs.map((d) => summariseRun(designDir, join(runs, d))));
}

/** A link that opens a frame in Figma, from the file key and a `123:456` id. */
export const figmaFrameUrl = (fileKey: string, frameId: string): string =>
  `https://www.figma.com/design/${encodeURIComponent(fileKey)}/?node-id=${frameId.replace(":", "-")}`;

/** One line per run for a person: key, state, best score and approval. */
export function formatRuns(runs: RunSummary[]): string[] {
  if (runs.length === 0) return ["No runs yet."];
  return runs.map((r) => {
    const best = r.versions.find((v) => v.version === r.best);
    const state = r.state === "done" ? r.stopReason : r.state === "waiting" ? `waiting on ${r.waitingOn ?? "a step"} (${r.waitingVersion ?? "?"})` : "empty";
    const score = best?.composite !== undefined ? ` · best ${r.best} ${best.composite.toFixed(1)}` : "";
    const approved = r.approved ? ` · approved ${r.approved.version}` : "";
    return `${r.key}  ${state}${score}${approved}`;
  });
}
