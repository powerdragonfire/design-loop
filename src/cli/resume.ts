import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Generator, Screen } from "../stitch/adapter.js";
import { versionName, type Run, type RoundCursor, type VersionHandle } from "../store/store.js";
import type { MeasuredDoc } from "../types.js";

// Re-exported so a caller wiring the loop up reaches for one module, not two. `versionName` and `RoundCursor`
// belong to the store: the agent clients read the cursor and name version directories with it, and they sit
// below the CLI.
export { versionName, type RoundCursor };

/**
 * Replay, not checkpoint. A suspended run resumes by re-executing `runScreen` from round 0, and this layer
 * makes every step that already happened free: the generator hands back the screen on disk, `measure` hands
 * back the doc on disk, and the store declines to rewrite a version it already scored. The loop's own
 * arithmetic — `composite`, `gate`, `decide`, `validateEvidence`, `promoteResolutions` — is pure, so replaying
 * reproduces the same state without re-paying for any of it.
 */

const VERSION_DIR = /^v\d{2}$/;

const missing = (err: NodeJS.ErrnoException): boolean => err.code === "ENOENT";

/**
 * The version directories already on disk, in order. A run directory that does not exist yet has none — but
 * any other failure is a real one and is rethrown: reading an EACCES or an ENOTDIR as "nothing on disk" would
 * silently degrade `resumingMeasure` into re-rendering every page in a browser instead of saying what is wrong.
 */
export async function listVersions(runDir: string): Promise<string[]> {
  const entries = await readdir(runDir, { withFileTypes: true })
    .catch((err: NodeJS.ErrnoException) => (missing(err) ? [] : Promise.reject(err)));
  return entries.filter((e) => e.isDirectory() && VERSION_DIR.test(e.name)).map((e) => e.name).sort();
}

/** null for a file that is simply not there; any other failure is a real one and is not swallowed. */
const readOptional = async (file: string): Promise<string | null> =>
  readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => (missing(err) ? null : Promise.reject(err)));

/**
 * A generator that returns the screen an earlier process already generated, without a Stitch call and without
 * reserving quota, and that advances the round cursor as it goes.
 *
 * A replayed handle reads its HTML and PNG from the version directory, never from the handle: a handle rebuilt
 * from an id has no download URL, so `getHtml`/`getImage` on it throw `ScreenRebuiltFromIdError`. The handle is
 * rebuilt only so the NEXT round has something to edit.
 */
