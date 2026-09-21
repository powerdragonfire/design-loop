import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepRun, type StepResult } from "../../src/cli/step.js";
import { groupTokenIssues } from "../../src/cli/group.js";
import { FakeGenerator } from "../../src/stitch/adapter.js";
import type { CriticName, Issue } from "../../src/types.js";

/**
 * WHAT THIS FILE PROVES: an agent is briefed on what the API client would have been sent.
 *
 * The replay-equivalence test proves that replaying a run cannot change its outcome, but its chair names no
 * ids, it never carries an issue and it never regresses — so it cannot see what an agent is SHOWN. These
 * tests read the work order and the files it points at, the way a dispatched subagent does:
 *
 * - the chair sees the grouped open issues (the ids its answer is resolved against), and after a regression
 *   the best version's screenshot and the regression block, exactly as `AnthropicChairClient` would;
 * - each critic is told where to start numbering new issues, so a new issue cannot reuse a carried id and
 *   overwrite the carried issue without it ever being verified.
 */

const FIX = new URL("../fixtures/design/", import.meta.url).pathname;
const DATE = "2026-09-20";
const CRITICS: CriticName[] = ["typography", "behavioural", "accessibility", "feasibility"];

const setup = () => {
  const d = mkdtempSync(join(tmpdir(), "dl-brief-"));
  cpSync(FIX, d, { recursive: true, filter: (src) => !src.includes(".design-loop") });
  const cfgFile = join(d, "config.json");
  writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, "utf8")), criticMode: "agent" }));
  return d;
};

// Two paragraphs painted in the same off-token colour: two per-selector `det-token-color-*` issues, which
// the chair must be shown as ONE grouped issue.
const offToken = () =>
  `<!doctype html><html><body style="margin:0;background:#0B0B0F">
   <p id="p1" style="color:#123456">one</p><p id="p2" style="color:#123456">two</p>
   <button id="b1" style="width:48px;height:48px;background:#FF7A1A;color:#0B0B0F">Go</button>
   </body></html>`;
const page = (btn: number) =>
  `<!doctype html><html><body style="margin:0;background:#0B0B0F">
   <button id="b1" style="width:${btn}px;height:${btn}px;background:#FF7A1A;color:#0B0B0F">Go</button>
   </body></html>`;
const shot = (html: string) => ({ html, png: Buffer.from("p") });

const issue = (id: string, claim: string): Issue =>
  ({ id, severity: "major", evidence: { selector: "#b1", observed: "48x48" }, claim, fix: "f", effort: "low" });

