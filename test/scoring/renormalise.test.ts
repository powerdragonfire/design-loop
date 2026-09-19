import { describe, it, expect } from "vitest";
import { renormalise } from "../../src/scoring/score.js";

const W = { typography: 0.25, behavioural: 0.2, accessibility: 0.2, tokenConformance: 0.2, feasibility: 0.15 };

describe("renormalise", () => {
  it("is a no-op when every dimension is present", () => {
    expect(renormalise(W, Object.keys(W) as any)).toEqual(W);
  });
  it("redistributes a dropped critic's weight proportionally", () => {
    const out = renormalise(W, ["typography", "behavioural", "accessibility", "tokenConformance"]);
    expect(Object.values(out).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(out.typography / out.behavioural).toBeCloseTo(0.25 / 0.2, 9);
  });
  it("throws when every critic was dropped", () => {
    expect(() => renormalise(W, [])).toThrow(/no critics/);
  });
});
