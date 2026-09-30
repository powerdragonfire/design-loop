import { describe, it, expect } from "vitest";
import { compareRounds, decide, regressed, type RoundRecord } from "../../src/scoring/stop.js";

const CFG = { sigma: 3, maxRounds: 5, convergenceSigmas: 1.0, convergenceRounds: 2 };
const r = (i: number, composite: number, gatePass = false): RoundRecord =>
  ({ version: `v0${i}`, composite, gatePass });
const seq = (scores: number[], passAt = -1) =>
  scores.map((s, i) => r(i, s, i === passAt));

describe("decide", () => {
  it("stops immediately when round 0 passes the gate", () => {
    expect(decide(seq([40], 0), CFG)).toEqual({ stop: "pass", best: "v00" });
  });

  it("does not stop at a single dip: 70 -> 75 -> 74 must continue", () => {
    expect(decide(seq([70, 75, 74]), CFG).stop).toBeNull();
  });

  it("reaches 88 through the dip: 70 -> 75 -> 74 -> 88 picks v03", () => {
    const d = decide(seq([70, 75, 74, 88]), CFG);
    expect(d.stop).toBeNull();
    expect(d.best).toBe("v03");
  });

  it("does not stop on an 82 -> 81 noise step", () => {
    expect(decide(seq([82, 81]), CFG).stop).toBeNull();
  });

  it("converges after two consecutive non-improvements", () => {
    // 81 and 83 are both within one sigma of 82, so neither counts as
    // progress — but `best` is still the highest composite seen.
    const d = decide(seq([82, 81, 83]), CFG);
    expect(d.stop).toBe("converged");
    expect(d.best).toBe("v02");
  });

  it("treats a gain smaller than one sigma as a non-improvement", () => {
    expect(decide(seq([80, 82, 82.5]), CFG).stop).toBe("converged");
  });

  it("treats a gain larger than one sigma as progress", () => {
    expect(decide(seq([80, 84, 88]), CFG).stop).toBeNull();
  });

  it("stops on budget at maxRounds", () => {
    const d = decide(seq([10, 20, 30, 40, 50, 60]), CFG);
    expect(d.stop).toBe("budget");
    expect(d.best).toBe("v05");
  });

  it("prefers the gate over convergence when both hold", () => {
    expect(decide(seq([82, 81, 83], 2), CFG).stop).toBe("pass");
  });

  it("keeps the earliest version on a tie", () => {
    expect(decide(seq([80, 80, 80]), CFG).best).toBe("v00");
  });

  it("throws when sigma is null", () => {
    expect(() => decide(seq([80]), { ...CFG, sigma: null as unknown as number }))
      .toThrow(/sigma/);
  });

  it("compares against best-so-far, not the previous round: 70,80,75,79 converges", () => {
    // 79 does not beat best (80) by > 3, but DOES beat the previous round (75)
    // by > 3. Comparing to the previous round would wrongly call it progress.
    expect(decide(seq([70, 80, 75, 79]), CFG)).toEqual({ stop: "converged", best: "v01" });
  });

  // decide() is the last line before an irreversible stop, so it defends its own
  // inputs: an invalid config must throw, never silently converge or never stop.
  it.each([
    ["sigma NaN", { sigma: NaN }],
    ["sigma negative", { sigma: -1 }],
    ["convergenceSigmas NaN", { convergenceSigmas: NaN }],
    ["convergenceRounds 0", { convergenceRounds: 0 }],
    ["maxRounds 0", { maxRounds: 0 }],
  ])("rejects an invalid config: %s", (_name, bad) => {
    expect(() => decide(seq([70, 90, 95]), { ...CFG, ...bad })).toThrow(/invalid stop config/);
  });

  // Issue counts: a closed blocker is a fact, a 0.3 composite gain is noise.
  const ri = (i: number, composite: number, blockers: number, majors = 0, gatePass = false): RoundRecord =>
    ({ version: `v0${i}`, composite, gatePass, blockers, majors });

  it("picks the version with fewer open blockers over a higher composite", () => {
    // The group-ideas run: v00 84.0 with 6 blockers, v02 83.7 with none.
    const d = decide([ri(0, 84, 6, 4), ri(1, 80, 2, 3), ri(2, 83.7, 0, 1)], CFG);
    expect(d.best).toBe("v02");
  });

  it("breaks a blocker tie on majors, then on composite", () => {
    expect(decide([ri(0, 90, 1, 3), ri(1, 70, 1, 1)], CFG).best).toBe("v01");
    expect(decide([ri(0, 70, 1, 1), ri(1, 90, 1, 1)], CFG).best).toBe("v01");
  });

  it("does not converge while each round closes a blocker or major", () => {
    // Composite flat within one sigma, but the open issues fall every round.
    expect(decide([ri(0, 80, 3, 2), ri(1, 80.5, 2, 2), ri(2, 81, 1, 2), ri(3, 80, 0, 2)], CFG).stop).toBeNull();
  });

  it("converges once issues and composite both stall", () => {
    const d = decide([ri(0, 80, 3), ri(1, 81, 1), ri(2, 81.5, 1), ri(3, 80.5, 2)], CFG);
    expect(d).toEqual({ stop: "converged", best: "v02" });
  });

  it("ranks gate pass, then blockers, majors, composite", () => {
    const order = [ri(0, 95, 2), ri(1, 60, 0, 3), ri(2, 70, 0, 1), ri(3, 50, 0, 0, true)]
      .sort(compareRounds).map(r => r.version);
    expect(order).toEqual(["v03", "v02", "v01", "v00"]);
  });

  it("calls a round a regression when it opens more blockers, whatever its composite", () => {
    expect(regressed(ri(1, 90, 2), ri(0, 80, 1), 3)).toBe(true);
    expect(regressed(ri(1, 78, 1), ri(0, 80, 1), 3)).toBe(false);
    expect(regressed(ri(1, 76, 1), ri(0, 80, 1), 3)).toBe(true);
    expect(regressed(ri(0, 80, 1), ri(0, 80, 1), 3)).toBe(false);
  });
});