const answer = (runDir: string, version: string, critic: CriticName, score: number, issues: Issue[] = []) => {
  const dir = join(runDir, version, "inbox");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${critic}.json`),
    JSON.stringify({ critic, score, issues, resolved: { claimed: [], verified: [] } }));
};

interface Unit { critic: string; output: string; nextIssueId?: string; inputs: Record<string, string | null> }
interface Order { kind: string; version: string; units: Unit[] }
const orderOf = (out: StepResult): Order => {
  if (out.done) throw new Error("the run finished instead of writing a work order");
  return JSON.parse(readFileSync(out.workOrder, "utf8")) as Order;
};

describe("the chair agent is briefed on the API chair's input", () => {
  it("shows the chair the grouped open issues, whose ids its answer is resolved against", async () => {
    const designDir = setup();
    const step = (runDir?: string) =>
      stepRun({ designDir, screen: "home", date: DATE, runDir, generator: new FakeGenerator([shot(offToken())]) });
    const first = await step();
    const runDir = first.runDir;
    for (const c of CRITICS) answer(runDir, "v00", c, 80);

    const out = await step(runDir);
    const order = orderOf(out);
    expect(order.kind).toBe("chair");
    const unit = order.units[0]!;
    expect(unit.inputs.chairInput).toBe("v00/chair-input.json");
    expect(unit.inputs.screenshot).toBe("v00/screen.png");

    const input = JSON.parse(readFileSync(join(runDir, unit.inputs.chairInput!), "utf8"));
    const stored = JSON.parse(readFileSync(join(runDir, "v00", "open-issues.json"), "utf8")) as Issue[];
    // The fixture really does produce a family worth grouping, or this test proves nothing.
    expect(stored.filter((i) => i.id.startsWith("det-token-color-")).length).toBe(2);
    expect(input.openIssues).toEqual(groupTokenIssues(stored));
    const ids = (input.openIssues as Issue[]).map((i) => i.id);
    expect(ids).toContain("det-token-group-color-1");
    expect(ids.some((id) => /^det-token-color-/.test(id))).toBe(false);
    expect(input.regression).toBeNull();
    expect(input.screenshot).toBe("v00/screen.png");
  }, 60_000);

  it("after a regression, shows the best version's screenshot and the regression block", async () => {
    const designDir = setup();
    const step = (runDir?: string) =>
      stepRun({ designDir, screen: "home", date: DATE, runDir, generator: new FakeGenerator([shot(page(48)), shot(page(50))]) });
    const runDir = (await step()).runDir;
    // v00 scores high but fails the gate on an open major, so the chair is asked.
    for (const c of CRITICS) answer(runDir, "v00", c, 90, c === "typography" ? [issue("typography-001", "carried")] : []);
    await step(runDir);
    writeFileSync(join(runDir, "v00", "inbox", "chair.json"), JSON.stringify({ prompt: "the failed edit", changeIds: [] }));
    await step(runDir);
    // v01 scores far lower: a regression, so the chair must work on v00.
    for (const c of CRITICS) answer(runDir, "v01", c, 30);

    const out = await step(runDir);
    const order = orderOf(out);
    expect(order.kind).toBe("chair");
    expect(order.version).toBe("v01");
    const unit = order.units[0]!;
    expect(unit.inputs.screenshot).toBe("v00/screen.png");

    const input = JSON.parse(readFileSync(join(runDir, unit.inputs.chairInput!), "utf8"));
    expect(input.screenshot).toBe("v00/screen.png");
    expect(input.regression).toMatchObject({ bestVersion: "v00", failedPrompt: "the failed edit" });
    expect(input.regression.delta).toBeLessThan(0);
    // The chair works on the best version, so it is shown the best version's open issues.
    const bestOpen = JSON.parse(readFileSync(join(runDir, "v00", "open-issues.json"), "utf8")) as Issue[];
    expect(input.openIssues).toEqual(groupTokenIssues(bestOpen));
  }, 60_000);
});

describe("a critic agent is told where to number new issues", () => {
  const stepper = (designDir: string) => (runDir?: string) =>
    stepRun({ designDir, screen: "home", date: DATE, runDir, generator: new FakeGenerator([shot(page(48)), shot(page(50))]) });

  /** Answers round 0 with one carried typography issue and has the chair ask for an edit; returns v01's order. */
  const toRoundOne = async (designDir: string) => {
    const step = stepper(designDir);
    const first = await step();
    const runDir = first.runDir;
    // Read now: v00's chair suspension will overwrite v00/work-order.json.
    const firstOrder = orderOf(first);
    for (const c of CRITICS) answer(runDir, "v00", c, 70, c === "typography" ? [issue("typography-001", "carried")] : []);
    await step(runDir);
    writeFileSync(join(runDir, "v00", "inbox", "chair.json"), JSON.stringify({ prompt: "edit", changeIds: [] }));
    return { firstOrder, runDir, order: orderOf(await step(runDir)) };
  };

  it("gives each critic unit the nextIssueId the API client would send", async () => {
    const { firstOrder, order } = await toRoundOne(setup());
    // Round 0 is a fresh start: every critic numbers from 001.
    expect(firstOrder.units.map((u) => [u.critic, u.nextIssueId])).toEqual(CRITICS.map((c) => [c, `${c}-001`]));
    expect(order.version).toBe("v01");
    expect(Object.fromEntries(order.units.map((u) => [u.critic, u.nextIssueId]))).toEqual({
      typography: "typography-002", behavioural: "behavioural-001",
      accessibility: "accessibility-001", feasibility: "feasibility-001",
    });
  }, 60_000);

  it("a new issue numbered as briefed does not silently close a carried one", async () => {
    const designDir = setup();
    const { runDir, order } = await toRoundOne(designDir);
    // The agent does what its brief says: a NEW issue gets the id it was given. An agent that was given
    // nothing starts at 001 — the rubric's own example — and silently replaces the carried issue.
    for (const u of order.units) {
      const critic = u.critic as CriticName;
      answer(runDir, "v01", critic, 72, critic === "typography" ? [issue(u.nextIssueId ?? "typography-001", "new")] : []);
    }
    await stepper(designDir)(runDir);
    const open = JSON.parse(readFileSync(join(runDir, "v01", "open-issues.json"), "utf8")) as Issue[];
    expect(open.filter((i) => i.id.startsWith("typography-")).map((i) => i.claim).sort()).toEqual(["carried", "new"]);
  }, 60_000);
});
