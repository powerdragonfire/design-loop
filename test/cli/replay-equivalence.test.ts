import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScreen } from "../../src/cli/run.js";
import { stepRun } from "../../src/cli/step.js";
import { syncAgents } from "../../src/cli/agents.js";
import { FakeGenerator } from "../../src/stitch/adapter.js";
import { measure } from "../../src/measure/measure.js";
import type { CriticInput, LlmClient } from "../../src/critics/llm.js";
import type { ChairClient } from "../../src/chair/chair.js";
import type { CriticName, Critique, Issue, MeasuredDoc } from "../../src/types.js";

/**
 * WHAT THIS TEST PROVES — read this first if it is failing.
 *
 * `runScreen` is one loop. Agent mode does not fork it: it suspends the same loop at the points where a
 * critique or a chair verdict is needed, and resumes by RE-EXECUTING it from round 0, serving every
 * generation, measurement and score that already happened out of the run directory. The whole design rests
 * on one claim — that replaying is transparent, so the stopping rule cannot tell how a critique arrived.
 *
 * So: drive the SAME scripted answers through both. Through `runScreen` directly, in one process, as the
 * API-mode client would; and through `stepRun`, writing each answer to the file the work order names, the
 * way a dispatched subagent would. Then compare the two `manifest.json` files.
 *
 * A failure here is not a test to loosen. `committeeRank`, `versions`, `sigma`, `stopReason` or
 * `degradations` differing means the resume layer changed the run's outcome, which is the one thing it is
 * forbidden to do — and it means every agent-mode run's stop reason is unexplained.
 *
 * `hallucinationRate` is compared like everything else, and it is the field this test was worth writing for.
 * The first version of this test failed on it: 1 through the API, 0.333… replayed. `finish` archived only
 * the critiques `validateEvidence` had already stripped, and a round replayed from that archive found
 * nothing left to drop and recorded 0 — so the manifest's one measure of whether the critics invent evidence
 * fell by roughly the fraction of rounds that were replayed, and by nothing else. `critiques-raw/` fixed it
 * (see `ScoredInput.rawCritiques`). Nothing about that failure was visible in any other field, which is why
 * the committee's scripted answers carry a phantom issue: with `issues: []` everywhere the rates are 0 on
 * both sides and this field compares equal while proving nothing.
 */

const FIX = new URL("../fixtures/design/", import.meta.url).pathname;
const DATE = "2026-09-20";

const page = (btn: number) =>
  `<!doctype html><html><body style="margin:0;background:#0B0B0F">
   <button id="b1" style="width:${btn}px;height:${btn}px;background:#FF7A1A;color:#0B0B0F">Go</button>
   </body></html>`;
const shot = (btn: number) => ({ html: page(btn), png: Buffer.from("p") });

// A button under 44px fails the tap-target measurement, so rounds 0 and 1 cannot pass the gate however the
// critics score them; the 48px one clears it, so the run stops on "pass" after exactly three rounds. Three
// is the minimum that makes the test interesting: by the last round, two earlier rounds have been replayed.
//
// The three pages are deliberately all DIFFERENT. `resumingMeasure` is keyed by the content of the stored
// `screen.html`, so two rounds rendering byte-identical HTML would share one stored doc and the agent run
// would honestly measure fewer times than the API run — an asymmetry in the counts below that says nothing
// about replay. 30 and 32 are both under the threshold and are not the same page.
const SCRIPT = [shot(30), shot(32), shot(48)];
const SCORES = [70, 74, 88];

const setup = (mode: "api" | "agent"): string => {
  const d = mkdtempSync(join(tmpdir(), `dl-eq-${mode}-`));
  cpSync(FIX, d, { recursive: true, filter: (src) => !src.includes(".design-loop") });
  const f = join(d, "config.json");
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), criticMode: mode }));
  return d;
};

/**
 * One real browser measurement per distinct page, shared by both runs.
 *
 * Not a fake: the deterministic critique, the gate and every score are computed from a genuine `MeasuredDoc`.
 * Memoising it removes the browser as a variable — two independent Chromium renders of the same HTML are
 * near-identical but not guaranteed byte-identical, and a font-metric wobble would show up here as a
 * manifest difference that has nothing to do with replay. The resume layer is still fully exercised: it
 * wraps whatever `measure` it is handed, and a replayed round never calls this at all — it reads the
 * `digest.json` the earlier process wrote, so a doc that fails to survive its JSON round trip still fails
 * this test.
 */
const docs = new Map<string, Promise<MeasuredDoc>>();
const measureOnce = (html: string): Promise<MeasuredDoc> => {
  let doc = docs.get(html);
  if (!doc) docs.set(html, (doc = measure(html)));
  return doc;
};

