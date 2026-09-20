# Claude Agent Critics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `design-loop run` hand each critic and the chair to a Claude Code subagent, so every committee member is a visible dispatch with tool access, without moving any scoring decision out of TypeScript.

**Architecture:** `runScreen` becomes suspendable. Two agent-mode clients (`AgentLlmClient`, `AgentChairClient`) read their answer from a file; when the file is absent they throw `WorkOrderPending`. `dl step` catches that, writes `vNN/work-order.json` and exits 10. The next `dl step` re-executes `runScreen` from round 0 behind a resume layer that short-circuits anything already on disk, so replay is free and the loop code is untouched.

**Tech Stack:** TypeScript 7 (ESM, `.js` import specifiers), Node 22+, vitest, zod 4, `@anthropic-ai/sdk`, `@google/stitch-sdk`, Playwright (measure only).

**Spec:** `docs/superpowers/specs/2026-09-20-claude-agent-critics-design.md`

## Global Constraints

- All imports use explicit `.js` extensions; the project is `"type": "module"`.
- `pnpm test` (vitest) and `pnpm typecheck` (`tsc --noEmit`) must both pass at the end of every task.
- `criticMode: "api"` is the default and must remain byte-for-byte identical to today's behaviour. Every task that touches a shared path needs a test proving API mode is unchanged.
- No scoring, gating, ranking or stopping decision may move out of TypeScript. Agents produce a `Critique` or a `{ prompt, changeIds }` and nothing else.
- Never widen `parseCritique`. In agent mode it is the only barrier between a file an agent wrote and the scoring code.
- Existing public signatures (`runScreen`, `writeVersion`, `LlmClient`, `ChairClient`) stay source-compatible; new parameters are optional.
- Commit after every task. Never amend a previous task's commit.

## Scope: one part of the spec is deferred

The spec's **"`calibrate` needs the same suspend/resume treatment"** is **not in this plan.** Calibrate is a different shape — 3 reference screens x 5 repeats x 4 critics = 60 agent dispatches with no run directory and no per-round artefact to replay against. It is its own subsystem and deserves its own design.

**Consequence, and the one place this plan knowingly departs from the spec:** the spec makes a `criticMode` mismatch between `config.json` and `calibration.json` a **refusal**. Until agent-mode calibration exists, an agent run can only ever inherit an API-mode sigma, so a refusal would make agent mode unusable. **Task 2 ships it as a loud warning, recorded in the manifest, not a refusal.** Promoting it to a refusal is the first task of the calibrate plan.

Everything else in the spec is covered. This plan still produces working software: you can run a screen in agent mode end to end, watch each critic dispatch, and compare `hallucinationRate` against API mode — which the spec names as the success criterion.

---

### Task 1: Extract critique parsing into its own module

`parseCritique` and the JSON schemas live inside `AnthropicLlmClient`'s file today because that is where the API response was parsed. In agent mode they validate a file on disk instead, so they must not belong to a client.

**Files:**
- Create: `src/critics/schema.ts`
- Modify: `src/critics/llm.ts` (delete the moved block, import instead)
- Test: `test/critics/schema.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `parseCritique(critic: CriticName, raw: unknown): Critique` — throws `Error` with a message of the form `` `${critic} returned an invalid critique: ${why}` ``.
  - `nextIssueId(critic: CriticName, open: Issue[]): string`
  - `CRITIQUE_SCHEMA` — the JSON schema object, used by both clients.
  - `SEVERITIES`, `EFFORTS`, `CRITIC_NAMES` — the readonly tuples.

- [ ] **Step 1: Write the failing test**

Create `test/critics/schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseCritique, nextIssueId } from "../../src/critics/schema.js";
import type { Issue } from "../../src/types.js";

const ok = {
  critic: "typography",
  score: 71,
  issues: [
    { id: "001", severity: "major", evidence: { selector: "#b1", observed: "14px" },
      claim: "too small", fix: "use 16px", effort: "low" },
  ],
  resolved: { claimed: ["typography-000"], verified: [] },
};

describe("parseCritique", () => {
  it("prefixes bare issue ids with the critic name", () => {
    expect(parseCritique("typography", ok).issues[0]!.id).toBe("typography-001");
  });

  it("never trusts a model's own verification", () => {
    expect(parseCritique("typography", ok).resolved).toEqual({ claimed: ["typography-000"], verified: [] });
  });

  it("renumbers a duplicate id instead of dropping it", () => {
    const dup = { ...ok, issues: [ok.issues[0], { ...ok.issues[0], claim: "other" }] };
    const out = parseCritique("typography", dup);
    expect(out.issues.map((i) => i.id)).toEqual(["typography-001", "typography-001-2"]);
  });

  it("rejects a score outside 0..100", () => {
    expect(() => parseCritique("typography", { ...ok, score: 101 }))
      .toThrow(/score is not a number in 0\.\.100/);
  });

  it("rejects an issue with no selector", () => {
    const bad = { ...ok, issues: [{ ...ok.issues[0], evidence: { selector: "", observed: "x" } }] };
    expect(() => parseCritique("typography", bad)).toThrow(/cites no selector/);
  });

  it("rejects a non-object", () => {
    expect(() => parseCritique("typography", "nope")).toThrow(/not an object/);
  });
});

