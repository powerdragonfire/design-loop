# Candidate Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate several first-round Stitch screens, have the specialist committee score them all, and start the existing edit loop from the winner instead of from Stitch's first answer.

**Architecture:** A new `src/cli/candidates.ts` owns the whole stage: read art directions, fan out one `generate_screen_from_text` per family plus one `generate_variants` per family, measure and critique every candidate, select a winner. `runScreen` calls it once and starts its loop at `n = 1` with the winner already scored. The loop, the chair, the stopping rule and the report's version timeline are untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 22, pnpm, vitest, zod, `@google/stitch-sdk` 0.3.5 over MCP.

**Spec:** `docs/superpowers/specs/2026-09-20-candidate-stage-design.md`

## Global Constraints

- Import specifiers inside `src/` and `test/` end in `.js`, never `.ts`.
- `ConfigSchema` in `src/contract/load.ts` is `z.strictObject` — an unknown key is a load error. Any new config key must be added there or configs carrying it will fail.
- `Config["weights"]` must sum to 1.0 ± 1e-9. Do not touch weights.
- Only `claude-sonnet-5`, `claude-opus-5` and `claude-haiku-4-5` have prices in `src/cli/pricing.ts`.
- Stitch `variantCount` is 1–5 inclusive. `creativeRange` ∈ `REFINE | EXPLORE | REIMAGINE`. `aspects` ⊆ `LAYOUT | COLOR_SCHEME | IMAGES | TEXT_FONT | TEXT_CONTENT`.
- `modelId` must stay omitted: the live API rejects `GEMINI_3_1_PRO` despite the SDK schema listing it.
- A design folder with no `candidates` block and no `directions.md` must behave exactly as today: one generation, no variants.
- Run `npx vitest run` and `npx tsc --noEmit` before every commit. Both must be clean.

---

### Task 1: Project every screen out of a Stitch response

`projectScreen` returns the first screen. `generate_variants` returns several, so the projection needs a plural form. `projectScreen` keeps working by delegating to it.