/**
 * The scripted committee, indexed per critic by how many times that critic has been asked — never by call
 * order, which differs between a live committee running four critics concurrently and a replay reading four
 * files. Both runs are driven by this one function, so the only difference between them is how the answer
 * travels: a resolved promise in one, a JSON file on disk in the other.
 *
 * Typography cites one issue whose selector is not in the document. It is dropped by `validateEvidence`
 * before anything is scored, so it moves no composite and no gate — its only effect is on
 * `hallucinationRate`, which is a field in `manifest.json` and therefore part of what this test compares.
 * Without it every rate would be 0 in both runs and the comparison of that field would prove nothing.
 */
const PHANTOM: Issue = {
  id: "t-phantom",
  severity: "minor",
  evidence: { selector: "#no-such-element", observed: "invented" },
  claim: "a selector that was never in the document",
  fix: "nothing to fix: this element does not exist",
  effort: "low",
};

const answerFor = (critic: CriticName, round: number): Critique => ({
  critic,
  score: SCORES[Math.min(round, SCORES.length - 1)]!,
  issues: critic === "typography" ? [PHANTOM] : [],
  resolved: { claimed: [], verified: [] },
});

// The chair names no change ids, so `chair()`'s ranking and cap have nothing to truncate and its prompt is
// carried through verbatim. What is under test here is that the prompt reaches the next Stitch edit
// identically, not the ranking, which is pure and has its own tests.
const CHAIR = { prompt: "make the button bigger", changeIds: [] as string[] };

/** What a run actually spent, as opposed to what its manifest says it spent. */
interface Cost {
  runDir: string;
  /** Calls that reached the scripted generator — a replayed round must not be one of them. */
  generations: number;
  /** Calls that reached the browser — likewise. */
  measurements: number;
}

/** The API-mode run: one process, four critics and a chair answering in memory. */
async function apiRun(dir: string): Promise<Cost> {
  const counts: Partial<Record<CriticName, number>> = {};
  const llm: LlmClient = {
    critique: async (critic: CriticName, _input: CriticInput) =>
      answerFor(critic, (counts[critic] = (counts[critic] ?? -1) + 1)),
    takeUsage: () => ({ inputTokens: 1000, outputTokens: 100, cachedTokens: 0 }),
  };
  const chairClient: ChairClient = {
    synthesise: async () => ({ prompt: CHAIR.prompt, changes: [] }),
    takeUsage: () => ({ inputTokens: 500, outputTokens: 50, cachedTokens: 0 }),
  };
  const gen = new FakeGenerator([...SCRIPT]);
  let measurements = 0;
  const out = await runScreen({
    designDir: dir, screen: "home", date: DATE,
    generator: gen, llm, chairClient,
    measure: (html) => { measurements++; return measureOnce(html); },
  });
  return { runDir: out.runDir, generations: gen.prompts.length, measurements };
}

/**
 * The agent-mode run: `stepRun` until it stops asking for anything, with this loop standing in for the
 * dispatcher. Each iteration answers exactly the units the work order names and nothing else, which is the
 * contract a real subagent is held to.
 *
 * A fresh `FakeGenerator` per step is the point, not an economy: a resumed run is a NEW PROCESS, and a new
 * process has no memory of which script entry the last one reached. If the resume layer stopped serving a
 * round from disk, this generator would hand out the script from the top and the divergence would be loud.
 *
 * Once an answer has been consumed and archived, its inbox file is overwritten with a DIFFERENT, still-valid
 * answer. Both agent clients promise the archived copy wins over `inbox/`, precisely so a file edited after
 * the fact cannot rewrite a score or an edit prompt that is already settled. Left unpoisoned the two sources
 * hold the same bytes and that promise is untested; poisoned, a replay that reads the inbox scores a 1 where
 * it scored a 70, or asks Stitch for something nobody decided, and this test says so.
 */
const POISON_CRITIQUE = (critic: CriticName): Critique => ({
  critic,
  score: 1,
  issues: [],
  resolved: { claimed: [], verified: [] },
});
const POISON_CHAIR = { prompt: "POISON: the inbox was read instead of the archive", changeIds: [] as string[] };

