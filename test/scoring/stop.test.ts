import { describe, it, expect } from "vitest";
import { decide, type RoundRecord } from "../../src/scoring/stop.js";

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
});
