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
});