async function agentRun(dir: string): Promise<Cost> {
  const agentsDir = join(dir, ".claude", "agents");
  // `stepRun` refuses to write a work order against agent definitions that do not match the current
  // rubrics byte for byte, so the definitions have to be generated before the first step, not faked.
  await syncAgents({ outDir: agentsDir });

  const rounds: Partial<Record<CriticName, number>> = {};
  let runDir: string | undefined;
  // Totals across every step, which is what makes "replaying is free" checkable rather than asserted. The
  // manifest cannot show this: its `stitchGenerations` counts rounds, and a round that was regenerated on
  // every step still counts once. Only the caller can see how often the script and the browser were used.
  let generations = 0;
  let measurements = 0;

  // Answers written last step (about to be consumed by this one) and answers written before that (already
  // consumed and archived, so safe to poison). Poisoning a file the run has not read yet would only test
  // that the inbox is read at all, which is the opposite of the point.
  let justWritten: (() => void)[] = [];
  let settled: (() => void)[] = [];

  // A bound, not a schedule: three rounds need seven steps, and a resume layer that stopped making
  // progress would otherwise spin here instead of failing.
  for (let guard = 0; guard < 25; guard++) {
    for (const poison of settled) poison();
    settled = justWritten;
    justWritten = [];

    const gen = new FakeGenerator([...SCRIPT]);
    const out = await stepRun({
      designDir: dir, screen: "home", date: DATE, runDir,
      generator: gen, agentsDir,
      measure: (html) => { measurements++; return measureOnce(html); },
    });
    generations += gen.prompts.length;
    runDir = out.runDir;
    if (out.done) return { runDir: out.runDir, generations, measurements };

    const order = JSON.parse(readFileSync(out.workOrder, "utf8")) as {
      units: { critic: string; output: string }[];
    };
    for (const unit of order.units) {
      const file = join(out.runDir, unit.output);
      mkdirSync(join(file, ".."), { recursive: true });
      if (unit.critic === "chair") {
        writeFileSync(file, JSON.stringify(CHAIR));
        justWritten.push(() => writeFileSync(file, JSON.stringify(POISON_CHAIR)));
      } else {
        const critic = unit.critic as CriticName;
        writeFileSync(file, JSON.stringify(answerFor(critic, (rounds[critic] = (rounds[critic] ?? -1) + 1))));
        justWritten.push(() => writeFileSync(file, JSON.stringify(POISON_CRITIQUE(critic))));
      }
    }
  }
  throw new Error("the agent-mode run never finished: stepRun kept asking for work");
}

describe("replay equivalence", () => {
  it("an agent-mode run driven by dl step matches an api-mode run exactly, apart from spend", async () => {
    const apiCost = await apiRun(setup("api"));
    const agentCost = await agentRun(setup("agent"));

    expect(existsSync(join(agentCost.runDir, "manifest.json"))).toBe(true);
    const api = JSON.parse(readFileSync(join(apiCost.runDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    const agent = JSON.parse(readFileSync(join(agentCost.runDir, "manifest.json"), "utf8")) as Record<string, unknown>;

    // Checked BEFORE the manifests, because it is the assertion the manifests cannot make. The scripted
    // generator is deterministic, so a resume layer that regenerated every round from the top of the script
    // on every step would still produce identical screens and an identical manifest — the comparison below
    // would stay green over a resume layer that does nothing at all. These two numbers are what rule that
    // out: seven steps, three rounds, and the script and the browser used three times each.
    expect(agentCost.generations).toBe(apiCost.generations);
    expect(agentCost.measurements).toBe(apiCost.measurements);

    // Checked on its own line, before the whole-manifest compare, so a regression here names the field
    // instead of burying it in an object diff. This is the assertion that caught the `critiques-raw/`
    // defect; if it fails again, suspect what the archive keeps before suspecting the loop's arithmetic.
    expect(agent.hallucinationRate).toEqual(api.hallucinationRate);
    // And it must not be vacuous: a phantom issue was cited every round, so the rate is not zero.
    expect((api.hallucinationRate as Record<string, number>).typography).toBe(1);

    // `spend` is the ONLY field excluded, and it is excluded because the two runs differ in it by design:
    // `criticMode` records which mode produced the run, and `usd` is null in agent mode because a
    // subagent's tokens never reach this process, so there is no number to report. Nothing else is
    // excluded — a difference anywhere else is the resume layer changing the run.
    const { spend: _apiSpend, ...apiRest } = api;
    const { spend: _agentSpend, ...agentRest } = agent;
    expect(agentRest).toEqual(apiRest);

    // The excluded field, checked rather than ignored: the parts of `spend` that are not about billing must
    // still agree, and the parts that differ must differ in exactly the documented way.
    const apiSpend = api.spend as Record<string, unknown>;
    const agentSpend = agent.spend as Record<string, unknown>;
    expect(agentSpend.stitchGenerations).toBe(apiSpend.stitchGenerations);
    expect(apiSpend.criticMode).toBe("api");
    expect(agentSpend.criticMode).toBe("agent");
    expect(apiSpend.usd).not.toBeNull();
    expect(agentSpend.usd).toBeNull();
  }, 120_000);
});
