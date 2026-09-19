import { describe, it, expect } from "vitest";
import { validateEvidence, promoteResolutions } from "../../src/evidence/validate.js";
import type { Critique, MeasuredDoc } from "../../src/types.js";

const node = (selector: string, color: string) => ({
  selector, tag: "p", role: null, text: "x",
  bbox: { x: 0, y: 0, w: 10, h: 10 }, style: { color },
});
const doc = (color = "rgb(1, 1, 1)"): MeasuredDoc =>
  ({ viewport: { w: 393, h: 852 }, nodes: [node("#real", color)] });

const critique = (over: Partial<Critique> = {}): Critique => ({
  critic: "typography", score: 80, issues: [],
  resolved: { claimed: [], verified: [] }, ...over,
});
const issue = (id: string, selector: string) => ({
  id, severity: "major" as const, evidence: { selector, observed: "o" },
  claim: "c", fix: "f", effort: "low" as const,
});

describe("validateEvidence", () => {
  it("keeps an issue whose selector resolves", () => {
    const { critiques } = validateEvidence([critique({ issues: [issue("a", "#real")] })], doc());
    expect(critiques[0].issues).toHaveLength(1);
  });

  it("drops an issue whose selector does not resolve", () => {
    const { critiques } = validateEvidence([critique({ issues: [issue("a", "#fake")] })], doc());
    expect(critiques[0].issues).toHaveLength(0);
  });

  it("records the per-critic hallucination rate", () => {
    const c = critique({ issues: [issue("a", "#real"), issue("b", "#fake")] });
    const { hallucinationRate } = validateEvidence([c], doc());
    expect(hallucinationRate.typography).toBe(0.5);
  });

  it("reports a zero rate for a critic that raised no issues", () => {
    const { hallucinationRate } = validateEvidence([critique()], doc());
    expect(hallucinationRate.typography).toBe(0);
  });

  it("has no rate entry for a critic that is absent from the input", () => {
    const { hallucinationRate } = validateEvidence([critique()], doc());
    expect(hallucinationRate).not.toHaveProperty("accessibility");
  });

  it("does not mutate its input", () => {
    const c = critique({ issues: [issue("a", "#real"), issue("b", "#fake")] });
    const snapshot = structuredClone(c);
    validateEvidence([c], doc());
    expect(c).toEqual(snapshot);
  });
});

describe("promoteResolutions", () => {
  const prevIssues = [issue("old-1", "#real")];

  it("rejects a claim when the cited element is unchanged", () => {
    const c = critique({ resolved: { claimed: ["old-1"], verified: [] } });
    const out = promoteResolutions([c], doc(), doc(), prevIssues);
    expect(out[0].resolved.verified).toEqual([]);
  });

  it("verifies a claim when the cited element changed", () => {
    const c = critique({ resolved: { claimed: ["old-1"], verified: [] } });
    const out = promoteResolutions([c], doc("rgb(1, 1, 1)"), doc("rgb(9, 9, 9)"), prevIssues);
    expect(out[0].resolved.verified).toEqual(["old-1"]);
  });

  it("verifies nothing on round 0, where there is no previous doc", () => {
    const c = critique({ resolved: { claimed: ["old-1"], verified: [] } });
    const out = promoteResolutions([c], null, doc(), prevIssues);
    expect(out[0].resolved.verified).toEqual([]);
  });

  it("rejects a claim for an id that was never raised", () => {
    const c = critique({ resolved: { claimed: ["ghost"], verified: [] } });
    const out = promoteResolutions([c], doc("rgb(1, 1, 1)"), doc("rgb(9, 9, 9)"), prevIssues);
    expect(out[0].resolved.verified).toEqual([]);
  });

  it("treats geometry changes as changes", () => {
    const moved = doc();
    moved.nodes[0].bbox = { x: 0, y: 0, w: 44, h: 44 };
    const c = critique({ resolved: { claimed: ["old-1"], verified: [] } });
    const out = promoteResolutions([c], doc(), moved, prevIssues);
    expect(out[0].resolved.verified).toEqual(["old-1"]);
  });

  it("verifies a claim when the cited element was removed", () => {
    const gone: MeasuredDoc = { viewport: { w: 393, h: 852 }, nodes: [] };
    const c = critique({ resolved: { claimed: ["old-1"], verified: [] } });
    const out = promoteResolutions([c], doc(), gone, prevIssues);
    expect(out[0].resolved.verified).toEqual(["old-1"]);
  });

  it("does not verify when the cited element is absent from both docs", () => {
    const empty: MeasuredDoc = { viewport: { w: 393, h: 852 }, nodes: [] };
    const c = critique({ resolved: { claimed: ["old-1"], verified: [] } });
    const out = promoteResolutions([c], empty, empty, prevIssues);
    expect(out[0].resolved.verified).toEqual([]);
  });

  it("discards a verified list the critic supplied itself", () => {
    const c = critique({ resolved: { claimed: ["old-1"], verified: ["old-1", "ghost"] } });
    const out = promoteResolutions([c], doc(), doc(), prevIssues);
    expect(out[0].resolved.verified).toEqual([]);
  });

  it("keeps claimed as-is, and does not mutate its input", () => {
    const c = critique({ resolved: { claimed: ["old-1", "ghost"], verified: [] } });
    const snapshot = structuredClone(c);
    const out = promoteResolutions([c], doc("rgb(1, 1, 1)"), doc("rgb(9, 9, 9)"), prevIssues);
    expect(out[0].resolved.claimed).toEqual(["old-1", "ghost"]);
    expect(c).toEqual(snapshot);
  });
});
