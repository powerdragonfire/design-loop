import { describe, it, expect } from "vitest";
import { composite, gate, openIssues } from "../../src/scoring/score.js";
import type { Critique, CriticName, Severity } from "../../src/types.js";

const WEIGHTS = {
  typography: 0.25, behavioural: 0.2, accessibility: 0.2,
  tokenConformance: 0.2, feasibility: 0.15,
};
const c = (critic: CriticName, score: number, sev?: Severity, verified: string[] = []): Critique => ({
  critic, score,
  issues: sev ? [{ id: `${critic}-1`, severity: sev, evidence: { selector: "#a", observed: "o" }, claim: "c", fix: "f", effort: "low" }] : [],
  resolved: { claimed: [], verified },
});
const all = (score: number, sev?: Severity) =>
  (Object.keys(WEIGHTS) as CriticName[]).map(n => c(n, score, sev));

describe("composite", () => {
  it("is the weighted mean", () => {
    expect(composite(all(80), WEIGHTS)).toBeCloseTo(80, 6);
  });
  it("weights dimensions unequally", () => {
    const cs = all(0); cs[0] = c("typography", 100);
    expect(composite(cs, WEIGHTS)).toBeCloseTo(25, 6);
  });
  it("works over surviving critics when weights are renormalised to them", () => {
    const survivors = all(80).slice(1);
    const w = { ...WEIGHTS, typography: 0 };
    const total = 1 - 0.25;
    for (const k of Object.keys(w) as CriticName[]) w[k] = k === "typography" ? 0 : WEIGHTS[k] / total;
    expect(composite(survivors, w)).toBeCloseTo(80, 6);
  });
  it("throws when the weights of the present critics do not sum to 1", () => {
    expect(() => composite(all(80).slice(1), WEIGHTS))
      .toThrow(/weights for present critics must sum to 1/);
  });
});

describe("gate", () => {
  it("passes with no open issues and passing measurements", () => {
    expect(gate(all(60), true).pass).toBe(true);
  });
  it("ignores the composite score entirely", () => {
    expect(gate(all(1), true).pass).toBe(true);
  });
  it("fails on an open blocker", () => {
    expect(gate(all(99, "blocker"), true).pass).toBe(false);
  });
  it("fails on an open major", () => {
    expect(gate(all(99, "major"), true).pass).toBe(false);
  });
  it("passes with only minors open", () => {
    expect(gate(all(50, "minor"), true).pass).toBe(true);
  });
  it("fails when a measurement fails, whatever the issues say", () => {
    expect(gate(all(99), false).pass).toBe(false);
  });
  it("names every reason it failed", () => {
    const r = gate(all(99, "blocker"), false).reasons;
    expect(r.some(x => /blocker/.test(x))).toBe(true);
    expect(r.some(x => /measurement/.test(x))).toBe(true);
  });
});

describe("openIssues", () => {
  it("excludes verified resolutions", () => {
    const cs = all(80, "major");
    cs[0] = c("typography", 80, "major", ["typography-1"]);
    expect(openIssues(cs).find(i => i.id === "typography-1")).toBeUndefined();
  });
  it("does NOT exclude merely claimed resolutions", () => {
    const cs = all(80, "major");
    cs[0].resolved = { claimed: ["typography-1"], verified: [] };
    expect(openIssues(cs).find(i => i.id === "typography-1")).toBeDefined();
  });

  const stale = { id: "old-1", severity: "major" as const,
    evidence: { selector: "#z", observed: "o" }, claim: "c", fix: "f", effort: "low" as const };

  it("carries forward a prior open issue the committee no longer mentions", () => {
    expect(openIssues(all(80), [stale]).map(i => i.id)).toContain("old-1");
  });
  it("closes a carried issue only when it is verified", () => {
    const cs = all(80); cs[0] = c("typography", 80, undefined, ["old-1"]);
    expect(openIssues(cs, [stale]).map(i => i.id)).not.toContain("old-1");
  });
  it("lets this round's version of a carried id win, without duplicating it", () => {
    const now = all(80); now[0].issues = [{ ...stale, claim: "updated" }];
    const out = openIssues(now, [stale]).filter(i => i.id === "old-1");
    expect(out).toHaveLength(1);
    expect(out[0].claim).toBe("updated");
  });
  it("gate fails on a carried major the committee stopped mentioning", () => {
    expect(gate(all(99), true, [stale]).pass).toBe(false);
  });
});