**Files:**
- Modify: `src/stitch/sdk.ts`
- Test: `test/stitch/sdk.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function projectScreens(raw: unknown, tool: string): ScreenData[]` — every screen across every output component, in order. Throws `StitchProjectionError` when there are none.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("projectScreen", ...)` block's file, as a new top-level `describe`:

```ts
describe("projectScreens", () => {
  const component = (screens: unknown[]) => ({ design: { screens } });

  it("returns every screen across every component, in order", () => {
    const raw = { outputComponents: [component([{ id: "a" }]), { text: "working" }, component([{ id: "b" }, { id: "c" }])] };
    expect(projectScreens(raw, "generate_variants").map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("drops non-object entries rather than returning holes", () => {
    const raw = { outputComponents: [component([null, { id: "a" }])] };
    expect(projectScreens(raw, "generate_variants").map((s) => s.id)).toEqual(["a"]);
  });

  it("throws the same projection error as the singular form when nothing carries a screen", () => {
    const raw = { outputComponents: [{ text: "still going" }] };
    expect(() => projectScreens(raw, "generate_variants")).toThrow(StitchProjectionError);
    expect(() => projectScreens(raw, "generate_variants")).toThrow(/1 output component\(s\)/);
  });
});
```

Add `projectScreens` to the import at the top of the file.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/stitch/sdk.test.ts`
Expected: FAIL — `projectScreens is not a function`.

- [ ] **Step 3: Implement**

In `src/stitch/sdk.ts`, replace the body of `projectScreen` with a delegation and add the plural form above it:

```ts
/**
 * Every screen the response carries. `generate_variants` returns several; `generate_screen_from_text`
 * and `edit_screens` return one, and `projectScreen` takes the first of these.
 */
export function projectScreens(raw: unknown, tool: string): ScreenData[] {
  if (raw === null || typeof raw !== "object") {
    throw new StitchProjectionError(tool, `the response was ${raw === null ? "null" : `a ${typeof raw}`}, not an object with outputComponents`);
  }
  const components = (raw as { outputComponents?: unknown }).outputComponents;
  if (!Array.isArray(components)) {
    throw new StitchProjectionError(tool, `the response was an object with keys [${keysOf(raw)}], but no outputComponents array`);
  }
  const screens = components.flatMap((c: unknown) => {
    const design = (c as { design?: { screens?: unknown } } | null)?.design;
    return Array.isArray(design?.screens) ? design.screens : [];
  });
  const usable = screens.filter((s: unknown): s is ScreenData => s !== null && typeof s === "object");
  if (usable.length === 0) {
    const shape = components.map((c) => `[${keysOf(c)}]`).join(", ");
    throw new StitchProjectionError(
      tool,
      `${components.length} output component(s) with keys ${shape}; ${screens.length} screens across them`,
    );
  }
  return usable;
}

export function projectScreen(raw: unknown, tool: string): ScreenData {
  return projectScreens(raw, tool)[0]!;
}
```

- [ ] **Step 4: Run the whole stitch suite**

Run: `npx vitest run test/stitch/`
Expected: PASS — the existing `projectScreen` tests still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/stitch/sdk.ts test/stitch/sdk.test.ts
git commit -m "feat(stitch): project every screen out of a response, not only the first"
```

---

### Task 2: Ask Stitch for variants of a screen

**Files:**
- Modify: `src/stitch/sdk.ts`, `src/stitch/adapter.ts`
- Test: `test/stitch/sdk.test.ts`, `test/stitch/adapter.test.ts`

**Interfaces:**
- Consumes: `projectScreens` from Task 1.
- Produces:
  - `export type CreativeRange = "REFINE" | "EXPLORE" | "REIMAGINE"`
  - `export type VariantAspect = "LAYOUT" | "COLOR_SCHEME" | "IMAGES" | "TEXT_FONT" | "TEXT_CONTENT"`
  - `export interface VariantOptions { variantCount: number; creativeRange: CreativeRange; aspects: VariantAspect[] }`
  - `SdkProject.variants(seedId: string, prompt: string, opts: VariantOptions, deviceType?: DeviceType, modelId?: ModelId): Promise<SdkScreen[]>`
  - `Generator.variants(seed: Screen, prompt: string, opts: VariantOptions): Promise<Screen[]>` on the adapter's `Generator` interface, reserving one quota unit per variant returned.

- [ ] **Step 1: Write the failing sdk test**

```ts
describe("createSdkProject.variants", () => {
  it("sends the variant options verbatim and wraps every screen returned", async () => {
    const callTool = vi.fn(async () => ({
      outputComponents: [{ design: { screens: [{ id: "v1" }, { id: "v2" }] } }],
    }));
    const project = createSdkProject("p1", callTool);
    const out = await project.variants("s0", "make it sing", { variantCount: 2, creativeRange: "EXPLORE", aspects: ["LAYOUT"] }, "MOBILE");
    expect(callTool).toHaveBeenCalledWith("generate_variants", {
      projectId: "p1",
      selectedScreenIds: ["s0"],
      prompt: "make it sing",
      deviceType: "MOBILE",
      modelId: undefined,
      variantOptions: { variantCount: 2, creativeRange: "EXPLORE", aspects: ["LAYOUT"] },
    });
    expect(out.map((s) => s.id)).toEqual(["v1", "v2"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/stitch/sdk.test.ts`
Expected: FAIL — `project.variants is not a function`.

- [ ] **Step 3: Implement in sdk.ts**

Add the types beside `DeviceType`, add `variants` to the `SdkProject` interface, and add this to the object `createSdkProject` returns, beside `generate`:

```ts
    variants: async (seedId, prompt, opts, deviceType, modelId) =>
      projectScreens(
        await callTool("generate_variants", {
          projectId,
          selectedScreenIds: [seedId],
          prompt,
          deviceType,
          modelId,
          variantOptions: opts,
        }),
        "generate_variants",
      ).map(screenOf),
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/stitch/sdk.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing adapter test**

```ts
  it("reserves one generation per variant returned, and wraps each", async () => {
    const inner = sdkScreen();
    const variants = vi.fn(async () => [sdkScreen({ id: "v1" }), sdkScreen({ id: "v2" })]);
    const { gen } = make({ generate: vi.fn(async () => inner), variants });
    const seed = await gen.generate("go");
    const out = await gen.variants(seed, "vary it", { variantCount: 2, creativeRange: "EXPLORE", aspects: ["LAYOUT"] });
    expect(variants).toHaveBeenCalledWith("s1", "vary it", { variantCount: 2, creativeRange: "EXPLORE", aspects: ["LAYOUT"] }, "MOBILE", undefined);
    expect(out.map((s) => s.id)).toEqual(["v1", "v2"]);
    expect((await readQuota(dir)).used).toBe(3); // 1 seed + 2 variants
  });

  it("announces the variant prompt before it is sent", async () => {
    const seen: unknown[] = [];
    const { gen } = make(
      { generate: vi.fn(async () => sdkScreen()), variants: vi.fn(async () => [sdkScreen({ id: "v1" })]) },
      { onPrompt: (p: unknown) => seen.push(p) },
    );
    const seed = await gen.generate("go");
    await gen.variants(seed, "vary it", { variantCount: 1, creativeRange: "REFINE", aspects: [] });
    expect(seen).toEqual([{ what: "generate", prompt: "go" }, { what: "variants", prompt: "vary it" }]);
  });
```

The local `make(...)` helper builds an `SdkProject`; extend its stub so a `variants` key passed in is used, defaulting to `async () => []`.

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run test/stitch/adapter.test.ts`
Expected: FAIL — `gen.variants is not a function`.

- [ ] **Step 7: Implement in adapter.ts**

Add `variants` to the `Generator` interface, re-export the three variant types, and add the method to `StitchGenerator`:

```ts
  /**
   * Quota is reserved per screen actually returned, after the call: Stitch may return fewer variants
   * than asked for, and reserving the requested count up front would spend generations that were
   * never made. The prompt is announced first, as `generate` and `edit` do.
   */
  async variants(seed: Screen, prompt: string, opts: VariantOptions): Promise<Screen[]> {
    this.onPrompt?.({ what: "variants", prompt });
    const made = await this.retry("variants", () => this.project.variants(seed.id, prompt, opts, this.deviceType, this.modelId), retryableCall);
    await reserve(this.quotaDir, made.length);
    return made.map((s) => this.wrap(s));
  }
```

Give `FakeGenerator` a matching `variants` that returns the next `opts.variantCount` scripted screens, so tests elsewhere can use it.

- [ ] **Step 8: Run the stitch suite and typecheck**

Run: `npx vitest run test/stitch/ && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/stitch/sdk.ts src/stitch/adapter.ts test/stitch/
git commit -m "feat(stitch): generate_variants through the adapter, with per-variant quota"
```

---

### Task 3: The `candidates` config block

**Files:**
- Modify: `src/types.ts`, `src/contract/load.ts`
- Test: `test/contract/load.test.ts`

**Interfaces:**
- Consumes: the variant types from Task 2.
- Produces: `Config["candidates"]: { families: number; variantsPerFamily: number; creativeRange: CreativeRange; aspects: VariantAspect[] }`, always present after load because the schema supplies defaults.

- [ ] **Step 1: Write the failing test**

```ts
  it("defaults the candidates block to today's single generation", async () => {
    const dir = await fixture({ config: { ...base, candidates: undefined } });
    const { config } = await loadContract(dir, {}, "home");
    expect(config.candidates).toEqual({ families: 1, variantsPerFamily: 0, creativeRange: "EXPLORE", aspects: [] });
  });

  it("accepts a candidates block and keeps its values", async () => {
    const dir = await fixture({ config: { ...base, candidates: { families: 2, variantsPerFamily: 2, creativeRange: "REIMAGINE", aspects: ["LAYOUT", "COLOR_SCHEME"] } } });
    const { config } = await loadContract(dir, {}, "home");
    expect(config.candidates.variantsPerFamily).toBe(2);
  });

  it("refuses more than five variants per family, Stitch's own cap", async () => {
    const dir = await fixture({ config: { ...base, candidates: { families: 1, variantsPerFamily: 6 } } });
    await expect(loadContract(dir, {}, "home")).rejects.toThrow(/candidates.variantsPerFamily/);
  });

  it("refuses a creativeRange Stitch does not accept", async () => {
    const dir = await fixture({ config: { ...base, candidates: { creativeRange: "WILD" } } });
    await expect(loadContract(dir, {}, "home")).rejects.toThrow(/candidates.creativeRange/);
  });
```

Match the fixture helper already used in that file; if it has no `fixture(...)`, follow whatever pattern the existing config tests use.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/contract/load.test.ts`
Expected: FAIL — `invalid config.json: candidates: Unrecognized key`.

- [ ] **Step 3: Implement**

In `src/contract/load.ts`, inside `ConfigSchema`:

```ts
  candidates: z
    .strictObject({
      families: z.number().int().min(1).default(1),
      variantsPerFamily: z.number().int().min(0).max(5).default(0),
      creativeRange: z.enum(["REFINE", "EXPLORE", "REIMAGINE"]).default("EXPLORE"),
      aspects: z.array(z.enum(["LAYOUT", "COLOR_SCHEME", "IMAGES", "TEXT_FONT", "TEXT_CONTENT"])).default([]),
    })
    .default({}),
```

Mirror the shape on `Config` in `src/types.ts`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/contract/ && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/contract/load.ts test/contract/load.test.ts
git commit -m "feat(contract): candidates block, defaulting to one generation"
```

---

### Task 4: Read art directions

**Files:**
- Create: `src/cli/candidates.ts`
- Test: `test/cli/candidates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export async function readDirections(designDir: string): Promise<string[]>` — the prose under each `## ` heading of `<designDir>/directions.md`, in file order. `[]` when the file is absent or has no headings.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDirections } from "../../src/cli/candidates.js";

describe("readDirections", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dl-")); });

  it("returns the prose under each heading, in file order", async () => {
    await writeFile(join(dir, "directions.md"), "# Directions\n\n## Agent first\n\nLead with the agent.\n\n## Form first\n\nLead with the form.\n");
    expect(await readDirections(dir)).toEqual(["Lead with the agent.", "Lead with the form."]);
  });

  it("joins a multi-paragraph direction into one block", async () => {
    await writeFile(join(dir, "directions.md"), "## One\n\nFirst line.\n\nSecond line.\n");
    expect(await readDirections(dir)).toEqual(["First line.\n\nSecond line."]);
  });

  it("returns nothing when the file is absent, so an existing design folder is unchanged", async () => {
    expect(await readDirections(dir)).toEqual([]);
  });

  it("returns nothing when the file has no level-two headings", async () => {
    await writeFile(join(dir, "directions.md"), "Just prose, no headings.\n");
    expect(await readDirections(dir)).toEqual([]);
  });

  it("skips a heading with no prose under it rather than yielding an empty direction", async () => {
    await writeFile(join(dir, "directions.md"), "## Empty\n\n## Real\n\nSomething.\n");
    expect(await readDirections(dir)).toEqual(["Something."]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/cli/candidates.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/candidates.js`.

- [ ] **Step 3: Implement**

Create `src/cli/candidates.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The art directions a run fans out over, one per `## ` heading of `directions.md`. The prose under a
 * heading is appended to the first prompt; the heading itself is only a label for a human reader.
 * A missing file is not an error: a design folder that has not opted in runs one family with no rider.
 */
export async function readDirections(designDir: string): Promise<string[]> {
  const raw = await readFile(join(designDir, "directions.md"), "utf8").catch(() => null);
  if (raw === null) return [];
  const out: string[] = [];
  for (const section of raw.split(/^## .*$/m).slice(1)) {
    const prose = section.trim();
    if (prose !== "") out.push(prose);
  }
  return out;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/cli/candidates.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/candidates.ts test/cli/candidates.test.ts
git commit -m "feat(cli): read art directions from directions.md"
```

---

### Task 5: Generate the candidates

**Files:**
- Modify: `src/cli/candidates.ts`, `test/cli/candidates.test.ts`

**Interfaces:**
- Consumes: `readDirections`; `Generator` and `VariantOptions` from Task 2; `Config["candidates"]` from Task 3; `buildFirstPrompt` from `src/cli/prompt.js`.
- Produces:
  - `export interface Candidate { id: string; family: number; prompt: string; handle: Screen }`
  - `export async function generateCandidates(opts: GenerateOptions): Promise<Candidate[]>` where
    `GenerateOptions = { contract: Contract; screen: string; designDir: string; generator: Generator; cfg: Config; progress: Progress }`.
    Ids are `c0`, `c1`, … in generation order: every family's seed first, then that family's variants.

- [ ] **Step 1: Write the failing test**

```ts
describe("generateCandidates", () => {
  const contract = { tokens: { color: { a: "#000000" } }, brief: "B", config: cfg(), screens: { home: "S" } } as any;
  const screenStub = (id: string) => ({ id, edit: async () => screenStub(id), getHtml: async () => "<p/>", getImage: async () => Buffer.from("") });

  it("makes one seed per family and the configured variants of each", async () => {
    const generate = vi.fn(async (p: string) => screenStub(`seed${generate.mock.calls.length}`));
    const variants = vi.fn(async (_s: any, _p: string, o: any) => Array.from({ length: o.variantCount }, (_, i) => screenStub(`v${i}`)));
    const out = await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate, variants } as any,
      cfg: cfg({ families: 2, variantsPerFamily: 2 }), progress: noProgress,
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(variants).toHaveBeenCalledTimes(2);
    expect(out.map((c) => c.id)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
    expect(out.map((c) => c.family)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it("appends each direction to its family's prompt, and leaves extra families bare", async () => {
    await writeFile(join(dir, "directions.md"), "## A\n\nLead with the agent.\n");
    const generate = vi.fn(async () => screenStub("s"));
    await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate, variants: async () => [] } as any,
      cfg: cfg({ families: 2, variantsPerFamily: 0 }), progress: noProgress,
    });
    expect(generate.mock.calls[0]![0]).toContain("Art direction: Lead with the agent.");
    expect(generate.mock.calls[1]![0]).not.toContain("Art direction:");
  });

  it("skips the variants call entirely when variantsPerFamily is zero", async () => {
    const variants = vi.fn(async () => []);
    const out = await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate: async () => screenStub("s"), variants } as any,
      cfg: cfg({ families: 1, variantsPerFamily: 0 }), progress: noProgress,
    });
    expect(variants).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
  });

  it("keeps the seed when a family's variants call fails, rather than losing the family", async () => {
    const variants = vi.fn(async () => { throw new Error("503 from Stitch"); });
    const out = await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate: async () => screenStub("s"), variants } as any,
      cfg: cfg({ families: 1, variantsPerFamily: 2 }), progress: noProgress,
    });
    expect(out.map((c) => c.id)).toEqual(["c0"]);
  });
});
```

Add a local `cfg(over = {})` helper returning a valid `Config` with `candidates` merged from `over`, and import `noProgress` from `../../src/cli/progress.js`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/cli/candidates.test.ts`
Expected: FAIL — `generateCandidates is not exported`.

- [ ] **Step 3: Implement**

Append to `src/cli/candidates.ts`:

```ts
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
```

Add the imports it needs: `buildFirstPrompt` from `./prompt.js`, `Generator`/`Screen` from `../stitch/adapter.js`, `Config`/`Contract` from `../types.js`, `Progress` from `./progress.js`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/cli/candidates.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/candidates.ts test/cli/candidates.test.ts
git commit -m "feat(cli): fan out candidate generation across families and variants"
```

---

### Task 6: Score and select

**Files:**
- Modify: `src/cli/candidates.ts`, `test/cli/candidates.test.ts`

**Interfaces:**
- Consumes: `Candidate`; `measure`, `distill`, `deterministicCritique`, `runCommittee`, `validateEvidence`, `composite`, `gate`, `openIssues` from their existing modules.
- Produces:
  - `export interface CandidateRow { id: string; family: number; composite: number; blockers: number; gatePass: boolean; png: Buffer; html: string; doc: MeasuredDoc; critiques: Critique[]; open: Issue[]; prompt: string; handle: Screen; failed?: string }`
  - `export interface Selection { winner: CandidateRow; rows: CandidateRow[] }`
  - `export async function selectCandidate(opts: SelectOptions): Promise<Selection>` where `SelectOptions = GenerateOptions & { llm: LlmClient; sigma: number; onDegraded(critic: CriticName, error: string, id: string): void }`.

- [ ] **Step 1: Write the failing selection test**

Test the pure selector separately from the I/O, so export it too:

```ts
describe("pickWinner", () => {
  const row = (id: string, composite: number, blockers: number): any => ({ id, composite, blockers });

  it("takes the highest composite when nothing is close", () => {
    expect(pickWinner([row("c0", 70, 0), row("c1", 85, 9)], 4).id).toBe("c1");
  });

  it("prefers fewer blockers among candidates within one sigma of the leader", () => {
    expect(pickWinner([row("c0", 85, 9), row("c1", 83, 1)], 4).id).toBe("c1");
  });

  it("ignores a candidate more than one sigma behind, however clean it is", () => {
    expect(pickWinner([row("c0", 85, 9), row("c1", 78, 0)], 4).id).toBe("c0");
  });

  it("breaks a blocker tie on composite, then on id, so selection is deterministic", () => {
    expect(pickWinner([row("c1", 83, 2), row("c0", 84, 2)], 4).id).toBe("c0");
    expect(pickWinner([row("c1", 84, 2), row("c0", 84, 2)], 4).id).toBe("c0");
  });

  it("never returns a candidate whose committee failed", () => {
    const dead = { ...row("c0", 99, 0), failed: "committee unavailable" };
    expect(pickWinner([dead, row("c1", 60, 3)], 4).id).toBe("c1");
  });

  it("throws when every candidate failed, because there is nothing to iterate", () => {
    const dead = { ...row("c0", 0, 0), failed: "committee unavailable" };
    expect(() => pickWinner([dead], 4)).toThrow(/no candidate could be scored/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/cli/candidates.test.ts`
Expected: FAIL — `pickWinner is not exported`.

- [ ] **Step 3: Implement the selector**

```ts
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
  if (scored.length === 0) throw new Error("no candidate could be scored: every committee failed");
  const leader = Math.max(...scored.map((r) => r.composite));
  const tied = scored.filter((r) => r.composite >= leader - sigma);
  return tied.sort((a, b) => a.blockers - b.blockers || b.composite - a.composite || a.id.localeCompare(b.id))[0]!;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/cli/candidates.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing scoring test**

```ts
describe("selectCandidate", () => {
  it("scores every candidate and returns the winner alongside all the rows", async () => {
    const sel = await selectCandidate(makeOpts({ families: 2, variantsPerFamily: 0 }));
    expect(sel.rows).toHaveLength(2);
    expect(sel.rows.every((r) => r.critiques.length === 4)).toBe(true);
    expect(sel.winner).toBe(sel.rows.find((r) => r.id === sel.winner.id));
  });

  it("marks a candidate whose committee failed and reports it, without failing the stage", async () => {
    const sel = await selectCandidate(makeOpts({ families: 2, variantsPerFamily: 0 }, { failFor: "c1" }));
    expect(sel.rows.find((r) => r.id === "c1")!.failed).toMatch(/committee/);
    expect(sel.winner.id).toBe("c0");
  });
});
```

`makeOpts` builds a `SelectOptions` over a fake `LlmClient` whose `critique` returns a fixed `Critique` per critic (and throws for the id named by `failFor`), and a `Generator` returning stub screens with real minimal HTML so `measure` produces at least one node.

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run test/cli/candidates.test.ts`
Expected: FAIL — `selectCandidate is not exported`.

- [ ] **Step 7: Implement the stage**

```ts
export async function selectCandidate(opts: SelectOptions): Promise<Selection> {
  const candidates = await generateCandidates(opts);
  const rows: CandidateRow[] = [];
  for (const c of candidates) {
    const [html, png] = [await c.handle.getHtml(), await c.handle.getImage()];
    const doc = await measure(html);
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
    const base = { id: c.id, family: c.family, prompt: c.prompt, handle: c.handle, png, html, doc };
    if (committee.critiques.length === 0) {
      rows.push({ ...base, composite: 0, blockers: 0, gatePass: false, critiques: [], open: [], failed: `committee unavailable: ${committee.failures.map((f) => f.error).join("; ")}` });
      continue;
    }
    const validated = validateEvidence(committee.critiques, doc);
    const critiques = [...validated.critiques, det.critique];
    const open = openIssues(critiques);
    rows.push({
      ...base,
      critiques,
      open,
      composite: composite(critiques, opts.cfg.weights),
      blockers: open.filter((i) => i.severity === "blocker").length,
      gatePass: gate(critiques, det.measurementsPass).pass,
    });
  }
  return { winner: pickWinner(rows, opts.sigma), rows };
}
```

Candidates are scored in sequence, not in parallel: `runCommittee` already fans out four critics per candidate, and six candidates at once would be twenty-four concurrent calls into the same rate limit.

- [ ] **Step 8: Run it and watch it pass**

Run: `npx vitest run test/cli/ && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/cli/candidates.ts test/cli/candidates.test.ts
git commit -m "feat(cli): score every candidate and select on composite with a blocker tie-break"
```

---

### Task 7: Persist candidates and promote the winner

**Files:**
- Modify: `src/store/store.ts`
- Test: `test/store/store.test.ts`

**Interfaces:**
- Consumes: `CandidateRow` from Task 6.
- Produces:
  - `export interface CandidateInput extends Omit<VersionInput, "index" | "parent" | "changes"> { id: string; family: number }`
    — the same payload a version takes, keyed by candidate id instead of round index, which is what makes promotion a plain copy.
- Produces, on `Run`:
  - `writeCandidate(c: CandidateInput): Promise<string>` — writes `candidates/<id>/` with `screen.png`, `screen.html`, `digest.json`, `composite.json`, `critiques/*.json`, `prompt.txt`, `family.txt`. Returns the directory name.
  - `writeSelection(s: SelectionInput): Promise<void>` — writes `candidates/selection.json`.
  - `promoteCandidate(id: string): Promise<string>` — copies `candidates/<id>/` to `v00/` and returns `"v00"`.
  - `approve(id)` accepts either `vNN` or `cN`.

- [ ] **Step 1: Write the failing test**

```ts
  it("writes a candidate directory with its critiques and prompt", async () => {
    const run = await openRun(dir, "home", "2026-09-20");
    const name = await run.writeCandidate({ id: "c0", family: 0, png: Buffer.from("p"), html: "<p/>", doc, critiques, composite: 80, gatePass: false, prompt: "P", openIssues: [] });
    expect(name).toBe("c0");
    expect(await readFile(join(run.dir, "candidates/c0/prompt.txt"), "utf8")).toBe("P");
    expect(await readFile(join(run.dir, "candidates/c0/family.txt"), "utf8")).toBe("0");
  });

  it("promotes a candidate to v00 by copying it, leaving the candidate in place", async () => {
    const run = await openRun(dir, "home", "2026-09-20");
    await run.writeCandidate({ id: "c1", family: 0, png: Buffer.from("png-bytes"), html: "<p/>", doc, critiques, composite: 80, gatePass: true, prompt: "P", openIssues: [] });
    expect(await run.promoteCandidate("c1")).toBe("v00");
    expect(await readFile(join(run.dir, "v00/screen.png"))).toEqual(Buffer.from("png-bytes"));
    expect(await readFile(join(run.dir, "candidates/c1/screen.png"))).toEqual(Buffer.from("png-bytes"));
  });

  it("approves a candidate id as readily as a version id", async () => {
    const run = await openRun(dir, "home", "2026-09-20");
    await run.writeCandidate({ id: "c2", family: 1, png: Buffer.from("p"), html: "<p/>", doc, critiques, composite: 80, gatePass: false, prompt: "P", openIssues: [] });
    await run.approve("c2");
    expect(JSON.parse(await readFile(join(run.dir, "candidates/c2/approved.json"), "utf8")).approved).toBe("c2");
  });

  it("refuses an id that could escape the run directory", async () => {
    const run = await openRun(dir, "home", "2026-09-20");
    await expect(run.promoteCandidate("../escape")).rejects.toThrow(/becomes part of a directory name/);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/store/store.test.ts`
Expected: FAIL — `run.writeCandidate is not a function`.

- [ ] **Step 3: Implement**

Extract the body of the existing `writeVersion` into a private `writeScreenDir(dirName, payload)` that both callers share — that identical layout is what makes promotion a plain copy. Then:

```ts
const CANDIDATE_ID = /^c\d+$/;
/** A candidate lives under candidates/, a version at the run root; approval and promotion both need the right one. */
const dirFor = (id: string): string => (CANDIDATE_ID.test(id) ? join("candidates", id) : id);

  async writeCandidate(c: CandidateInput): Promise<string> {
    assertSegment("candidate id", c.id);
    await writeScreenDir(join("candidates", c.id), c);
    await writeAtomic(join(dir, "candidates", c.id, "family.txt"), String(c.family));
    return c.id;
  },

  async writeSelection(s: SelectionInput): Promise<void> {
    await writeAtomic(join(dir, "candidates", "selection.json"), json(s));
  },

  /**
   * Copies rather than moves: `v00` must stay a complete version directory so `report`, `approve` and
   * the stop rule need no knowledge of candidates, and the candidate must stay readable in the gallery.
   */
  async promoteCandidate(id: string): Promise<string> {
    assertSegment("candidate id", id);
    await cp(join(dir, "candidates", id), join(dir, "v00"), { recursive: true });
    return "v00";
  },
```

`approve(id)` becomes `writeAtomic(join(dir, dirFor(id), "approved.json"), json({ approved: id, at: new Date().toISOString() }))`, with `assertSegment` applied to `id` first. Import `cp` from `node:fs/promises`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/store/ && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/store.ts test/store/store.test.ts
git commit -m "feat(store): candidate directories, promotion to v00, candidate approval"
```

---

### Task 8: Wire the stage into the run

**Files:**
- Modify: `src/cli/run.ts:64-175`
- Test: `test/cli/run.test.ts`

**Interfaces:**
- Consumes: `selectCandidate` from Task 6; `writeCandidate`/`writeSelection`/`promoteCandidate` from Task 7.
- Produces: no new exports. `RunResult` is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
  it("reserves quota for the candidates as well as the edits", async () => {
    await expect(runScreen(opts({ candidates: { families: 2, variantsPerFamily: 2 }, maxRounds: 5 }, { quotaRemaining: 10 })))
      .rejects.toThrow(/11 generations/);
  });

  it("starts the loop from the winning candidate, and counts the candidates it generated", async () => {
    const res = await runScreen(opts({ candidates: { families: 2, variantsPerFamily: 0 } }));
    const manifest = JSON.parse(await readFile(join(res.runDir, "manifest.json"), "utf8"));
    expect(manifest.spend.stitchGenerations).toBe(2 + manifest.versions.length - 1);
    expect(manifest.candidates).toHaveLength(2);
    expect(manifest.selection.winner).toMatch(/^c\d+$/);
  });

  it("does not measure or critique the winner twice", async () => {
    const { res, critiqueCalls } = await runWithCountingLlm(opts({ candidates: { families: 1, variantsPerFamily: 0 }, maxRounds: 0 }));
    expect(critiqueCalls).toBe(4); // the candidate only; v00 reuses its scores
    expect(res.versions).toBe(1);
  });

  it("generates exactly once when there is no candidates block and no directions.md", async () => {
    const { generate, variants } = await runWithCountingGenerator(opts({ maxRounds: 0 }));
    expect(generate).toBe(1);
    expect(variants).toBe(0);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/cli/run.test.ts`
Expected: FAIL — quota message still says 6, `manifest.candidates` undefined.

- [ ] **Step 3: Implement**

In `runScreen`:

1. Compute `const totalCandidates = cfg.candidates.families * (1 + cfg.candidates.variantsPerFamily);` and change the quota guard to `if (quota.remaining < totalCandidates + cfg.maxRounds)`, with the message using `totalCandidates + cfg.maxRounds`.
2. After `openRun` and the progress header, call `selectCandidate`, passing `onDegraded: (critic, error, id) => degradations.push({ version: id, critic, error })`.
3. Write every row with `run.writeCandidate`, then `run.writeSelection`, then `run.promoteCandidate(winner.id)`.
4. Seed the loop's state from the winner rather than re-scoring it: set `stitchGenerations = rows.length`, `prevDoc = winner.doc`, `carried = winner.open`, `prevOpen = winner.open`, and `records.set("v00", {...})` from the winner's fields; fold the candidate stage's critic usage into `criticUsage`.
5. Start the loop at `n = 1` with `baseHandle = winner.handle`, and drop the `n === 0` generate branch.
6. Pass `candidates` and `selection` through to `run.finalise`.

Keep the banner for the stage: `progress.banner("candidates · N generated", { fraction: 0 })`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/cli/run.ts test/cli/run.test.ts
git commit -m "feat(cli): run the candidate stage before the edit loop"
```

---

### Task 9: Show candidates in the report, and approve one

**Files:**
- Modify: `src/report/report.ts`, `src/cli/main.ts`
- Test: `test/report/report.test.ts`, `test/cli/main.test.ts`

**Interfaces:**
- Consumes: `candidates` and `selection` on the manifest from Task 8.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

```ts
  it("renders a candidate gallery above the versions and marks the winner", async () => {
    const html = await buildReport(runDirWithCandidates);
    expect(html).toContain("6 candidates");
    expect(html).toMatch(/c3[\s\S]{0,200}winner/i);
  });

  it("says why the winner won when it was not the highest composite", async () => {
    const html = await buildReport(runDirWhereTieBreakDecided);
    expect(html).toMatch(/within .* of the leader/i);
  });

  it("omits the gallery entirely for a run that had no candidate stage", async () => {
    const html = await buildReport(runDirSingleGeneration);
    expect(html).not.toContain("candidates");
  });
```

And in `test/cli/main.test.ts`:

```ts
  it("approves a candidate id", async () => {
    await main(["approve", runDir, "c3"], io, deps);
    expect(deps.captureApproval).toHaveBeenCalledWith(runDir, "c3");
  });

  it("rejects an id that is neither a version nor a candidate", async () => {
    await expect(main(["approve", runDir, "banana"], io, deps)).rejects.toThrow(/vNN or cN/);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/report/ test/cli/main.test.ts`
Expected: FAIL — no gallery in the output, `approve` rejects `c3`.

- [ ] **Step 3: Implement**

In `report.ts`, render a gallery section before the version timeline when `manifest.candidates` is present: one cell per candidate with its base64 screenshot, id, family, composite, blocker count and gate result, the winner marked, and a line naming the selection rule when the winner was not the top composite. Keep the page self-contained — base64 the PNGs exactly as the version screenshots already are.

In `main.ts`, widen the `approve` argument validation:

```ts
// A run's approvable things are its versions and, since the candidate stage, its candidates.
const APPROVABLE = /^(v\d+|c\d+)$/;
if (!APPROVABLE.test(version)) throw new UsageError(`not a version or candidate id: ${version} (expected vNN or cN)`);
```

and change the usage line to `approve <runDir> <vNN|cN>      record your pick for a run`.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Update the README**

In the commands table, note that `run` now generates `families × (1 + variantsPerFamily)` candidates first and that `approve` takes a candidate id. Add `directions.md` and `candidates/` to the design-folder tree. Update the cost caveat: the default 2 × 3 costs six generations and roughly $2.30 per screen.

- [ ] **Step 6: Commit**

```bash
git add src/report/report.ts src/cli/main.ts test/report/ test/cli/main.test.ts README.md
git commit -m "feat(report): candidate gallery, and approve a candidate by id"
```

---

## Manual verification

Once every task is committed, against the real Stitch API:

```bash
export ANTHROPIC_API_KEY=...  STITCH_PROJECT_ID=14022276310358537561

# 1. an unchanged design folder still generates exactly once
pnpm --dir ~/Projects/design-loop design-loop --design ~/Projects/design-loop/test/fixtures/design smoke

# 2. the real thing: 2 families x (1 + 2) = 6 candidates
cat > ~/Projects/What-Now/design/directions.md <<'EOF'
## Agent first
Lead with the agent stage: it fills the upper third and the form is a quiet list beneath it.

## Form first
Lead with the trip summary: the agent is a compact bar pinned above it, not a stage.
EOF

pnpm --dir ~/Projects/design-loop design-loop --design ~/Projects/What-Now/design run voice-agent --date 2026-09-22
pnpm --dir ~/Projects/design-loop design-loop --design ~/Projects/What-Now/design report ~/Projects/What-Now/design/runs/2026-09-22-voice-agent
```

Expect: six `candidates/c0..c5` directories each with four critiques, a `selection.json` naming the winner, a `v00` byte-identical to the winning candidate, a gallery at the top of `report.html`, and `Spend:` reporting six generations plus however many edits ran.

Expected cost: about $2.30 and 6–11 Stitch generations.