describe("nextIssueId", () => {
  it("is one past the highest numeric suffix already open", () => {
    const open = [{ id: "typography-007" }, { id: "typography-002" }] as Issue[];
    expect(nextIssueId("typography", open)).toBe("typography-008");
  });

  it("starts at 001 when nothing is open", () => {
    expect(nextIssueId("typography", [])).toBe("typography-001");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm exec vitest run test/critics/schema.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/critics/schema.js"`.

- [ ] **Step 3: Create the module by moving code**

Create `src/critics/schema.ts`. Move these from `src/critics/llm.ts` **verbatim** — do not rewrite them, this is a move:

`SEVERITIES`, `EFFORTS`, `CRITIC_NAMES`, `ISSUE_SCHEMA`, `CRITIQUE_SCHEMA`, `invalid`, `isObj`, `isNonEmpty`, `parseCritique`, `nextIssueId`.

The file needs this header and these exports:

```ts
import type { CriticName, Critique, Issue } from "../types.js";

export const SEVERITIES = ["blocker", "major", "minor"] as const;
export const EFFORTS = ["low", "medium", "high"] as const;
export const CRITIC_NAMES = ["typography", "behavioural", "accessibility", "tokenConformance", "feasibility"] as const;
```

`ISSUE_SCHEMA` stays module-private. `CRITIQUE_SCHEMA`, `parseCritique` and `nextIssueId` are exported.

- [ ] **Step 4: Import them in `llm.ts`**

In `src/critics/llm.ts`, delete the moved declarations and add:

```ts
import { CRITIQUE_SCHEMA, nextIssueId, parseCritique } from "./schema.js";
```

Leave `LEGEND`, `rubrics`, `rubric`, `runCommittee` and `AnthropicLlmClient` exactly where they are. `isObj` is used nowhere else in `llm.ts` after the move — confirm with `grep -n "isObj\|isNonEmpty" src/critics/llm.ts` and delete any now-unused local copy.

- [ ] **Step 5: Run the new test and the existing critic tests**

Run: `pnpm exec vitest run test/critics/ && pnpm typecheck`
Expected: PASS. `test/critics/llm.test.ts` must pass **unchanged** — if it needed editing, something was rewritten rather than moved.

- [ ] **Step 6: Commit**

```bash
git add src/critics/schema.ts src/critics/llm.ts test/critics/schema.test.ts
git commit -m "refactor(critics): move critique parsing out of the Anthropic client

In agent mode parseCritique validates a file an agent wrote rather than an
API response, so it cannot belong to the API client."
```

---

### Task 2: `criticMode` in config and calibration

**Files:**
- Modify: `src/types.ts`, `src/contract/load.ts`, `src/cli/calibration.ts`, `src/cli/run.ts`
- Test: `test/contract/load.test.ts`, `test/cli/calibration-mode.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Config.criticMode: "api" | "agent"` — absent in `config.json` means `"api"`.
  - `Calibration.criticMode: "api" | "agent"` — absent in an old `calibration.json` means `"api"`.

- [ ] **Step 1: Write the failing tests**

Add to `test/contract/load.test.ts` (match the file's existing fixture-copy helper):

```ts
it("defaults criticMode to api when config.json omits it", async () => {
  const dir = setup();
  expect((await loadContract(dir)).config.criticMode).toBe("api");
});

it("accepts criticMode agent", async () => {
  const dir = setup();
  const file = join(dir, "config.json");
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...cfg, criticMode: "agent" }));
  expect((await loadContract(dir)).config.criticMode).toBe("agent");
});

it("rejects an unknown criticMode", async () => {
  const dir = setup();
  const file = join(dir, "config.json");
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...cfg, criticMode: "robots" }));
  await expect(loadContract(dir)).rejects.toThrow(/invalid config\.json.*criticMode/s);
});
```

Create `test/cli/calibration-mode.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCalibration } from "../../src/cli/calibration.js";
import type { Config } from "../../src/types.js";

const cfg = (over: Partial<Config> = {}): Config => ({
  sigma: 1.8, maxRounds: 5, convergenceSigmas: 1, convergenceRounds: 2,
  models: { critic: "claude-sonnet-5", chair: "claude-opus-5" },
  weights: { typography: 0.2, behavioural: 0.2, accessibility: 0.2, tokenConformance: 0.2, feasibility: 0.2 },
  batchMode: false, criticMode: "api", ...over,
});

const withCalibration = (body: object): string => {
  const dir = mkdtempSync(join(tmpdir(), "dl-cal-"));
  mkdirSync(join(dir, ".design-loop"));
  writeFileSync(join(dir, ".design-loop", "calibration.json"), JSON.stringify(body));
  return dir;
};

const base = {
  sigma: 1.8, criticModel: "claude-sonnet-5", measuredAt: "2026-09-01T00:00:00.000Z",
  weights: { typography: 0.2, behavioural: 0.2, accessibility: 0.2, tokenConformance: 0.2, feasibility: 0.2 },
};

describe("readCalibration criticMode", () => {
  it("treats a calibration with no criticMode as api", async () => {
    const dir = withCalibration(base);
    const lines: string[] = [];
    const out = await readCalibration(dir, cfg(), 1.8, (l) => lines.push(l));
    expect(out?.criticMode).toBe("api");
    expect(lines).toEqual([]);
  });

  it("warns loudly when the run mode differs from the calibrated mode", async () => {
    const dir = withCalibration(base);
    const lines: string[] = [];
    await readCalibration(dir, cfg({ criticMode: "agent" }), 1.8, (l) => lines.push(l));
    expect(lines.join("\n")).toMatch(/sigma was calibrated in api mode but this run uses agent/);
  });

  it("says nothing when the modes agree", async () => {
    const dir = withCalibration({ ...base, criticMode: "agent" });
    const lines: string[] = [];
    await readCalibration(dir, cfg({ criticMode: "agent" }), 1.8, (l) => lines.push(l));
    expect(lines).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run test/contract/load.test.ts test/cli/calibration-mode.test.ts`
Expected: FAIL — `criticMode` is not a property of `Config`, and the strict schema rejects the extra key.

- [ ] **Step 3: Add the field**

`src/types.ts`, inside `Config`:

```ts
  /** Where critiques come from: the Anthropic API, or files written by Claude Code subagents. */
  criticMode: "api" | "agent";
```

`src/contract/load.ts`, inside `ConfigSchema` (after `batchMode`):

```ts
  criticMode: z.enum(["api", "agent"]).default("api"),
```

`src/cli/calibration.ts` — add to the `Calibration` interface:

```ts
  criticMode: "api" | "agent";
```

In `isCalibration`, accept an absent or valid value:

```ts
    (c.criticMode === undefined || c.criticMode === "api" || c.criticMode === "agent") &&
```

In `readCalibration`, when building `cal`, default the field and add the warning beside the existing model/weight warnings:

```ts
  const cal: Calibration = {
    sigma: parsed.sigma,
    criticModel: parsed.criticModel,
    weights: parsed.weights,
    measuredAt: parsed.measuredAt,
    // An old calibration predates the field; it can only have been measured through the API.
    criticMode: parsed.criticMode ?? "api",
  };
  if (cfg.criticMode !== cal.criticMode) {
    log?.(
      `WARNING: sigma was calibrated in ${cal.criticMode} mode but this run uses ${cfg.criticMode} mode. ` +
        "Tool-using critics score differently, so this run's stopping rule rests on a noise floor that does " +
        "not describe it. Agent-mode calibration is not implemented yet; treat the stop reason with suspicion.",
    );
  }
```

- [ ] **Step 4: Record the mode on the run**

In `src/cli/run.ts`, add `cfg.criticMode` to the header block so it is visible while watching:

```ts
  progress.header([
    `run ${screen} · design ${designDir}`,
    `critic ${cfg.models.critic} (${cfg.criticMode}) · chair ${cfg.models.chair} · sigma ${sigma} · up to ${cfg.maxRounds} edits`,
    `Stitch ${quota.used}/${MONTHLY_LIMIT} used this month · results in ${run.dir}`,
  ]);
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, including every existing test — the fixture `config.json` has no `criticMode` and must still load.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/contract/load.ts src/cli/calibration.ts src/cli/run.ts test/contract/load.test.ts test/cli/calibration-mode.test.ts
git commit -m "feat(config): add criticMode, defaulting to api

A sigma measured with API critics does not describe tool-using agent
critics. Until agent-mode calibrate exists this is a loud warning rather
than the refusal the spec calls for; promoting it is the calibrate plan's
first task."
```

---

### Task 3: Split `writeVersion` so a version directory can be claimed before it is scored

An agent needs the digest, the screenshot and the carried issues **before** the round is scored, but `writeVersion` creates the version directory and writes everything in one call at the end. Split it, keeping `writeVersion` as a wrapper so no existing caller changes.

**Files:**
- Modify: `src/store/store.ts`
- Test: `test/store/store-open.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces, on the `Run` interface:
  - `openVersion(index: number): Promise<VersionHandle>` — claims `vNN` with a non-recursive mkdir; throws `` `version ${version} already exists` `` if taken.
  - `VersionHandle`:
    - `version: string` (`"v00"`), `dir: string`
    - `writeGenerated(g: GeneratedInput): Promise<void>`
    - `writeCommitteeInputs(i: CommitteeInputs): Promise<void>`
    - `finish(f: ScoredInput): Promise<void>`
  - `writeVersion(v: VersionInput)` keeps its exact current signature and return value, now implemented as `openVersion` + the three writes. `VersionInput` gains three optional fields: `screenId?: string`, `digest?: string`, `carriedIssues?: Issue[]`, `measurements?: Issue[]`.

- [ ] **Step 1: Write the failing test**

Create `test/store/store-open.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRun } from "../../src/store/store.js";
import type { Critique, Issue, MeasuredDoc } from "../../src/types.js";

const doc: MeasuredDoc = { viewport: { w: 390, h: 844 }, nodes: [] };
const issue = (id: string): Issue =>
  ({ id, severity: "major", evidence: { selector: "#b1", observed: "o" }, claim: "c", fix: "f", effort: "low" });
const critique = (): Critique =>
  ({ critic: "typography", score: 70, issues: [], resolved: { claimed: [], verified: [] } });

const newRun = async () => openRun(mkdtempSync(join(tmpdir(), "dl-store-")), "home", "2026-09-20");

describe("openVersion", () => {
  it("claims the directory and writes the committee's inputs before any critique exists", async () => {
    const run = await newRun();
    const v = await run.openVersion(0);
    expect(v.version).toBe("v00");
    await v.writeGenerated({ png: Buffer.from("p"), html: "<html></html>", doc, prompt: "make it", screenId: "sc-1", parent: null });
    await v.writeCommitteeInputs({ digest: "viewport: 390x844", carriedIssues: [issue("typography-001")], measurements: [issue("det-001")] });

    expect(readFileSync(join(v.dir, "screen-id.txt"), "utf8")).toBe("sc-1");
    expect(readFileSync(join(v.dir, "digest.txt"), "utf8")).toBe("viewport: 390x844");
    expect(JSON.parse(readFileSync(join(v.dir, "carried-issues.json"), "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(v.dir, "measurements.json"), "utf8"))[0].id).toBe("det-001");
    expect(existsSync(join(v.dir, "composite.json"))).toBe(false);
  });

  it("refuses to claim a version twice", async () => {
    const run = await newRun();
    await run.openVersion(0);
    await expect(run.openVersion(0)).rejects.toThrow(/version v00 already exists/);
  });

  it("finish writes the scored half", async () => {
    const run = await newRun();
    const v = await run.openVersion(0);
    await v.writeGenerated({ png: Buffer.from("p"), html: "<html></html>", doc, prompt: "make it", screenId: "sc-1", parent: null });
    await v.finish({ critiques: [critique()], composite: 70, gatePass: false, openIssues: [issue("typography-001")] });
    expect(JSON.parse(readFileSync(join(v.dir, "composite.json"), "utf8"))).toEqual({ composite: 70, gatePass: false });
    expect(existsSync(join(v.dir, "critiques", "typography.json"))).toBe(true);
  });
});

describe("writeVersion still works as before", () => {
  it("produces the same files in one call", async () => {
    const run = await newRun();
    const version = await run.writeVersion({
      index: 0, png: Buffer.from("p"), html: "<html></html>", doc, critiques: [critique()],
      composite: 70, gatePass: false, prompt: "make it", openIssues: [], parent: null,
    });
    expect(version).toBe("v00");
    expect(existsSync(join(run.dir, "v00", "composite.json"))).toBe(true);
    expect(existsSync(join(run.dir, "v00", "screen.png"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run test/store/store-open.test.ts`
Expected: FAIL — `run.openVersion is not a function`.

- [ ] **Step 3: Implement the split**

In `src/store/store.ts`, add these types beside `VersionInput`:

```ts
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
  critiques: Critique[];
  composite: number;
  gatePass: boolean;
  openIssues: Issue[];
  changes?: { requested: number; applied: Issue[] };
}

export interface VersionHandle {
  version: string;
  dir: string;
  writeGenerated(g: GeneratedInput): Promise<void>;
  writeCommitteeInputs(i: CommitteeInputs): Promise<void>;
  finish(f: ScoredInput): Promise<void>;
}
```

Add `openVersion(index: number): Promise<VersionHandle>` to the `Run` interface.

Inside `makeRun`, implement it by lifting the existing body of `writeVersion` apart. The validation that currently runs at the top of `writeVersion` splits by what it guards:

- index range and `manifest` (finalised) checks → `openVersion`
- `parent` must already be written → `writeGenerated`
- duplicate-critic check → `finish`
- `versions.push(...)` → `finish` (a claimed-but-unscored version must not count as a version yet)

```ts
    async openVersion(index) {
      if (!Number.isInteger(index) || index < 0 || index > 99) {
        throw new Error(`Invalid version index ${index}: expected an integer from 0 to 99`);
      }
      if (manifest) throw new Error("Cannot write a version: the run is finalised");
      const version = `v${String(index).padStart(2, "0")}`;
      const base = join(dir, version);
      try {
        await mkdir(base);
      } catch (err) {
        if (isExists(err)) throw new Error(`version ${version} already exists`);
        throw err;
      }
      await mkdir(join(base, "critiques"));
      await mkdir(join(base, "inbox"));

      let composite = 0;
      let gatePass = false;
      return {
        version,
        dir: base,
        async writeGenerated(g) {
          if (g.parent != null && !written(g.parent)) throw new Error(`no such version ${g.parent} as the parent`);
          await Promise.all([
            writeFile(join(base, "screen.png"), g.png),
            writeFile(join(base, "screen.html"), g.html),
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
          const critics = f.critiques.map((c) => c.critic);
          const dup = critics.find((c, n) => critics.indexOf(c) !== n);
          if (dup !== undefined) throw new Error(`duplicate critique for ${dup}`);
          composite = f.composite;
          gatePass = f.gatePass;
          await Promise.all([
            writeFile(join(base, "composite.json"), json({ composite, gatePass })),
            writeFile(join(base, "open-issues.json"), json(f.openIssues)),
            ...f.critiques.map((c) => writeFile(join(base, "critiques", `${c.critic}.json`), json(c))),
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
          versions.push({ version, composite, gatePass });
        },
      };
    },
```

Then rewrite `writeVersion` as the wrapper:

```ts
    async writeVersion(v) {
      const handle = await this.openVersion(v.index);
      await handle.writeGenerated({ png: v.png, html: v.html, doc: v.doc, prompt: v.prompt, screenId: v.screenId, parent: v.parent });
      if (v.digest !== undefined) {
        await handle.writeCommitteeInputs({ digest: v.digest, carriedIssues: v.carriedIssues ?? [], measurements: v.measurements ?? [] });
      }
      await handle.finish({ critiques: v.critiques, composite: v.composite, gatePass: v.gatePass, openIssues: v.openIssues, changes: v.changes });
      return handle.version;
    },
```

`makeRun` returns an object literal, so `this.openVersion` resolves correctly. If the codebase style prefers not to rely on `this`, hoist `openVersion` to a `const openVersion = async (index) => {...}` above the returned object and reference it from both places.

Add `screenId?`, `digest?`, `carriedIssues?`, `measurements?` to `VersionInput` with the doc comments above.

- [ ] **Step 4: Run the store tests**

Run: `pnpm exec vitest run test/store/ && pnpm typecheck`
Expected: PASS. `store.test.ts`, `store-edges.test.ts` and `store-atomic.test.ts` must pass **unchanged**.

- [ ] **Step 5: Run everything**

Run: `pnpm test`
Expected: PASS. Note `openExistingRun` rebuilds versions from `vNN/composite.json`, so a claimed-but-unfinished directory is skipped — that behaviour already exists and is what we want.

- [ ] **Step 6: Commit**

```bash
git add src/store/store.ts test/store/store-open.test.ts
git commit -m "feat(store): let a version directory be claimed before it is scored

Agent critics need the digest, screenshot and carried issues on disk
before the round is scored. writeVersion stays as a wrapper so no caller
changes."
```

---

### Task 4: Persist and read back the chair's answer

**Files:**
- Modify: `src/store/store.ts`
- Test: `test/store/store-chair.test.ts` (create)

**Interfaces:**
- Consumes: `Run` from Task 3.
- Produces, module-level exports in `store.ts`:
  - `writeChair(runDir: string, version: string, raw: RawChair): Promise<void>` — writes `<runDir>/<version>/chair.json`.
  - `readChair(runDir: string, version: string): Promise<RawChair | null>` — `null` when absent.
  - `type RawChair = { prompt: string; changeIds: string[] }`

`chair.json` and `inbox/chair.json` hold the same shape on purpose: the archived copy is the accepted inbox file. `chair()`'s ranking and `MAX_CHANGES` truncation stay pure and are re-applied on every replay rather than stored.

- [ ] **Step 1: Write the failing test**

Create `test/store/store-chair.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChair, writeChair } from "../../src/store/store.js";

const runDir = () => {
  const d = mkdtempSync(join(tmpdir(), "dl-chair-"));
  mkdirSync(join(d, "v01"));
  return d;
};

describe("chair.json", () => {
  it("round-trips the raw synthesise answer", async () => {
    const dir = runDir();
    await writeChair(dir, "v01", { prompt: "make the button bigger", changeIds: ["typography-001"] });
    expect(await readChair(dir, "v01")).toEqual({ prompt: "make the button bigger", changeIds: ["typography-001"] });
  });

  it("returns null when the chair has not answered yet", async () => {
    expect(await readChair(runDir(), "v01")).toBeNull();
  });

  it("rejects a stored answer with no prompt", async () => {
    const dir = runDir();
    await writeChair(dir, "v01", { prompt: "", changeIds: [] });
    await expect(readChair(dir, "v01")).rejects.toThrow(/empty prompt/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run test/store/store-chair.test.ts`
Expected: FAIL — `writeChair` is not exported.

- [ ] **Step 3: Implement**

Append to `src/store/store.ts`:

```ts
export interface RawChair {
  prompt: string;
  changeIds: string[];
}

const isRawChair = (v: unknown): v is RawChair =>
  typeof v === "object" && v !== null &&
  typeof (v as RawChair).prompt === "string" &&
  Array.isArray((v as RawChair).changeIds);

export async function writeChair(runDir: string, version: string, raw: RawChair): Promise<void> {
  await writeAtomic(join(runDir, version, "chair.json"), json(raw));
}

/**
 * The chair's raw answer for a round, or null when it has not answered. Validated on the way out, not
 * the way in: an agent writes this file, and a blank prompt would become an empty Stitch edit.
 */
export async function readChair(runDir: string, version: string): Promise<RawChair | null> {
  const file = join(runDir, version, "chair.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = await parseFile<unknown>(file).catch(() => JSON.parse(raw) as unknown);
  if (!isRawChair(parsed)) throw new Error(`${file} is not a chair answer`);
  if (parsed.prompt.trim() === "") throw new Error(`${file} has an empty prompt`);
  return { prompt: parsed.prompt.trim(), changeIds: parsed.changeIds.map(String) };
}
```

Simplify the double-parse: `parseFile` already reads and parses, so use it directly and drop the manual `readFile` once the ENOENT case is handled — read the file's existing `parseFile` helper and follow its error style.

- [ ] **Step 4: Run the test**

Run: `pnpm exec vitest run test/store/ && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/store.ts test/store/store-chair.test.ts
git commit -m "feat(store): persist the chair's raw answer per version

So a replayed round does not re-pay the chair. The cap stays pure and is
re-applied rather than stored."
```

---

### Task 5: Rebuild a Stitch screen handle from its id

**Files:**
- Modify: `src/stitch/sdk.ts`, `src/stitch/adapter.ts`
- Test: `test/stitch/from-id.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `screenFromId(projectId: string, id: string, callTool?: CallTool): SdkScreen` in `sdk.ts`. Its `edit` works; its `getHtml`/`getImage` **throw**.
  - `Generator.fromId?(id: string): Screen` — optional method on the existing interface.
  - `StitchGenerator.fromId(id)` and `FakeGenerator.fromId(id)` implement it.

`getHtml`/`getImage` throw rather than falling back because they would route to `get_screen`, which the live API rejects with `Invalid Argument` for its own documented arguments. The loop never needs them on a rehydrated handle — the HTML and PNG are on disk — so a throw turns a future misuse into an error instead of a mystery.

- [ ] **Step 1: Write the failing test**

Create `test/stitch/from-id.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { screenFromId } from "../../src/stitch/sdk.js";

const editResponse = {
  outputComponents: [
    { design: { screens: [] } },
    { design: { screens: [{ id: "sc-2", htmlCode: { downloadUrl: "https://x/h" }, screenshot: { downloadUrl: "https://x/p" } }] } },
  ],
};

describe("screenFromId", () => {
  it("edits without ever fetching the screen first", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return editResponse;
    };
    const screen = screenFromId("proj-1", "sc-1", callTool);
    const next = await screen.edit("make it bigger", "MOBILE", "GEMINI_3_PRO");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("edit_screens");
    expect(calls[0]!.args.selectedScreenIds).toEqual(["sc-1"]);
    expect(next.id).toBe("sc-2");
  });

  it("refuses to download, because get_screen is not usable", async () => {
    const screen = screenFromId("proj-1", "sc-1", async () => editResponse);
    await expect(screen.getHtml()).rejects.toThrow(/rebuilt from an id/);
    await expect(screen.getImage()).rejects.toThrow(/rebuilt from an id/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run test/stitch/from-id.test.ts`
Expected: FAIL — `screenFromId` is not exported.

- [ ] **Step 3: Implement in `sdk.ts`**

`createSdkProject`'s `screenOf` already builds a screen from a `ScreenData`, and `edit` needs only the id. Export a variant that reuses it. Add after `createSdkProject`:

```ts
/**
 * A handle for a screen that was generated in an earlier process, rebuilt from its id alone so a
 * resumed run can edit it without spending quota to make it again.
 *
 * `getHtml` and `getImage` throw. They would resolve through `get_screen`, which the live API rejects
 * with `Invalid Argument` for its own documented arguments; the caller has the HTML and PNG on disk.
 */
export function screenFromId(projectId: string, id: string, callTool: CallTool = defaultCallTool): SdkScreen {
  if (!id) throw new Error("screenFromId needs a screen id");
  const project = createSdkProject(projectId, callTool);
  const refuse = async (): Promise<never> => {
    throw new Error(`screen ${id} was rebuilt from an id: read its HTML and image from the run directory instead`);
  };
  return { ...(project as unknown as { screenOf(d: ScreenData): SdkScreen }).screenOf({ id }), getHtml: refuse, getImage: refuse };
}
```

That cast is ugly. Instead, refactor `createSdkProject` so `screenOf` is reachable: change its return to include the helper, or — cleaner and preferred — lift `screenOf` into a module-level factory:

```ts
function makeScreen(projectId: string, callTool: CallTool, data: ScreenData): SdkScreen { /* the current screenOf body */ }
```

`createSdkProject` then calls `makeScreen(projectId, callTool, ...)`, and `screenFromId` is:

```ts
export function screenFromId(projectId: string, id: string, callTool: CallTool = defaultCallTool): SdkScreen {
  if (!id) throw new Error("screenFromId needs a screen id");
  const refuse = async (): Promise<never> => {
    throw new Error(`screen ${id} was rebuilt from an id: read its HTML and image from the run directory instead`);
  };
  return { ...makeScreen(projectId, callTool, { id }), getHtml: refuse, getImage: refuse };
}
```

Take the second route.

- [ ] **Step 4: Add `fromId` to the adapter**

In `src/stitch/adapter.ts`, extend the interface:

```ts
export interface Generator {
  generate(prompt: string): Promise<Screen>;
  /** Rebuilds a handle for a screen this generator already produced. No network, no quota. */
  fromId?(id: string): Screen;
}
```

On `StitchGenerator`, add:

```ts
  fromId(id: string): Screen {
    return this.wrap(screenFromId(this.projectIdOf(), id));
  }
```

`StitchGenerator` holds `project`, not the project id, so store the id: add `projectId` to `StitchGeneratorOptions`, set it in `createStitchGenerator` from `env.STITCH_PROJECT_ID`, and keep it on the instance. `wrap` already turns an `SdkScreen` into a `Screen` with retries and the PNG signature check — reuse it, and note that `wrap`'s `getHtml`/`getImage` will surface the refusal thrown above.

On `FakeGenerator`, add:

```ts
  fromId(id: string): Screen {
    const index = Number(id.replace("fake-", ""));
    const spec = this.script[index];
    if (!spec) throw new Error(`no fake screen ${id}`);
    return {
      id,
      edit: (prompt) => this.generate(prompt),
      getHtml: async () => spec.html,
      getImage: async () => spec.png,
    };
  }
```

- [ ] **Step 5: Run the stitch tests**

Run: `pnpm exec vitest run test/stitch/ && pnpm typecheck`
Expected: PASS, with `adapter.test.ts` and `sdk.test.ts` unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/stitch/sdk.ts src/stitch/adapter.ts test/stitch/from-id.test.ts
git commit -m "feat(stitch): rebuild a screen handle from its id

A resumed run edits a screen an earlier process generated. Downloads throw
rather than routing to get_screen, which the live API rejects."
```

---

### Task 6: The resume layer

The heart of the design. Each `dl step` re-runs `runScreen` from round 0; this layer makes every already-done step free, and carries the **round cursor** that tells the agent clients which version is current.

**Files:**
- Create: `src/cli/resume.ts`
- Modify: `src/cli/run.ts` (accept an injectable `measure`)
- Test: `test/cli/resume.test.ts` (create)

**Interfaces:**
- Consumes: `Generator`, `Screen`, `Generator.fromId` (Task 5); `Run` (Task 3).
- Produces:
  - `interface RoundCursor { index: number }` — mutated by the resuming generator, read by the agent clients. The loop performs exactly one generate-or-edit per round, in order, so the cursor is the current version index.
  - `resumingGenerator(opts: { runDir: string; inner: Generator; cursor: RoundCursor }): Generator`
  - `resumingMeasure(opts: { runDir: string; inner: (html: string) => Promise<MeasuredDoc> }): (html: string) => Promise<MeasuredDoc>` — keyed by a SHA-256 of the stored `screen.html`, so it never assumes call order.
  - `resumingRun(run: Run, runDir: string): Run` — `writeVersion`/`openVersion` return the existing version instead of throwing when `vNN/composite.json` is already on disk.
  - `versionName(index: number): string` — `"v00"`.
- `RunOptions` gains `measure?: (html: string) => Promise<MeasuredDoc>`, defaulting to the real `measure`.

- [ ] **Step 1: Write the failing test**

Create `test/cli/resume.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumingGenerator, resumingMeasure, versionName, type RoundCursor } from "../../src/cli/resume.js";
import { FakeGenerator } from "../../src/stitch/adapter.js";
import type { MeasuredDoc } from "../../src/types.js";

const doc = (n: number): MeasuredDoc => ({ viewport: { w: 390, h: 844 }, nodes: Array(n).fill(null).map(() => ({
  selector: "#b1", tag: "button", role: null, text: "Go", bbox: { x: 0, y: 0, w: 48, h: 48 }, style: {},
})) });

const html = (n: number) => `<html><body>${n}</body></html>`;
const shot = (n: number) => ({ html: html(n), png: Buffer.from(`png${n}`) });

const seed = (versions: { html: string; png: Buffer; doc: MeasuredDoc; screenId: string }[]) => {
  const dir = mkdtempSync(join(tmpdir(), "dl-resume-"));
  versions.forEach((v, i) => {
    const base = join(dir, versionName(i));
    mkdirSync(base);
    writeFileSync(join(base, "screen.html"), v.html);
    writeFileSync(join(base, "screen.png"), v.png);
    writeFileSync(join(base, "digest.json"), JSON.stringify(v.doc));
    writeFileSync(join(base, "screen-id.txt"), v.screenId);
    writeFileSync(join(base, "composite.json"), JSON.stringify({ composite: 70, gatePass: false }));
  });
  return dir;
};

describe("resumingGenerator", () => {
  it("returns the stored screen without calling the inner generator", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(1), screenId: "fake-0" }]);
    const inner = new FakeGenerator([shot(0), shot(1)]);
    const cursor: RoundCursor = { index: -1 };
    const gen = resumingGenerator({ runDir, inner, cursor });

    const screen = await gen.generate("first prompt");
    expect(inner.prompts).toEqual([]);          // no Stitch call, no quota
    expect(cursor.index).toBe(0);
    expect(await screen.getHtml()).toBe(html(0)); // read from disk, not the handle
  });

  it("falls through to the inner generator for a round not yet on disk", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(1), screenId: "fake-0" }]);
    const inner = new FakeGenerator([shot(0), shot(1)]);
    const cursor: RoundCursor = { index: -1 };
    const gen = resumingGenerator({ runDir, inner, cursor });

    const v00 = await gen.generate("first prompt");
    const v01 = await v00.edit("second prompt");
    expect(inner.prompts).toEqual(["second prompt"]);
    expect(cursor.index).toBe(1);
    expect(await v01.getHtml()).toBe(html(1));
  });
});

describe("resumingMeasure", () => {
  it("reads a stored doc instead of re-measuring, keyed by html content", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(3), screenId: "fake-0" }]);
    let calls = 0;
    const m = resumingMeasure({ runDir, inner: async () => { calls++; return doc(99); } });

    expect((await m(html(0))).nodes).toHaveLength(3);
    expect(calls).toBe(0);
  });

  it("measures html it has never seen", async () => {
    const runDir = seed([{ ...shot(0), doc: doc(3), screenId: "fake-0" }]);
    let calls = 0;
    const m = resumingMeasure({ runDir, inner: async () => { calls++; return doc(99); } });

    expect((await m(html(7))).nodes).toHaveLength(99);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run test/cli/resume.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/resume.js`.

- [ ] **Step 3: Implement `src/cli/resume.ts`**

```ts
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Generator, Screen } from "../stitch/adapter.js";
import type { Run } from "../store/store.js";
import type { MeasuredDoc } from "../types.js";

export const versionName = (index: number): string => `v${String(index).padStart(2, "0")}`;

/**
 * Which round the loop is on. The resuming generator sets it; the agent clients read it to find their
 * version directory. `runScreen` performs exactly one generate-or-edit per round, in order, so a
 * counter incremented there IS the current version index. Nothing else may write to it.
 */
export interface RoundCursor {
  index: number;
}

const VERSION_DIR = /^v\d{2}$/;

/** The version directories already on disk, in order. */
export async function listVersions(runDir: string): Promise<string[]> {
  const entries = await readdir(runDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && VERSION_DIR.test(e.name)).map((e) => e.name).sort();
}

const readOptional = async (file: string): Promise<string | null> =>
  readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? null : Promise.reject(err)));

export function resumingGenerator(opts: { runDir: string; inner: Generator; cursor: RoundCursor }): Generator {
  const { runDir, inner, cursor } = opts;
  let next = 0;

  const wrap = (index: number, screen: Screen, fromDisk: boolean): Screen => {
    const dir = join(runDir, versionName(index));
    return {
      id: screen.id,
      edit: (prompt) => acquire(() => screen.edit(prompt)),
      getHtml: fromDisk ? () => readFile(join(dir, "screen.html"), "utf8") : () => screen.getHtml(),
      getImage: fromDisk ? () => readFile(join(dir, "screen.png")) : () => screen.getImage(),
    };
  };

  const acquire = async (live: () => Promise<Screen>): Promise<Screen> => {
    const index = next++;
    cursor.index = index;
    const storedId = await readOptional(join(runDir, versionName(index), "screen-id.txt"));
    if (storedId !== null && inner.fromId) {
      return wrap(index, inner.fromId(storedId.trim()), true);
    }
    return wrap(index, await live(), false);
  };

  return {
    generate: (prompt) => acquire(() => inner.generate(prompt)),
    fromId: inner.fromId?.bind(inner),
  };
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Returns the `MeasuredDoc` already stored for a page rather than re-rendering it. Keyed by the
 * content of the stored `screen.html`, never by call order, so nothing breaks if the loop's sequence
 * ever changes.
 */
export function resumingMeasure(opts: {
  runDir: string;
  inner: (html: string) => Promise<MeasuredDoc>;
}): (html: string) => Promise<MeasuredDoc> {
  const { runDir, inner } = opts;
  let index: Map<string, string> | null = null;

  const build = async (): Promise<Map<string, string>> => {
    const map = new Map<string, string>();
    for (const version of await listVersions(runDir)) {
      const html = await readOptional(join(runDir, version, "screen.html"));
      if (html !== null) map.set(sha(html), version);
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

/** A run whose already-scored versions are not rewritten. */
export function resumingRun(run: Run, runDir: string): Run {
  const done = async (index: number): Promise<boolean> =>
    (await readOptional(join(runDir, versionName(index), "composite.json"))) !== null;

  return {
    ...run,
    dir: run.dir,
    async writeVersion(v) {
      if (await done(v.index)) return versionName(v.index);
      return run.writeVersion(v);
    },
    async openVersion(index) {
      if (await done(index)) {
        throw new Error(`version ${versionName(index)} is already scored; the resume layer should not reopen it`);
      }
      return run.openVersion(index);
    },
  };
}
```

- [ ] **Step 4: Make `measure` injectable in `runScreen`**

In `src/cli/run.ts`, add to `RunOptions`:

```ts
  /** Replaced by the resume layer so a replayed round reads its stored doc instead of re-rendering. */
  measure?: (html: string) => Promise<MeasuredDoc>;
```

And in `runScreen`'s destructuring, take it with a default:

```ts
  const measureDoc = opts.measure ?? measure;
```

Change the one call site from `measure(html)` to `measureDoc(html)`. Nothing else in the loop moves.

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run test/cli/ && pnpm typecheck`
Expected: PASS, with `run.test.ts` unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/cli/resume.ts src/cli/run.ts test/cli/resume.test.ts
git commit -m "feat(cli): resume layer that replays a run from its directory

Each step re-executes runScreen from round 0; anything already on disk is
free. The round cursor it maintains is how the agent clients find their
version directory."
```

---

### Task 7: The agent critic client

**Files:**
- Create: `src/critics/agent.ts`
- Test: `test/critics/agent.test.ts` (create)

**Interfaces:**
- Consumes: `parseCritique` (Task 1); `RoundCursor`, `versionName` (Task 6).
- Produces:
  - `class WorkOrderPending extends Error` with `kind: "critics" | "chair"`, `version: string`, `units: PendingUnit[]`.
  - `interface PendingUnit { critic: CriticName }`
  - `class AgentLlmClient implements LlmClient` — constructor `{ runDir: string; cursor: RoundCursor }`.

Behaviour: `critique()` looks for `vNN/critiques/<critic>.json` (a replayed round) and then `vNN/inbox/<critic>.json` (a fresh answer). Present and valid — parse and return. Absent — record it as pending and throw a sentinel so `runCommittee`'s `allSettled` collects every critic's outcome before the caller sees anything. After the committee resolves, `throwIfPending()` raises one `WorkOrderPending` naming **every** missing critic.

`runCommittee` retries a failed critic once. A pending sentinel must not be retried — it is not a transient failure — so the sentinel carries `status: 400`, which `retryable()` in `llm.ts` already treats as non-retryable. Verify that against `NON_RETRYABLE_STATUS` before implementing.

- [ ] **Step 1: Write the failing test**

Create `test/critics/agent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLlmClient, WorkOrderPending } from "../../src/critics/agent.js";
import { runCommittee } from "../../src/critics/llm.js";
import { versionName, type RoundCursor } from "../../src/cli/resume.js";
import type { Config, Contract, CriticName } from "../../src/types.js";

const cfg = { models: { critic: "agent", chair: "agent" } } as Config;
const contract = { tokens: {}, brief: "", config: cfg, screens: { home: "spec" } } as unknown as Contract;
const input = { contract, screen: "home", digest: "d", imagePng: Buffer.from("p"), openIssues: [], measurements: [] };

const critique = (critic: CriticName, score: number) => ({
  critic, score, issues: [], resolved: { claimed: [], verified: [] },
});

const setup = (files: Partial<Record<CriticName, unknown>>, where: "inbox" | "critiques" = "inbox") => {
  const dir = mkdtempSync(join(tmpdir(), "dl-agent-"));
  const base = join(dir, versionName(0));
  mkdirSync(join(base, where), { recursive: true });
  for (const [critic, body] of Object.entries(files)) {
    writeFileSync(join(base, where, `${critic}.json`), JSON.stringify(body));
  }
  return dir;
};

describe("AgentLlmClient", () => {
  it("names every missing critic in one work order, not just the first", async () => {
    const runDir = setup({ typography: critique("typography", 71) });
    const cursor: RoundCursor = { index: 0 };
    const client = new AgentLlmClient({ runDir, cursor });

    await runCommittee(input, cfg, client);
    expect(() => client.throwIfPending()).toThrow(WorkOrderPending);
    try {
      client.throwIfPending();
    } catch (err) {
      const pending = err as WorkOrderPending;
      expect(pending.version).toBe("v00");
      expect(pending.units.map((u) => u.critic).sort())
        .toEqual(["accessibility", "behavioural", "feasibility"]);
    }
  });

  it("returns every critique once the inbox is complete", async () => {
    const runDir = setup({
      typography: critique("typography", 71), behavioural: critique("behavioural", 64),
      accessibility: critique("accessibility", 80), feasibility: critique("feasibility", 55),
    });
    const client = new AgentLlmClient({ runDir, cursor: { index: 0 } });

    const out = await runCommittee(input, cfg, client);
    expect(client.throwIfPending()).toBeUndefined();
    expect(out.critiques).toHaveLength(4);
    expect(out.dropped).toEqual([]);
  });

  it("prefers an archived critique over the inbox, so a replayed round is stable", async () => {
    const runDir = setup({ typography: critique("typography", 11) }, "critiques");
    mkdirSync(join(runDir, versionName(0), "inbox"), { recursive: true });
    writeFileSync(join(runDir, versionName(0), "inbox", "typography.json"),
      JSON.stringify(critique("typography", 99)));
    const client = new AgentLlmClient({ runDir, cursor: { index: 0 } });

    expect((await client.critique("typography", input, "agent")).score).toBe(11);
  });

  it("drops a malformed critique as a failed critic rather than crashing", async () => {
    const runDir = setup({
      typography: { critic: "typography", score: 999, issues: [], resolved: { claimed: [], verified: [] } },
      behavioural: critique("behavioural", 64), accessibility: critique("accessibility", 80),
      feasibility: critique("feasibility", 55),
    });
    const client = new AgentLlmClient({ runDir, cursor: { index: 0 } });

    const out = await runCommittee(input, cfg, client);
    expect(client.throwIfPending()).toBeUndefined();
    expect(out.dropped).toEqual(["typography"]);
    expect(out.failures[0]!.error).toMatch(/score is not a number in 0\.\.100/);
    expect(out.critiques).toHaveLength(3);
  });

  it("does not retry a pending critic", async () => {
    const runDir = setup({});
    const client = new AgentLlmClient({ runDir, cursor: { index: 0 } });
    let calls = 0;
    const counted = { ...client, critique: (...a: Parameters<typeof client.critique>) => { calls++; return client.critique(...a); } };

    await runCommittee(input, cfg, counted as typeof client);
    expect(calls).toBe(4); // one per critic, never a second attempt
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run test/critics/agent.test.ts`
Expected: FAIL — cannot resolve `../../src/critics/agent.js`.

- [ ] **Step 3: Implement `src/critics/agent.ts`**

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { versionName, type RoundCursor } from "../cli/resume.js";
import { parseCritique } from "./schema.js";
import type { CriticInput, LlmClient } from "./llm.js";
import type { CriticName, Critique, Usage } from "../types.js";

export interface PendingUnit {
  critic: CriticName;
}

/** Not a failure: the round cannot continue until a subagent writes the named files. */
export class WorkOrderPending extends Error {
  constructor(
    readonly kind: "critics" | "chair",
    readonly version: string,
    readonly units: PendingUnit[],
  ) {
    super(`${kind} pending for ${version}: ${units.map((u) => u.critic).join(", ")}`);
    this.name = "WorkOrderPending";
  }
}

/**
 * A pending critic must not be retried — it is waiting, not failing. `runCommittee` retries anything
 * whose status is not in NON_RETRYABLE_STATUS, so the sentinel claims 400.
 */
class Pending extends Error {
  readonly status = 400;
  constructor(readonly critic: CriticName) {
    super(`${critic} has not answered yet`);
  }
}

const readJson = async (file: string): Promise<unknown | null> => {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
};

/**
 * Reads a critique a Claude Code subagent wrote. The archived `critiques/` copy wins over `inbox/`, so
 * replaying an already-scored round can never pick up a newer answer and change a past score.
 */
export class AgentLlmClient implements LlmClient {
  private readonly runDir: string;
  private readonly cursor: RoundCursor;
  private pending: PendingUnit[] = [];

  constructor(opts: { runDir: string; cursor: RoundCursor }) {
    this.runDir = opts.runDir;
    this.cursor = opts.cursor;
  }

  get version(): string {
    return versionName(this.cursor.index);
  }

  async critique(critic: CriticName, _input: CriticInput, _model: string): Promise<Critique> {
    const dir = join(this.runDir, this.version);
    const raw = (await readJson(join(dir, "critiques", `${critic}.json`)))
      ?? (await readJson(join(dir, "inbox", `${critic}.json`)));
    if (raw === null) {
      this.pending.push({ critic });
      throw new Pending(critic);
    }
    return parseCritique(critic, raw);
  }

  /** Raises one work order naming every critic still to answer. Called after the committee settles. */
  throwIfPending(): void {
    if (this.pending.length === 0) return;
    const units = [...this.pending];
    this.pending = [];
    throw new WorkOrderPending("critics", this.version, units);
  }

  /** Subagent tokens never reach this process, so agent mode reports no usage at all. */
  takeUsage(): Usage | undefined {
    return undefined;
  }
}
```

Note `takeUsage` returns `undefined`. `LlmClient.takeUsage` is optional and `addUsage` already ignores `undefined`; `pricedTotal` in `calibrate.ts` keys off `llm.takeUsage` being defined, so if that matters later, omit the method entirely instead. Check `src/cli/run.ts`'s `addUsage(criticUsage, criticTokens)` handles it — it does, via its `if (!more) return`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run test/critics/ && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/critics/agent.ts test/critics/agent.test.ts
git commit -m "feat(critics): read critiques written by Claude Code subagents

One work order names every missing critic, so a round suspends once rather
than four times. A malformed answer is the existing dropped-critic path."
```

---

### Task 8: The agent chair client

**Files:**
- Create: `src/chair/agent.ts`
- Test: `test/chair/agent.test.ts` (create)

**Interfaces:**
- Consumes: `WorkOrderPending` (Task 7); `readChair` (Task 4); `RoundCursor`, `versionName` (Task 6).
- Produces: `class AgentChairClient implements ChairClient` — constructor `{ runDir: string; cursor: RoundCursor }`.

The chair for round `n` decides the edit that becomes round `n+1`. It is called while the cursor still reads `n`, so its files live in `vNN/`, the same directory as the critiques it is reacting to.

- [ ] **Step 1: Write the failing test**

Create `test/chair/agent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentChairClient } from "../../src/chair/agent.js";
import { WorkOrderPending } from "../../src/critics/agent.js";
import { versionName, type RoundCursor } from "../../src/cli/resume.js";
import type { ChairInput, Issue } from "../../src/chair/chair.js";

const issue = (id: string): Issue =>
  ({ id, severity: "major", evidence: { selector: "#b1", observed: "o" }, claim: "c", fix: "f", effort: "low" });

const input: ChairInput = {
  critiques: [], openIssues: [issue("typography-001"), issue("behavioural-002")],
  imagePng: Buffer.from("p"), tokens: {}, regression: null,
};

const setup = (body?: unknown, where: "inbox/chair.json" | "chair.json" = "inbox/chair.json") => {
  const dir = mkdtempSync(join(tmpdir(), "dl-chair-agent-"));
  mkdirSync(join(dir, versionName(0), "inbox"), { recursive: true });
  if (body !== undefined) writeFileSync(join(dir, versionName(0), where), JSON.stringify(body));
  return dir;
};

describe("AgentChairClient", () => {
  it("suspends when the chair has not answered", async () => {
    const client = new AgentChairClient({ runDir: setup(), cursor: { index: 0 } });
    await expect(client.synthesise(input, "agent")).rejects.toThrow(WorkOrderPending);
  });

  it("resolves change ids against the open issues and never invents one", async () => {
    const runDir = setup({ prompt: "make the button bigger", changeIds: ["typography-001", "ghost-999"] });
    const client = new AgentChairClient({ runDir, cursor: { index: 0 } });

    const out = await client.synthesise(input, "agent");
    expect(out.prompt).toBe("make the button bigger");
    expect(out.changes.map((c) => c.id)).toEqual(["typography-001"]);
  });

  it("prefers the archived answer over the inbox", async () => {
    const runDir = setup({ prompt: "archived", changeIds: [] }, "chair.json");
    writeFileSync(join(runDir, versionName(0), "inbox", "chair.json"),
      JSON.stringify({ prompt: "newer", changeIds: [] }));
    const client = new AgentChairClient({ runDir, cursor: { index: 0 } });

    expect((await client.synthesise(input, "agent")).prompt).toBe("archived");
  });

  it("refuses an empty prompt", async () => {
    const runDir = setup({ prompt: "   ", changeIds: [] });
    const client = new AgentChairClient({ runDir, cursor: { index: 0 } });
    await expect(client.synthesise(input, "agent")).rejects.toThrow(/empty prompt/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run test/chair/agent.test.ts`
Expected: FAIL — cannot resolve `../../src/chair/agent.js`.

- [ ] **Step 3: Implement `src/chair/agent.ts`**

```ts
import { join } from "node:path";
import { versionName, type RoundCursor } from "../cli/resume.js";
import { WorkOrderPending } from "../critics/agent.js";
import { readChair } from "../store/store.js";
import type { ChairClient, ChairInput } from "./chair.js";
import type { Issue, Usage } from "../types.js";

/**
 * Reads the edit prompt a Claude Code subagent wrote. The cap and the ranking stay in `chair()`: the
 * agent names issues by id and never writes one, so it cannot fabricate an issue, and it cannot
 * overrule MAX_CHANGES.
 */
export class AgentChairClient implements ChairClient {
  private readonly runDir: string;
  private readonly cursor: RoundCursor;

  constructor(opts: { runDir: string; cursor: RoundCursor }) {
    this.runDir = opts.runDir;
    this.cursor = opts.cursor;
  }

  async synthesise(input: ChairInput, _model: string): Promise<{ prompt: string; changes: Issue[] }> {
    const version = versionName(this.cursor.index);
    const raw = (await readChair(this.runDir, version))
      ?? (await readChair(join(this.runDir, version), "inbox"));
    if (raw === null) throw new WorkOrderPending("chair", version, []);

    const byId = new Map(input.openIssues.map((i) => [i.id, i] as const));
    const changes: Issue[] = [];
    for (const id of new Set(raw.changeIds)) {
      const issue = byId.get(id);
      if (issue) changes.push(issue);
    }
    return { prompt: raw.prompt, changes };
  }

  takeUsage(): Usage | undefined {
    return undefined;
  }
}
```

`readChair(runDir, version)` resolves `<runDir>/<version>/chair.json`, so the inbox read above is
`readChair(join(this.runDir, version), "inbox")` → `<runDir>/vNN/inbox/chair.json`. That works but reads
oddly; if it feels too clever, add an explicit second argument to `readChair` instead. Either is fine —
pick one and keep it consistent.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run test/chair/ && pnpm typecheck`
Expected: PASS, with `chair.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/chair/agent.ts test/chair/agent.test.ts
git commit -m "feat(chair): read the edit prompt from a subagent's answer

Ranking and the three-change cap stay in chair(); the agent names issue ids
and cannot invent one."
```

---

### Task 9: `dl step`, the work order, and exit code 10

The command that ties it together, plus the skill that drives it.

**Files:**
- Create: `src/cli/step.ts`
- Modify: `src/cli/main.ts`, `skills/design-loop/SKILL.md`
- Test: `test/cli/step.test.ts` (create)

**Interfaces:**
- Consumes: everything from Tasks 3–8.
- Produces:
  - `stepRun(opts: StepOptions): Promise<StepResult>` where `StepResult = { done: true; result: RunResult } | { done: false; workOrder: string }`.
  - `writeWorkOrder(...)` — writes `<runDir>/<version>/work-order.json`.
  - Exit code **10** from `main` meaning "a work order is waiting".

- [ ] **Step 1: Write the failing test**

Create `test/cli/step.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepRun } from "../../src/cli/step.js";
import { FakeGenerator } from "../../src/stitch/adapter.js";
import type { CriticName } from "../../src/types.js";

const FIX = new URL("../fixtures/design/", import.meta.url).pathname;
const DATE = "2026-09-20";
const CRITICS: CriticName[] = ["typography", "behavioural", "accessibility", "feasibility"];

const setup = () => {
  const d = mkdtempSync(join(tmpdir(), "dl-step-"));
  cpSync(FIX, d, { recursive: true, filter: (src) => !src.includes(".design-loop") });
  const cfgFile = join(d, "config.json");
  writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, "utf8")), criticMode: "agent" }));
  return d;
};

const page = (btn: number) =>
  `<!doctype html><html><body style="margin:0;background:#0B0B0F">
   <button id="b1" style="width:${btn}px;height:${btn}px;background:#FF7A1A;color:#0B0B0F">Go</button>
   </body></html>`;
const shot = (btn: number) => ({ html: page(btn), png: Buffer.from("p") });

const answer = (runDir: string, version: string, critic: CriticName, score: number) => {
  const dir = join(runDir, version, "inbox");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${critic}.json`),
    JSON.stringify({ critic, score, issues: [], resolved: { claimed: [], verified: [] } }));
};

const step = (designDir: string, runDir?: string) =>
  stepRun({ designDir, screen: "home", date: DATE, runDir, generator: new FakeGenerator([shot(48), shot(48)]) });

describe("stepRun", () => {
  it("suspends after the first generation with a work order naming all four critics", async () => {
    const designDir = setup();
    const out = await step(designDir);
    expect(out.done).toBe(false);

    const order = JSON.parse(readFileSync((out as { workOrder: string }).workOrder, "utf8"));
    expect(order.kind).toBe("critics");
    expect(order.version).toBe("v00");
    expect(order.units.map((u: { critic: string }) => u.critic).sort()).toEqual([...CRITICS].sort());
    expect(order.units[0].agent).toMatch(/^design-loop-/);
    expect(order.units[0].output).toBe("v00/inbox/typography.json");
  });

  it("writes the committee's inputs beside the work order", async () => {
    const designDir = setup();
    const out = await step(designDir);
    const runDir = join(designDir, "runs", `${DATE}-home`);
    expect(existsSync(join(runDir, "v00", "digest.txt"))).toBe(true);
    expect(existsSync(join(runDir, "v00", "screen.png"))).toBe(true);
    expect(existsSync(join(runDir, "v00", "screen-id.txt"))).toBe(true);
    expect(JSON.parse(readFileSync(join(runDir, "v00", "carried-issues.json"), "utf8"))).toEqual([]);
    void out;
  });

  it("finishes the run once the inbox is filled and the gate passes", async () => {
    const designDir = setup();
    await step(designDir);
    const runDir = join(designDir, "runs", `${DATE}-home`);
    for (const c of CRITICS) answer(runDir, "v00", c, 90);

    const out = await step(designDir, runDir);
    expect(out.done).toBe(true);
    expect(existsSync(join(runDir, "manifest.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
    expect(manifest.stopReason).toBe("pass");
  });

  it("makes no second Stitch generation when replaying round 0", async () => {
    const designDir = setup();
    await step(designDir);
    const runDir = join(designDir, "runs", `${DATE}-home`);
    for (const c of CRITICS) answer(runDir, "v00", c, 90);

    const gen = new FakeGenerator([shot(48)]);
    const out = await stepRun({ designDir, screen: "home", date: DATE, runDir, generator: gen });
    expect(gen.prompts).toEqual([]);   // the script would have thrown if it had been used twice
    expect(out.done).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run test/cli/step.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/step.js`.

- [ ] **Step 3: Implement `src/cli/step.ts`**

```ts
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentLlmClient, WorkOrderPending } from "../critics/agent.js";
import { AgentChairClient } from "../chair/agent.js";
import { measure } from "../measure/measure.js";
import { openRun, openExistingRun, writeAtomic } from "../store/store.js";
import type { Generator } from "../stitch/adapter.js";
import { resumingGenerator, resumingMeasure, resumingRun, type RoundCursor } from "./resume.js";
import { noProgress, type Progress } from "./progress.js";
import { runScreen, type RunResult } from "./run.js";
import type { CriticName } from "../types.js";

/** The directory a Claude Code subagent writes into, relative to the run directory. */
const CRITICS: CriticName[] = ["typography", "behavioural", "accessibility", "feasibility"];

export interface StepOptions {
  designDir: string;
  screen: string;
  date: string;
  /** Absent on the first step: the run directory is claimed here. */
  runDir?: string;
  generator: Generator;
  log?: (line: string) => void;
  progress?: Progress;
}

export type StepResult =
  | { done: true; result: RunResult; runDir: string }
  | { done: false; workOrder: string; runDir: string };

interface WorkUnit {
  critic: CriticName | "chair";
  agent: string;
  output: string;
  inputs: Record<string, string | null>;
}

const rel = (version: string, file: string): string => `${version}/${file}`;

function unitsFor(kind: "critics" | "chair", version: string, screen: string, pending: CriticName[]): WorkUnit[] {
  if (kind === "chair") {
    return [{
      critic: "chair",
      agent: "design-loop-chair",
      output: rel(version, "inbox/chair.json"),
      inputs: {
        screenshot: rel(version, "screen.png"),
        openIssues: rel(version, "open-issues.json"),
        critiques: rel(version, "critiques"),
        tokens: "tokens.json",
      },
    }];
  }
  return pending.map((critic) => ({
    critic,
    agent: `design-loop-${critic}`,
    output: rel(version, `inbox/${critic}.json`),
    inputs: {
      digest: rel(version, "digest.txt"),
      screenshot: rel(version, "screen.png"),
      html: rel(version, "screen.html"),
      screenSpec: `screens/${screen}.md`,
      brief: "brief.md",
      tokens: "tokens.json",
      carriedIssues: rel(version, "carried-issues.json"),
      // Deterministic findings are facts shown to the accessibility critic alone (spec §7).
      measurements: critic === "accessibility" ? rel(version, "measurements.json") : null,
    },
  }));
}

async function writeWorkOrder(opts: {
  runDir: string; designDir: string; screen: string; pending: WorkOrderPending;
}): Promise<string> {
  const { runDir, designDir, screen, pending } = opts;
  const file = join(runDir, pending.version, "work-order.json");
  await writeAtomic(file, `${JSON.stringify({
    kind: pending.kind,
    version: pending.version,
    screen,
    designDir: resolve(designDir),
    runDir: resolve(runDir),
    concurrency: 4,
    units: unitsFor(pending.kind, pending.version, screen, pending.units.map((u) => u.critic)),
  }, null, 2)}\n`);
  return file;
}

/**
 * Advances a run by one suspension. Everything already on disk is replayed for free; the first step
 * that needs an answer nobody has written stops and says what to dispatch.
 */
export async function stepRun(opts: StepOptions): Promise<StepResult> {
  const { designDir, screen, date, generator, log } = opts;
  const progress = opts.progress ?? noProgress;

  const run = opts.runDir
    ? await openExistingRun(opts.runDir)
    : await openRun(designDir, screen, date);
  const runDir = run.dir;

  const cursor: RoundCursor = { index: -1 };
  const llm = new AgentLlmClient({ runDir, cursor });
  const chairClient = new AgentChairClient({ runDir, cursor });

  try {
    const result = await runScreen({
      designDir, screen, date, log, progress,
      generator: resumingGenerator({ runDir, inner: generator, cursor }),
      measure: resumingMeasure({ runDir, inner: measure }),
      llm,
      chairClient,
      run: resumingRun(run, runDir),
    });
    return { done: true, result, runDir };
  } catch (err) {
    // The committee settles every critic before anything is thrown, so one work order names them all.
    if (err instanceof WorkOrderPending) {
      return { done: false, workOrder: await writeWorkOrder({ runDir, designDir, screen, pending: err }), runDir };
    }
    llm.throwIfPending();
    throw err;
  }
}
```

**`runScreen` needs two changes for this to work**, both small:

1. It calls `openRun(designDir, screen, date)` itself. Add an optional `run?: Run` to `RunOptions` and use `opts.run ?? await openRun(...)`, so `stepRun` can pass the resuming run.
2. After the committee phase, the pending critics must surface. In `run.ts`, immediately after the `progress.phase("critics", ...)` call, add:

```ts
      // In agent mode a settled committee may be settled because nobody has answered yet.
      (llm as { throwIfPending?: () => void }).throwIfPending?.();
```

Place it **before** the `committee.critiques.length === 0` check, so a round waiting on all four critics suspends rather than failing as "committee unavailable".

Also write the committee's inputs before the critics run. In `run.ts`, the version directory does not exist until `writeVersion`, so in agent mode `stepRun` needs them earlier. The simplest correct change: in `run.ts`, replace the single `run.writeVersion(...)` call with the handle sequence from Task 3 —

```ts
      const handle = await run.openVersion(n);
      await handle.writeGenerated({ png, html, doc, prompt, screenId: handle_.id, parent });
      await handle.writeCommitteeInputs({ digest, carriedIssues: carried, measurements: det.critique.issues });
      // ... committee, validation, scoring ...
      await handle.finish({ critiques: scored, composite: score, gatePass: verdict.pass, openIssues: open, changes });
      const written = handle.version;
```

`resumingRun.openVersion` throws on an already-scored version, so guard the replay path: have `resumingRun` return a **no-op handle** for a scored version instead of throwing — it should return a handle whose three write methods resolve immediately and whose `version` is the existing name. Update `resumingRun` in `src/cli/resume.ts` accordingly and add a test for it in `test/cli/resume.test.ts`.

- [ ] **Step 4: Wire the command into `main.ts`**

Add to `USAGE`:

```
  step <runDir>                      advance an agent-mode run by one round
```

Add the case:

```ts
      case "step": {
        need(1, "one argument: <runDir>");
        return await stepCommand(d, io, progress, designDir, args[0]!);
      }
```

And make `run` suspend in agent mode. In `runCommand`, load the config first and branch:

```ts
  const { config } = await loadContract(designDir, {}, screen, { allowNullSigma: true });
  if (config.criticMode === "agent") return await stepCommand(d, io, progress, designDir, undefined, screen, date);
```

`stepCommand` prints the run directory and the work order path, then returns `10`:

```ts
async function stepCommand(
  d: Deps, io: Io, progress: Progress, designDir: string, runDir?: string, screen?: string, date?: string,
): Promise<number> {
  const out = await d.stepRun({ designDir, screen: screen ?? (await screenOf(runDir!)), date: date ?? "", runDir, generator: d.makeGenerator(), log: (l) => io.out(l), progress });
  if (!out.done) {
    io.out(`Run: ${out.runDir}`);
    io.out(`Work order: ${out.workOrder}`);
    io.out(`Dispatch the agents it names, then: design-loop step ${out.runDir}`);
    return 10;
  }
  io.out(`Stop reason: ${out.result.stopReason}`);
  io.out(`Versions: ${out.result.versions}, best: ${out.result.best}`);
  io.out(`Report: ${await d.buildReport(out.runDir)}`);
  return out.result.stopReason === "aborted" ? 3 : 0;
}
```

The screen name and date for a resumed run come from `manifest.json` when it exists, and otherwise from the run directory's name — `openExistingRun` already parses `^(\d{4}-\d{2}-\d{2})-(.+?)(?:-\d+)?$` for exactly this. Reuse that logic rather than re-implementing it: export a small `runIdentity(runDir): Promise<{ screen: string; date: string }>` from `store.ts` and call it. Add `stepRun` to the `Deps` interface and to `defaultDeps`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. `main.test.ts` must still pass — API-mode `run` takes the old path untouched.

- [ ] **Step 6: Update the skill**

In `skills/design-loop/SKILL.md`, replace the body of **§3 Run** with the agent loop, keeping the cost warning:

````markdown
### 3. Run

Tell the user the cost first: **about $1–2 per screen** plus Stitch generations from the free-tier pool
(edits count). On their yes:

`dl run <screen>`. In `criticMode: "api"` this runs to completion as before. In `criticMode: "agent"`
it stops after each generation and hands you work:

1. Run `dl run <screen>` (first step) or `dl step <runDir>` (every step after).
2. Exit 0 — the run is finished. Go to step 4 below.
   Exit 10 — read the `work-order.json` path it printed.
3. For each unit in `units`, dispatch a subagent of the type named in `agent`. Give it the unit's
   `inputs` paths and its `output` path, and nothing else. Dispatch at most `concurrency` at a time.
   Wait for all of them, then go back to 1.

Paths in a work order are relative to `runDir` (or to `designDir` for `brief.md`, `tokens.json` and
`screens/`), both of which the file gives as absolute paths.

**Never write, edit or repair an inbox file yourself.** A critique you wrote is a fabricated critique:
it would be scored, carried into the next round and reported as a specialist's judgement. If an agent
fails or writes nothing, leave the file absent — `dl step` records it as a dropped critic and
renormalises the weights over the survivors. This is the same rule as "the user approves, you never
do", and it matters for the same reason.
````

Add to the **Never** section at the end of the file:

```markdown
- Never write, edit or repair a file under `runs/<run>/vNN/inbox/`. That is an agent's answer, not yours.
- Never re-run `dl step` while subagents are still working: it would write a work order for critics
  that are about to answer.
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/step.ts src/cli/run.ts src/cli/resume.ts src/cli/main.ts skills/design-loop/SKILL.md test/cli/step.test.ts test/cli/resume.test.ts
git commit -m "feat(cli): dl step, work orders and exit code 10

An agent-mode run suspends after each generation with a work order naming
every critic still to answer, and resumes by replaying the run directory."
```

---

### Task 10: `dl inspect`, the critics' tool

Lets a critic recover a field the digest dropped — the thing `ab-distiller` exists to measure — without being handed the whole HTML.

**Files:**
- Create: `src/cli/inspect.ts`
- Modify: `src/cli/main.ts`
- Test: `test/cli/inspect.test.ts` (create)

**Interfaces:**
- Consumes: nothing beyond `MeasuredDoc`.
- Produces: `inspectVersion(opts: { versionDir: string; selector?: string; text?: string }): Promise<MeasuredNode[]>`.

It queries the stored `MeasuredDoc` in `digest.json`. No Playwright, no re-render, no cost.

- [ ] **Step 1: Write the failing test**

Create `test/cli/inspect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectVersion } from "../../src/cli/inspect.js";
import type { MeasuredDoc } from "../../src/types.js";

const node = (selector: string, text: string, style: Record<string, string>) =>
  ({ selector, tag: "button", role: null, text, bbox: { x: 0, y: 0, w: 48, h: 48 }, style, depth: 1 });

const doc: MeasuredDoc = {
  viewport: { w: 390, h: 844 },
  nodes: [
    node("#b1", "Go", { fontSize: "14px", color: "rgb(11, 11, 15)" }),
    node("#b2", "Cancel", { fontSize: "16px", color: "rgb(255, 122, 26)" }),
  ],
};

const versionDir = () => {
  const d = mkdtempSync(join(tmpdir(), "dl-inspect-"));
  writeFileSync(join(d, "digest.json"), JSON.stringify(doc));
  return d;
};

describe("inspectVersion", () => {
  it("returns the node matching a selector, with every style property", async () => {
    const out = await inspectVersion({ versionDir: versionDir(), selector: "#b1" });
    expect(out).toHaveLength(1);
    expect(out[0]!.style.fontSize).toBe("14px");
  });

  it("finds nodes by a text substring, case-insensitively", async () => {
    const out = await inspectVersion({ versionDir: versionDir(), text: "cancel" });
    expect(out.map((n) => n.selector)).toEqual(["#b2"]);
  });

  it("returns an empty list rather than throwing when nothing matches", async () => {
    expect(await inspectVersion({ versionDir: versionDir(), selector: "#nope" })).toEqual([]);
  });

  it("refuses a call with neither a selector nor text", async () => {
    await expect(inspectVersion({ versionDir: versionDir() })).rejects.toThrow(/--selector or --text/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run test/cli/inspect.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/inspect.js`.

- [ ] **Step 3: Implement `src/cli/inspect.ts`**

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MeasuredDoc, MeasuredNode } from "../types.js";

/**
 * Answers a critic's question about one element from the measurements already taken for a version.
 * The digest is lossy by design; this is how a critic recovers a property it dropped, without the
 * whole HTML and without re-rendering anything.
 */
export async function inspectVersion(opts: {
  versionDir: string;
  selector?: string;
  text?: string;
}): Promise<MeasuredNode[]> {
  const { versionDir, selector, text } = opts;
  if (selector === undefined && text === undefined) {
    throw new Error("inspect needs --selector or --text");
  }
  const file = join(versionDir, "digest.json");
  const raw = await readFile(file, "utf8").catch(() => {
    throw new Error(`cannot read the measurements: ${file}`);
  });
  const doc = JSON.parse(raw) as MeasuredDoc;
  const needle = text?.toLowerCase();
  return doc.nodes.filter((n) =>
    (selector === undefined || n.selector === selector) &&
    (needle === undefined || n.text.toLowerCase().includes(needle)));
}
```

- [ ] **Step 4: Wire it into `main.ts`**

Add to `parseArgs` options: `selector: { type: "string" }, text: { type: "string" }`. Add to `USAGE`:

```
  inspect <versionDir>               look up measured nodes by --selector or --text
```

And the case, printing JSON to stdout so an agent can parse it:

```ts
      case "inspect": {
        need(1, "one argument: <versionDir>");
        const nodes = await inspectVersion({ versionDir: args[0]!, selector: values.selector, text: values.text });
        io.out(JSON.stringify(nodes, null, 2));
        return 0;
      }
```

Extend the existing `only(...)` guard so `--selector` and `--text` are rejected on other commands.

- [ ] **Step 5: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/inspect.ts src/cli/main.ts test/cli/inspect.test.ts
git commit -m "feat(cli): dl inspect, so a critic can check a selector itself

Queries the stored MeasuredDoc. No Playwright, no re-render, no cost — the
answer to what the digest drops."
```

---

### Task 11: `dl sync-agents` and the staleness refusal

A critic silently running an old rubric is the failure this prevents, so the check ships with the generator, not later.

**Files:**
- Create: `src/cli/agents.ts`, `src/chair/prompts/chair.md`
- Modify: `src/chair/chair.ts`, `src/cli/main.ts`, `src/cli/step.ts`, `.gitignore` (confirm `.claude/agents/` is **not** ignored)
- Test: `test/cli/agents.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `syncAgents(opts: { outDir: string }): Promise<string[]>` — writes five files, returns their paths.
  - `staleAgents(opts: { outDir: string }): Promise<string[]>` — names of agent files missing or out of date against their source rubric.

- [ ] **Step 1: Write the failing test**

Create `test/cli/agents.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAgents, staleAgents } from "../../src/cli/agents.js";

const outDir = () => mkdtempSync(join(tmpdir(), "dl-agents-"));

describe("syncAgents", () => {
  it("writes one file per critic plus the chair", async () => {
    const dir = outDir();
    const written = await syncAgents({ outDir: dir });
    expect(written.map((p) => p.split("/").pop()).sort()).toEqual([
      "design-loop-accessibility.md", "design-loop-behavioural.md", "design-loop-chair.md",
      "design-loop-feasibility.md", "design-loop-typography.md",
    ]);
  });

  it("carries the rubric body and a generated-file warning", async () => {
    const dir = outDir();
    await syncAgents({ outDir: dir });
    const body = readFileSync(join(dir, "design-loop-typography.md"), "utf8");
    expect(body).toMatch(/^---\nname: design-loop-typography\n/);
    expect(body).toMatch(/generated by `dl sync-agents`/);
    expect(body).toMatch(/src\/critics\/prompts\/typography\.md/);
  });

  it("grants only the tools a critic may use", async () => {
    const dir = outDir();
    await syncAgents({ outDir: dir });
    const body = readFileSync(join(dir, "design-loop-typography.md"), "utf8");
    expect(body).toMatch(/^tools: Read, Grep, Glob, Write, Bash$/m);
    expect(body).not.toMatch(/WebFetch|WebSearch/);
  });
});

describe("staleAgents", () => {
  it("reports every file as stale when none exist", async () => {
    expect((await staleAgents({ outDir: outDir() })).length).toBe(5);
  });

  it("reports nothing after a sync", async () => {
    const dir = outDir();
    await syncAgents({ outDir: dir });
    expect(await staleAgents({ outDir: dir })).toEqual([]);
  });

  it("notices an edited agent file", async () => {
    const dir = outDir();
    await syncAgents({ outDir: dir });
    writeFileSync(join(dir, "design-loop-typography.md"), "hand-edited");
    expect(await staleAgents({ outDir: dir })).toEqual(["design-loop-typography"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run test/cli/agents.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/agents.js`.

- [ ] **Step 3: Extract the chair's rubric**

Create `src/chair/prompts/chair.md` holding the exact text currently in the `INSTRUCTIONS` array in `src/chair/chair.ts`, joined by blank lines. In `chair.ts`, replace the array with a read of that file, following the memoised pattern `llm.ts` already uses for critic rubrics:

```ts
let chairRubric: string | undefined;
const INSTRUCTIONS = (): string =>
  (chairRubric ??= readFileSync(new URL("./prompts/chair.md", import.meta.url), "utf8").trimEnd());
```

Update the one use in `synthesise` from `INSTRUCTIONS` to `INSTRUCTIONS()`. `test/chair/chair.test.ts` must pass unchanged.

- [ ] **Step 4: Implement `src/cli/agents.ts`**

```ts
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CriticName } from "../types.js";

const CRITICS: CriticName[] = ["typography", "behavioural", "accessibility", "feasibility"];

interface Source {
  name: string;
  rubric: URL;
  source: string;
  purpose: string;
}

const sources = (): Source[] => [
  ...CRITICS.map((critic) => ({
    name: `design-loop-${critic}`,
    rubric: new URL(`../critics/prompts/${critic}.md`, import.meta.url),
    source: `src/critics/prompts/${critic}.md`,
    purpose: `the ${critic} critic of the design-loop committee`,
  })),
  {
    name: "design-loop-chair",
    rubric: new URL("../chair/prompts/chair.md", import.meta.url),
    source: "src/chair/prompts/chair.md",
    purpose: "the chair of the design-loop committee",
  },
];

const TOOLS = "Read, Grep, Glob, Write, Bash";

const body = (s: Source, rubric: string): string =>
  `---
name: ${s.name}
description: ${s.purpose}. Dispatched by the design-loop CLI from a work-order.json; not for general use.
tools: ${TOOLS}
---

<!-- generated by \`dl sync-agents\` from ${s.source}; edit that file, never this one -->

${rubric}

## How you are called

A work order gives you input paths and exactly one output path. Read the inputs, write your answer as
JSON to the output path, and write nothing else anywhere.

\`design-loop inspect <runDir>/<version> --selector "<css>"\` returns the measured node for a selector,
with every style property the digest dropped. Use it to check a claim before you make it: an issue
whose selector is absent from the measurements is discarded and counts against your hallucination rate.
`;

const digest = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The marker that lets staleness be checked without re-reading the rubric's whole text. */
const stamp = (rubric: string): string => `<!-- rubric ${digest(rubric)} -->`;

export async function syncAgents(opts: { outDir: string }): Promise<string[]> {
  await mkdir(opts.outDir, { recursive: true });
  const written: string[] = [];
  for (const s of sources()) {
    const rubric = (await readFile(s.rubric, "utf8")).trimEnd();
    const file = join(opts.outDir, `${s.name}.md`);
    await writeFile(file, `${body(s, rubric)}\n${stamp(rubric)}\n`);
    written.push(file);
  }
  return written.sort();
}

/** Agent files that are missing, hand-edited, or generated from an older rubric. */
export async function staleAgents(opts: { outDir: string }): Promise<string[]> {
  const stale: string[] = [];
  for (const s of sources()) {
    const rubric = (await readFile(s.rubric, "utf8")).trimEnd();
    const current = await readFile(join(opts.outDir, `${s.name}.md`), "utf8").catch(() => null);
    if (current === null || !current.includes(stamp(rubric))) stale.push(s.name);
  }
  return stale;
}
```

- [ ] **Step 5: Refuse to dispatch against stale agents**

In `src/cli/step.ts`, before writing a work order:

```ts
  const stale = await staleAgents({ outDir: join(resolve(designDir), "..", ".claude", "agents") });
```

That path guess is wrong in general. Take the agents directory as an explicit `agentsDir` option on `StepOptions`, defaulting in `main.ts` to `join(process.cwd(), ".claude", "agents")`, and refuse there:

```ts
  if (stale.length > 0) {
    throw new Error(
      `these agent definitions are missing or out of date: ${stale.join(", ")}. ` +
        "Run `design-loop sync-agents` — a critic running an old rubric scores against the wrong standard.",
    );
  }
```

Add a test to `test/cli/step.test.ts` asserting `stepRun` rejects with that message when `agentsDir` is empty.

- [ ] **Step 6: Wire the command into `main.ts`**

```
  sync-agents                        write .claude/agents/ from the critic rubrics
```

```ts
      case "sync-agents": {
        need(0, "no arguments");
        const written = await syncAgents({ outDir: join(process.cwd(), ".claude", "agents") });
        for (const f of written) io.out(`wrote ${f}`);
        return 0;
      }
```

- [ ] **Step 7: Run everything and generate the files**

Run: `pnpm test && pnpm typecheck && pnpm design-loop sync-agents`
Expected: PASS, and five files appear under `.claude/agents/`. Confirm `git check-ignore .claude/agents/design-loop-typography.md` prints nothing — they are committed so the repo carries them.

- [ ] **Step 8: Commit**

```bash
git add src/cli/agents.ts src/chair/prompts/chair.md src/chair/chair.ts src/cli/main.ts src/cli/step.ts .claude/agents test/cli/agents.test.ts test/cli/step.test.ts
git commit -m "feat(cli): generate agent definitions from the critic rubrics

One source of truth for each rubric, and dl step refuses to dispatch
against an agent file that has drifted from it."
```

---

### Task 12: Report an unmetered spend honestly

**Files:**
- Modify: `src/types.ts`, `src/store/store.ts`, `src/cli/run.ts`, `src/cli/main.ts`, `src/report/report.ts`, `README.md`
- Test: `test/report/report-spend.test.ts` (create)

**Interfaces:**
- Consumes: `Config.criticMode` (Task 2).
- Produces: `Spend.usd: number | null` and `Spend.criticMode: "api" | "agent"`.

Subagent tokens never reach the CLI. `$0.00` would be a lie the report repeats every time it is opened.

- [ ] **Step 1: Write the failing test**

Create `test/report/report-spend.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildReport } from "../../src/report/report.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runDir = (spend: object) => {
  const d = mkdtempSync(join(tmpdir(), "dl-spend-"));
  mkdirSync(join(d, "v00"));
  writeFileSync(join(d, "v00", "composite.json"), JSON.stringify({ composite: 70, gatePass: true }));
  writeFileSync(join(d, "v00", "screen.png"), Buffer.from("p"));
  writeFileSync(join(d, "v00", "open-issues.json"), "[]");
  writeFileSync(join(d, "v00", "prompt.txt"), "make it");
  mkdirSync(join(d, "v00", "critiques"));
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    screen: "home", date: "2026-09-20", stopReason: "pass", committeeRank: ["v00"], best: "v00",
    versions: [{ version: "v00", composite: 70, gatePass: true }],
    spend, hallucinationRate: {}, degradations: [], sigma: 1.8, calibration: null,
  }));
  return d;
};

describe("report spend", () => {
  it("says the spend was not metered in agent mode", async () => {
    const dir = runDir({ stitchGenerations: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: null, criticMode: "agent" });
    const html = readFileSync(await buildReport(dir), "utf8");
    expect(html).toMatch(/not metered \(agent mode\)/);
    expect(html).not.toMatch(/\$0\.00/);
  });

  it("still prints a dollar figure in api mode", async () => {
    const dir = runDir({ stitchGenerations: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, usd: 1.06, criticMode: "api" });
    expect(readFileSync(await buildReport(dir), "utf8")).toMatch(/\$1\.06/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run test/report/report-spend.test.ts`
Expected: FAIL — the report renders `$0.00` for a null `usd`.

- [ ] **Step 3: Implement**

`src/store/store.ts`, in `Spend`:

```ts
export interface Spend {
  stitchGenerations: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** null when the critics were subagents: their tokens never reach this process. */
  usd: number | null;
  criticMode: "api" | "agent";
}
```

`src/cli/run.ts` — skip the preflight price check and report `null` in agent mode:

```ts
  const agentMode = cfg.criticMode === "agent";
  if (!agentMode) {
    costUsd(cfg.models.critic, zero);
    costUsd(cfg.models.chair, zero);
  }
```

and in `finalise`:

```ts
    spend: {
      stitchGenerations,
      ...total,
      criticMode: cfg.criticMode,
      usd: agentMode ? null : costUsd(cfg.models.critic, criticUsage) + costUsd(cfg.models.chair, chairUsage),
    },
```

`src/report/report.ts` — find where the spend is formatted and render `null` as `not metered (agent mode)`. `src/cli/main.ts` already has a `usd(v: number | null)` helper that prints `unknown (no price for the model)`; give the report its own wording rather than reusing that one, since the cause is different. In `runCommand`, change the guard from `spend?.usd !== undefined` to also handle `null`:

```ts
  if (spend?.usd != null) io.out(`Spend: $${spend.usd.toFixed(2)}, ${spend.stitchGenerations ?? 0} Stitch generations`);
  else if (spend) io.out(`Spend: not metered (agent mode), ${spend.stitchGenerations ?? 0} Stitch generations`);
```

- [ ] **Step 4: Update the README**

Add `step`, `inspect` and `sync-agents` to the command table, a `criticMode` line to the design-folder section, and extend the exit-code list:

```markdown
- `10` — an agent-mode run is waiting: a `work-order.json` names the subagents to dispatch. Run `step` again after they have answered.
```

Add to **Known limits in v1**:

```markdown
- **Agent mode is not calibrated.** `calibrate` still runs through the API, so an agent-mode run
  inherits an API-mode sigma and warns loudly about it. Its spend is not metered either: subagent
  tokens never reach the CLI.
```

- [ ] **Step 5: Run everything**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/store/store.ts src/cli/run.ts src/cli/main.ts src/report/report.ts README.md test/report/report-spend.test.ts
git commit -m "feat(report): say when a spend was not metered instead of printing \$0

Subagent tokens never reach the CLI, so agent mode reports null and the
report says so rather than repeating a zero."
```

---

### Task 13: Replay equivalence

The load-bearing test of the whole design. If it passes, the resume layer is transparent and the stopping rule is provably unaffected by how critiques arrive.

**Files:**
- Test: `test/cli/replay-equivalence.test.ts` (create)

**Interfaces:**
- Consumes: everything.
- Produces: no source changes. If this test cannot be made to pass without changing `runScreen`'s logic, the suspend boundary was drawn in the wrong place — stop and say so rather than adjusting the loop.

- [ ] **Step 1: Write the test**

Create `test/cli/replay-equivalence.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScreen } from "../../src/cli/run.js";
import { stepRun } from "../../src/cli/step.js";
import { FakeGenerator } from "../../src/stitch/adapter.js";
import { syncAgents } from "../../src/cli/agents.js";
import type { CriticInput, LlmClient } from "../../src/critics/llm.js";
import type { ChairClient } from "../../src/chair/chair.js";
import type { CriticName, Critique } from "../../src/types.js";

const FIX = new URL("../fixtures/design/", import.meta.url).pathname;
const DATE = "2026-09-20";
const CRITICS: CriticName[] = ["typography", "behavioural", "accessibility", "feasibility"];

const page = (btn: number) =>
  `<!doctype html><html><body style="margin:0;background:#0B0B0F">
   <button id="b1" style="width:${btn}px;height:${btn}px;background:#FF7A1A;color:#0B0B0F">Go</button>
   </body></html>`;
const shot = (btn: number) => ({ html: page(btn), png: Buffer.from("p") });
const SCRIPT = [shot(30), shot(30), shot(48)];
const SCORES = [70, 74, 88];

const setup = (mode: "api" | "agent") => {
  const d = mkdtempSync(join(tmpdir(), `dl-eq-${mode}-`));
  cpSync(FIX, d, { recursive: true, filter: (src) => !src.includes(".design-loop") });
  const f = join(d, "config.json");
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), criticMode: mode }));
  return d;
};

/** The scripted answers both runs are driven by, so the only difference is how they arrive. */
const answerFor = (critic: CriticName, round: number): Critique =>
  ({ critic, score: SCORES[Math.min(round, SCORES.length - 1)]!, issues: [], resolved: { claimed: [], verified: [] } });

const CHAIR = { prompt: "make the button bigger", changeIds: [] as string[] };

describe("replay equivalence", () => {
  it("an agent-mode run driven by dl step matches an api-mode run exactly, apart from spend", async () => {
    // --- api mode, one process ---
    const apiDir = setup("api");
    const counts: Partial<Record<CriticName, number>> = {};
    const llm: LlmClient = {
      critique: async (critic: CriticName, _i: CriticInput) =>
        answerFor(critic, (counts[critic] = (counts[critic] ?? -1) + 1)),
      takeUsage: () => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 }),
    };
    const chairClient: ChairClient = {
      synthesise: async () => ({ prompt: CHAIR.prompt, changes: [] }),
      takeUsage: () => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 }),
    };
    const apiOut = await runScreen({
      designDir: apiDir, screen: "home", date: DATE,
      generator: new FakeGenerator([...SCRIPT]), llm, chairClient,
    });

    // --- agent mode, driven step by step ---
    const agentDir = setup("agent");
    await syncAgents({ outDir: join(agentDir, ".claude", "agents") });
    let runDir: string | undefined;
    const rounds: Partial<Record<CriticName, number>> = {};

    for (let guard = 0; guard < 20; guard++) {
      const out = await stepRun({
        designDir: agentDir, screen: "home", date: DATE, runDir,
        generator: new FakeGenerator([...SCRIPT]),
        agentsDir: join(agentDir, ".claude", "agents"),
      });
      runDir = out.runDir;
      if (out.done) break;

      const order = JSON.parse(readFileSync(join(out.workOrder), "utf8"));
      for (const unit of order.units as { critic: string; output: string }[]) {
        const file = join(out.runDir, unit.output);
        mkdirSync(join(file, ".."), { recursive: true });
        if (unit.critic === "chair") {
          writeFileSync(file, JSON.stringify(CHAIR));
        } else {
          const critic = unit.critic as CriticName;
          const round = (rounds[critic] = (rounds[critic] ?? -1) + 1);
          writeFileSync(file, JSON.stringify(answerFor(critic, round)));
        }
      }
    }

    expect(runDir).toBeDefined();
    expect(existsSync(join(runDir!, "manifest.json"))).toBe(true);

    const strip = (m: Record<string, unknown>) => {
      const { spend, ...rest } = m;
      void spend;
      return rest;
    };
    const apiManifest = JSON.parse(readFileSync(join(apiOut.runDir, "manifest.json"), "utf8"));
    const agentManifest = JSON.parse(readFileSync(join(runDir!, "manifest.json"), "utf8"));

    expect(strip(agentManifest)).toEqual(strip(apiManifest));
    expect(agentManifest.spend.usd).toBeNull();
    expect(apiManifest.spend.usd).not.toBeNull();
    expect(agentManifest.spend.stitchGenerations).toBe(apiManifest.spend.stitchGenerations);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm exec vitest run test/cli/replay-equivalence.test.ts`
Expected: PASS.

If the two manifests differ, read the diff before touching anything. Likely causes, in order: a field that records wall-clock time or a date (exclude it alongside `spend` and note why); `stitchGenerations` counting a replayed generation (the resume layer must not increment it — but note the counter lives in `runScreen`, so a replayed round *does* increment it, which is correct: the generation really did happen, just in an earlier process); `calibration.criticMode` differing between the two design folders. A difference in `committeeRank`, `sigma`, `stopReason`, `hallucinationRate` or `degradations` is a real bug in the resume layer, not a test to loosen.

- [ ] **Step 3: Run the whole suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, all green.

- [ ] **Step 4: Commit**

```bash
git add test/cli/replay-equivalence.test.ts
git commit -m "test: an agent-mode run matches an api-mode run exactly

The load-bearing test of the resume layer: the same scripted answers
delivered as files produce the same manifest, apart from spend."
```

---

## Self-review

**Spec coverage.** Every section maps to a task: resumable step machine → 6, 9; replay not checkpoint → 6, 13; suspend boundary → 7, 8; extra persisted files → 3, 4; screen rehydration → 5; work order → 9; ingest validation moved out → 1; tools for critics → 10, 11; generated agent definitions → 11; chair as agent → 8, 11; `criticMode` and sigma → 2; honest cost → 12; the skill → 9; composition with the candidate stage → work orders are a unit list (9), nothing further needed; code shape → matches the spec's file list; testing → 13 plus per-task tests.

**The one gap, stated deliberately:** agent-mode `calibrate` is deferred with its own plan, and the sigma gate ships as a warning rather than the refusal the spec specifies. Both are called out at the top of this document.

**Known rough edges an implementer will hit:**
- Task 9 changes `runScreen`'s version-writing from one `writeVersion` call to the `openVersion` handle sequence. That is the largest edit to the loop in this plan; it is confined to the write calls, and the replay-equivalence test in Task 13 is what proves it did not change behaviour.
- `resumingRun` must return a no-op handle for an already-scored version, not throw. Task 6 writes it one way and Task 9 corrects it; implement Task 9's version if you reach it first.
- `readChair`'s inbox lookup in Task 8 is written as a path trick. Adding an explicit argument to `readChair` is the cleaner choice; either is acceptable, but do not leave both.
