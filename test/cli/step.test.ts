import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepRun } from "../../src/cli/step.js";
import { FakeGenerator, type Generator, type Screen } from "../../src/stitch/adapter.js";
import { DesignPending } from "../../src/figma/generator.js";
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

const major = (id: string) =>
  ({ id, severity: "major", evidence: { selector: "#b1", observed: "48x48" }, claim: "c", fix: "f", effort: "low" });

const answer = (runDir: string, version: string, critic: CriticName, score: number, issues: unknown[] = []) => {
  const dir = join(runDir, version, "inbox");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${critic}.json`),
    JSON.stringify({ critic, score, issues, resolved: { claimed: [], verified: [] } }));
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
    // The one candidate the run had, recorded from v00's own score, exactly as API mode records it.
    const v00 = manifest.versions[0];
    expect(manifest.candidates).toEqual([{ id: "c0", family: 0, composite: v00.composite, blockers: 0, gatePass: v00.gatePass }]);
    expect(manifest.selection).toEqual({ winner: "c0", rows: manifest.candidates });
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

  it("names only the critics still missing, not the ones already answered", async () => {
    const designDir = setup();
    await step(designDir);
    const runDir = join(designDir, "runs", `${DATE}-home`);
    answer(runDir, "v00", "typography", 80);
    answer(runDir, "v00", "accessibility", 80);

    const out = await step(designDir, runDir);
    expect(out.done).toBe(false);
    const order = JSON.parse(readFileSync((out as { workOrder: string }).workOrder, "utf8"));
    expect(order.units.map((u: { critic: string }) => u.critic)).toEqual(["behavioural", "feasibility"]);
  });

  // The whole point of the mode, end to end: suspend on the critics, suspend again on the chair, then carry
  // the chair's prompt into an edit and suspend on the NEXT round's critics — without ever finalising.
  describe("across rounds", () => {
    const openRound = async (designDir: string) => {
      await step(designDir);
      const runDir = join(designDir, "runs", `${DATE}-home`);
      // A major issue nobody resolved fails the gate, so the round does not stop and the chair is asked.
      for (const c of CRITICS) answer(runDir, "v00", c, 60, c === "typography" ? [major("t-1")] : []);
      return runDir;
    };

    it("suspends on the chair once the committee has answered, and does not finalise the run", async () => {
      const designDir = setup();
      const runDir = await openRound(designDir);

      const out = await step(designDir, runDir);
      expect(out.done).toBe(false);
      const order = JSON.parse(readFileSync((out as { workOrder: string }).workOrder, "utf8"));
      expect(order.kind).toBe("chair");
      expect(order.version).toBe("v00");
      expect(order.units).toHaveLength(1);
      expect(order.units[0].agent).toBe("design-loop-chair");
      expect(order.units[0].output).toBe("v00/inbox/chair.json");
      // v00 IS scored by now, so `rounds` is non-empty: a suspension read as a failure would have written a
      // manifest here, and a finalised run refuses every later write.
      expect(existsSync(join(runDir, "manifest.json"))).toBe(false);
      expect(existsSync(join(runDir, "v00", "composite.json"))).toBe(true);
    });

    // The candidate record must be v00's OWN scoring — the same composite, gate and open issues — not numbers
    // built to agree with an API run, or the replay-equivalence test's candidates/selection match proves
    // nothing. A blocker makes `blockers` non-trivial. Two further steps replay round 0, and each re-records c0:
    // neither may throw on the existing directory or change what the first recording wrote.
    it("records v00 as candidate c0 from v00's own scoring, and replays it without rewriting", async () => {
      const designDir = setup();
      await step(designDir);
      const runDir = join(designDir, "runs", `${DATE}-home`);
      const blocker = { ...major("a-1"), severity: "blocker" };
      for (const c of CRITICS) answer(runDir, "v00", c, 60, c === "accessibility" ? [blocker] : []);
      await step(designDir, runDir);

      const read = (...p: string[]) => readFileSync(join(runDir, ...p), "utf8");
      const c0 = { composite: read("candidates", "c0", "composite.json"), open: read("candidates", "c0", "open-issues.json") };
      expect(c0.composite).toBe(read("v00", "composite.json"));
      expect(c0.open).toBe(read("v00", "open-issues.json"));
      const blockers = (JSON.parse(c0.open) as { severity: string }[]).filter((i) => i.severity === "blocker").length;
      expect(blockers).toBeGreaterThan(0);
      const { composite, gatePass } = JSON.parse(c0.composite);
      expect(JSON.parse(read("candidates", "selection.json"))).toEqual({
        winner: "c0", rows: [{ id: "c0", family: 0, composite, blockers, gatePass }],
      });

      writeFileSync(join(runDir, "v00", "inbox", "chair.json"), JSON.stringify({ prompt: "fix it", changeIds: [] }));
      const out = await step(designDir, runDir);
      expect(out.done).toBe(false);
      expect((JSON.parse(readFileSync((out as { workOrder: string }).workOrder, "utf8")) as { version: string }).version).toBe("v01");
      expect(read("candidates", "c0", "composite.json")).toBe(c0.composite);
      expect(read("candidates", "c0", "open-issues.json")).toBe(c0.open);
    });

    it("edits from the chair's prompt and suspends on the next round's critics", async () => {
      const designDir = setup();
      const runDir = await openRound(designDir);
      await step(designDir, runDir);
      writeFileSync(join(runDir, "v00", "inbox", "chair.json"),
        JSON.stringify({ prompt: "make the button bigger", changeIds: ["t-1"] }));

      const gen = new FakeGenerator([shot(48), shot(64)]);
      const out = await stepRun({ designDir, screen: "home", date: DATE, runDir, generator: gen });
      expect(out.done).toBe(false);
      // Round 0 replayed for free; only the edit reached the generator.
      expect(gen.prompts).toEqual(["make the button bigger"]);

      const order = JSON.parse(readFileSync((out as { workOrder: string }).workOrder, "utf8"));
      expect(order.kind).toBe("critics");
      expect(order.version).toBe("v01");
      expect(order.units.map((u: { critic: string }) => u.critic)).toEqual(CRITICS);
      // The edited round is on disk in full, ready for the agents the order names.
      expect(readFileSync(join(runDir, "v01", "parent.txt"), "utf8")).toBe("v00");
      expect(existsSync(join(runDir, "v01", "screen-id.txt"))).toBe(true);
      expect(existsSync(join(runDir, "v01", "digest.txt"))).toBe(true);
      expect(existsSync(join(runDir, "manifest.json"))).toBe(false);
    });

    // The window the archive closes: v01 has been generated from v00's chair answer but not yet scored, so a
    // later step reopens it and rewrites its prompt.txt. Reading the inbox there would let an edited answer
    // become the recorded rationale for pixels that came from the old one.
    it("archives the chair's answer, so editing the inbox afterwards cannot rewrite a generated round", async () => {
      const designDir = setup();
      const runDir = await openRound(designDir);
      await step(designDir, runDir);
      const chairFile = join(runDir, "v00", "inbox", "chair.json");
      writeFileSync(chairFile, JSON.stringify({ prompt: "make the button bigger", changeIds: ["t-1"] }));
      await stepRun({ designDir, screen: "home", date: DATE, runDir, generator: new FakeGenerator([shot(48), shot(64)]) });
      expect(JSON.parse(readFileSync(join(runDir, "v00", "chair.json"), "utf8")).prompt).toBe("make the button bigger");
      expect(readFileSync(join(runDir, "v01", "prompt.txt"), "utf8")).toBe("make the button bigger");

      writeFileSync(chairFile, JSON.stringify({ prompt: "TAMPERED", changeIds: [] }));
      const gen = new FakeGenerator([shot(48), shot(64)]);
      await stepRun({ designDir, screen: "home", date: DATE, runDir, generator: gen });
      expect(readFileSync(join(runDir, "v01", "prompt.txt"), "utf8")).toBe("make the button bigger");
      expect(gen.prompts).toEqual([]);   // both rounds replayed; nothing was regenerated from the new answer
    });
  });

  // Agent mode has no way yet to brief a subagent on a candidate: work orders, the round cursor and the resume
  // layer all key on `vNN/`. A config asking for more than one candidate is refused rather than quietly run
  // with one, and refused before Stitch is asked for anything, because every generation is paid for.
  describe("design work orders", () => {
    const FIGMA = { fileKey: "Hd1q4ePvrHOmZerZZNmk9b", pageId: "266:2" };
    const readOrder = (out: unknown) =>
      JSON.parse(readFileSync((out as { workOrder: string }).workOrder, "utf8"));

    /** Cannot create a frame: suspends on every generation, like FigmaGenerator. */
    const designer = (): Generator => ({
      generate: async (p) => { throw new DesignPending(p, null); },
      variants: async () => [],
    });

    /**
     * Generates round 0 like Stitch (so the round can be measured and scored without a real Figma file) but
     * suspends on every edit, as a Figma frame must. `fromId` lets the resume layer rebuild v00 on replay.
     */
    const hybrid = (): Generator => {
      const inner = new FakeGenerator([shot(48)]);
      const figmaEdits = (s: Screen): Screen => ({
        id: s.id,
        edit: async (p) => { throw new DesignPending(p, s.id); },
        getHtml: () => s.getHtml(),
        getImage: () => s.getImage(),
      });
      return {
        generate: async (p) => figmaEdits(await inner.generate(p)),
        variants: async () => [],
        fromId: (id) => figmaEdits(inner.fromId!(id)),
      };
    };

    it("suspends a first generation with a design order that names no subagent", async () => {
      const designDir = setup();
      const out = await stepRun({ designDir, screen: "home", date: DATE, generator: designer(), figma: FIGMA });
      expect(out.done).toBe(false);
      expect((out as { kind?: string }).kind).toBe("design");

      const order = readOrder(out);
      expect(order.kind).toBe("design");
      expect(order.version).toBe("v00");
      expect(order.figma).toEqual(FIGMA);
      expect(order.instruction).toMatch(/Build a new frame on page 266:2/);
      expect(order.units).toHaveLength(1);
      const [unit] = order.units;
      expect(unit.agent).toBeNull();
      expect(unit.output).toBe("v00/screen-id.txt");
      expect(unit.inputs.editFrom).toBeNull();
      expect(unit.inputs.editFromVersion).toBeNull();

      const runDir = join(designDir, "runs", `${DATE}-home`);
      // The first-generation prompt, in full: brief, tokens and this screen's spec.
      expect(readFileSync(join(runDir, "v00", "design-prompt.txt"), "utf8")).toContain("Screen to design:");
      expect(existsSync(join(runDir, "manifest.json"))).toBe(false);
    });

    it("can be stepped again before the frame exists, and simply asks again", async () => {
      // Proves the run it left behind is re-openable: `openExistingRun` refuses a run with no vNN directory.
      const designDir = setup();
      const first = await stepRun({ designDir, screen: "home", date: DATE, generator: designer() });
      const again = await stepRun({ designDir, screen: "home", date: DATE, runDir: first.runDir, generator: designer() });
      expect(again.done).toBe(false);
      expect(readOrder(again).version).toBe("v00");
    });

    it("hands an edit back naming the frame to duplicate, its version and its screenshot", async () => {
      const designDir = setup();
      await stepRun({ designDir, screen: "home", date: DATE, generator: hybrid() });
      const runDir = join(designDir, "runs", `${DATE}-home`);
      for (const c of CRITICS) answer(runDir, "v00", c, 60, c === "typography" ? [major("t-1")] : []);
      await stepRun({ designDir, screen: "home", date: DATE, runDir, generator: hybrid() }); // chair order
      writeFileSync(join(runDir, "v00", "inbox", "chair.json"),
        JSON.stringify({ prompt: "make the button bigger", changeIds: ["t-1"] }));

      const out = await stepRun({ designDir, screen: "home", date: DATE, runDir, generator: hybrid(), figma: FIGMA });
      expect(out.done).toBe(false);
      const order = readOrder(out);
      expect(order.kind).toBe("design");
      expect(order.version).toBe("v01");
      const [unit] = order.units;
      expect(unit.inputs.editFrom).toBe("fake-0");
      expect(unit.inputs.editFromVersion).toBe("v00");
      expect(unit.inputs.editFromScreenshot).toBe("v00/screen.png");
      expect(order.instruction).toMatch(/Duplicate frame fake-0.*Never edit fake-0 in place/);
      expect(readFileSync(join(runDir, "v01", "design-prompt.txt"), "utf8")).toContain("make the button bigger");
      // A suspension, not an abort: nothing is finalised.
      expect(existsSync(join(runDir, "manifest.json"))).toBe(false);
    });
  });

  describe("multiple candidates", () => {
    const withCandidates = (designDir: string, candidates: Record<string, number>) => {
      const cfgFile = join(designDir, "config.json");
      writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, "utf8")), candidates }));
    };

    for (const candidates of [{ families: 2, variantsPerFamily: 0 }, { families: 1, variantsPerFamily: 1 }]) {
      it(`refuses ${JSON.stringify(candidates)} before any Stitch generation`, async () => {
        const designDir = setup();
        withCandidates(designDir, candidates);
        let variants = 0;
        const gen = new FakeGenerator([shot(48), shot(48), shot(48)]);
        const inner = gen.variants.bind(gen);
        gen.variants = (...args) => { variants++; return inner(...args); };

        const refusal = stepRun({ designDir, screen: "home", date: DATE, generator: gen });
        await expect(refusal).rejects.toThrow(/agent mode does not yet support multiple candidates/);
        await expect(refusal).rejects.toThrow(/candidates\.families.*candidates\.variantsPerFamily/);
        await expect(refusal).rejects.toThrow(/"families": 1.*"variantsPerFamily": 0.*"criticMode": "api"/);
        expect(gen.prompts).toEqual([]);
        expect(variants).toBe(0);
      });
    }
  });

  // A critic running an old rubric scores against a standard nobody chose, and nothing about the run would
  // say so — so a work order is refused, not just warned about, the moment `agentsDir` names a directory
  // that is not (or no longer) in sync with the rubrics `dl sync-agents` reads.
  describe("agent staleness", () => {
    it("rejects with a sync-agents message when agentsDir has no synced agent files", async () => {
      const designDir = setup();
      const agentsDir = mkdtempSync(join(tmpdir(), "dl-agents-empty-"));
      await expect(
        stepRun({ designDir, screen: "home", date: DATE, agentsDir, generator: new FakeGenerator([shot(48)]) }),
      ).rejects.toThrow(/sync-agents/);
    });
  });
});
