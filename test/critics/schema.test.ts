import { describe, it, expect } from "vitest";
import { parseCritique, nextIssueId } from "../../src/critics/schema.js";
import type { Issue } from "../../src/types.js";

const ok = {
  critic: "typography",
  score: 71,
  issues: [
    { id: "001", severity: "major", evidence: { selector: "#b1", observed: "14px" },
      claim: "too small", fix: "use 16px", effort: "low" },
  ],
  resolved: { claimed: ["typography-000"], verified: [] },
};

describe("parseCritique", () => {
  it("prefixes bare issue ids with the critic name", () => {
    expect(parseCritique("typography", ok).issues[0]!.id).toBe("typography-001");
  });

  it("never trusts a model's own verification", () => {
    expect(parseCritique("typography", ok).resolved).toEqual({ claimed: ["typography-000"], verified: [] });
  });

  it("renumbers a duplicate id instead of dropping it", () => {
    const dup = { ...ok, issues: [ok.issues[0], { ...ok.issues[0], claim: "other" }] };
    const out = parseCritique("typography", dup);
    expect(out.issues.map((i) => i.id)).toEqual(["typography-001", "typography-001-2"]);
  });

  it("rejects a score outside 0..100", () => {
    expect(() => parseCritique("typography", { ...ok, score: 101 }))
      .toThrow(/score is not a number in 0\.\.100/);
  });

  it("rejects an issue with no selector", () => {
    const bad = { ...ok, issues: [{ ...ok.issues[0], evidence: { selector: "", observed: "x" } }] };
    expect(() => parseCritique("typography", bad)).toThrow(/cites no selector/);
  });

  it("rejects a non-object", () => {
    expect(() => parseCritique("typography", "nope")).toThrow(/not an object/);
  });
});

describe("nextIssueId", () => {
  it("is one past the highest numeric suffix already open", () => {
    const open = [{ id: "typography-007" }, { id: "typography-002" }] as Issue[];
    expect(nextIssueId("typography", open)).toBe("typography-008");
  });

  it("starts at 001 when nothing is open", () => {
    expect(nextIssueId("typography", [])).toBe("typography-001");
  });
});