export function resumingGenerator(opts: { runDir: string; inner: Generator; cursor: RoundCursor }): Generator {
  const { runDir, inner, cursor } = opts;
  let next = 0;

  const wrap = (index: number, screen: Screen, fromDisk: boolean): Screen => {
    const dir = join(runDir, versionName(index));
    return {
      id: screen.id,
      // An edit is the next round's generate-or-edit, so it goes through `acquire` too and may itself replay.
      edit: (prompt) => acquire(() => screen.edit(prompt)),
      getHtml: fromDisk ? () => readFile(join(dir, "screen.html"), "utf8") : () => screen.getHtml(),
      getImage: fromDisk ? () => readFile(join(dir, "screen.png")) : () => screen.getImage(),
    };
  };

  /**
   * `live` is a thunk, not a promise: on a replayed round it is never invoked, which is what makes the round
   * cost nothing. The cursor moves here and nowhere else, so it is written exactly once per round.
   */
  const acquire = async (live: () => Promise<Screen>): Promise<Screen> => {
    const index = next++;
    cursor.index = index;
    const stored = await readOptional(join(runDir, versionName(index), "screen-id.txt"));
    // A blank `screen-id.txt` is not an id. The store writes that file with a plain `writeFile` inside a
    // `Promise.all`, so a crash mid-write leaves exactly this — the state the layer exists to survive. Taking
    // "" for an id would let the round REPORT as replayed and serve the stored HTML, and the failure would
    // surface a round later, against a screen that does not exist, nowhere near its cause.
    const id = stored?.trim();
    // Without `fromId` there is no way to rebuild an editable handle, so the round has to be generated again.
    // Its HTML then comes from the live handle rather than from disk, since the two are no longer the same screen.
    if (id && inner.fromId) {
      return wrap(index, inner.fromId(id), true);
    }
    return wrap(index, await live(), false);
  };

  return {
    // No `fromId`: a handle rebuilt through it would skip `acquire`, so its `edit` would not advance the cursor
    // and the next round would be generated again instead of replayed. `generate` is the only way in.
    generate: (prompt) => acquire(() => inner.generate(prompt)),
    // Variants are not replayable: they have no version directory to be served from and no cursor slot, so
    // passing them through would re-pay Stitch on every step. Refused rather than guessed at until the resume
    // layer is taught about candidates.
    variants: async () => {
      throw new Error("the resume layer cannot replay candidate variants: agent mode needs variantsPerFamily: 0");
    },
  };
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Returns the `MeasuredDoc` already stored for a page rather than re-rendering it in a browser. Keyed by the
 * content of the stored `screen.html`, never by call order, so nothing breaks if the loop's sequence ever
 * changes. A version that has HTML but no doc (a crash between the two writes) is measured, not guessed at.
 */
export function resumingMeasure(opts: {
  runDir: string;
  inner: (html: string) => Promise<MeasuredDoc>;
}): (html: string) => Promise<MeasuredDoc> {
  const { runDir, inner } = opts;
  // Built once, on first use: the directory does not change under a run, and building it eagerly would make
  // constructing the resume layer an async step for no gain.
  let index: Map<string, string> | null = null;

  const build = async (): Promise<Map<string, string>> => {
    const map = new Map<string, string>();
    for (const version of await listVersions(runDir)) {
      const stored = await readOptional(join(runDir, version, "screen.html"));
      if (stored !== null) map.set(sha(stored), version);
    }
    return map;
  };

  return async (html) => {
    index ??= await build();
    const version = index.get(sha(html));
    if (version === undefined) return inner(html);
    const stored = await readOptional(join(runDir, version, "digest.json"));
    if (stored === null) return inner(html);
    return JSON.parse(stored) as MeasuredDoc;
  };
}

/**
 * A run whose already-scored versions are not rewritten.
 *
 * `openVersion` on a scored version hands back a handle whose writes do nothing, rather than throwing: the loop
 * opens a handle for every round it replays, and a throw would break each one. A version counts as scored when
 * its `composite.json` exists — the last file `finish` writes is not enough on its own, but `composite.json` is
 * what `openExistingRun` itself treats as the mark of a scored version, so the two agree.
 *
 * `run` MUST be an `openExistingRun` over `runDir`, not an `openRun`. A replayed `writeVersion` returns the
 * version name without registering it — it cannot, the run's `versions` list is private to the store — while
 * `runScreen` builds `committeeRank` from every name it was returned and `finalise` rejects an entry the run
 * does not already know. `openExistingRun` rebuilds that list from each `vNN/composite.json`, the same
 * predicate `done()` uses below, so the two agree; wrap an `openRun` instead and every replayed round dies at
 * `finalise` with "no such version v00 in committeeRank", at the end of the run, after all the spend.
 */
export function resumingRun(run: Run, runDir: string): Run {
  const done = async (index: number): Promise<boolean> =>
    (await readOptional(join(runDir, versionName(index), "composite.json"))) !== null;

  /** Claimed by somebody: a directory is here. Says nothing about whether it was scored — `done` does that. */
  const claimed = async (index: number): Promise<boolean> =>
    stat(join(runDir, versionName(index))).then(
      (s) => s.isDirectory(),
      (err: NodeJS.ErrnoException) => {
        if (missing(err) || err.code === "ENOTDIR") return false;
        throw err;
      },
    );

  /**
   * Names the directory that is already there and writes nothing. Because a replayed round never reaches a real
   * `finish`, it can never append a second row for this version to the run's `versions` list — which is
   * serialised straight into `manifest.json`, and which `finish` appends to with no once-guard.
   *
   * What makes that airtight rather than merely true today is the store's own claim: `openVersion` takes `vNN`
   * with a NON-RECURSIVE `mkdir` and turns EEXIST into an error, so two real handles for one index are
   * impossible whatever the list holds. This branch short-circuits before that `mkdir` for a scored version;
   * an unscored one goes to `reopenVersion`, which makes its own, narrower demand of the directory.
   */
  const replayed = (index: number): VersionHandle => ({
    version: versionName(index),
    dir: join(runDir, versionName(index)),
    writeGenerated: async () => {},
    writeCommitteeInputs: async () => {},
    finish: async () => {},
  });

  return {
    ...run,
    dir: run.dir,
    async writeVersion(v) {
      if (await done(v.index)) return versionName(v.index);
      return run.writeVersion(v);
    },
    async openVersion(index) {
      if (await done(index)) return replayed(index);
      // A directory that exists but holds no `composite.json` is the suspend state itself: an earlier process
      // claimed it, wrote everything the critics read and stopped to wait for their answers. Its round is
      // re-scored rather than replayed — the generator and measure layers key per artefact and already hand
      // this round back for free, and the score is exactly what is still missing — so the directory only has
      // to be adopted. `openVersion` would refuse it, by design: its claim is what keeps two live handles for
      // one index impossible, so the re-entry says what it means with a different name instead.
      if (await claimed(index)) return run.reopenVersion(index);
      return run.openVersion(index);
    },
  };
}
