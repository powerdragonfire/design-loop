import { describe, it, expect } from "vitest";
import { groupTokenIssues } from "../../src/cli/group.js";
import type { Issue } from "../../src/types.js";

const token = (prop: string, selector: string, value: string): Issue => ({
  id: `det-token-${prop}-${selector}`,
  severity: "blocker",
  evidence: { selector, observed: `${prop}: ${value}` },
  claim: `${prop} ${value} is not a design token`,
  fix: "Use a colour from the tokens file",
  effort: "low",
});
const other = (id: string): Issue => ({
  id, severity: "major", evidence: { selector: "#x", observed: "o" }, claim: "c", fix: "f", effort: "low",
});

describe("groupTokenIssues", () => {
  it("collapses one off-token value on many elements into a single issue the chair can fix in one edit", () => {
    const issues = ["#a", "#b"].map((s) => token("color", s, "rgb(1, 2, 3)"));
    const out = groupTokenIssues(issues);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "det-token-group-color-1",
      severity: "blocker",
      effort: "low",
      evidence: { selector: "#a", observed: "color: rgb(1, 2, 3)" },
      claim: "color rgb(1, 2, 3) is not a design token; used on 2 elements: #a, #b",
      fix: "Replace rgb(1, 2, 3) with the nearest design token for color on those elements",
    });
  });

  it("keeps different observed values apart, and numbers each prop's groups in order of first appearance", () => {
    const out = groupTokenIssues([
      token("color", "#a", "rgb(1, 2, 3)"),
      token("color", "#b", "rgb(9, 9, 9)"),
      token("color", "#c", "rgb(1, 2, 3)"),
    ]);
    expect(out.map((i) => i.id)).toEqual(["det-token-group-color-1", "det-token-group-color-2"]);
    expect(out[0]!.claim).toContain("used on 2 elements: #a, #c");
    expect(out[1]!.claim).toContain("used on 1 element: #b");
  });

  it("numbers each property's groups separately, so the id says which property it is about", () => {
    const out = groupTokenIssues([
      token("color", "#a", "rgb(1, 2, 3)"),
      token("backgroundColor", "#a", "rgb(4, 5, 6)"),
      token("fontSize", "#a", "13px"),
    ]);
    expect(out.map((i) => i.id)).toEqual([
      "det-token-group-color-1", "det-token-group-backgroundColor-1", "det-token-group-fontSize-1",
    ]);
  });

  it("rewrites a single-member group too, so the chair never sees the two forms mixed", () => {
    const out = groupTokenIssues([token("fontSize", "#a", "13px")]);
    expect(out[0]!.id).toBe("det-token-group-fontSize-1");
    expect(out[0]!.claim).toBe("fontSize 13px is not a design token; used on 1 element: #a");
    expect(out[0]!.fix).toBe("Replace 13px with the nearest design token for fontSize on those elements");
  });

  it("names at most three selectors, then how many more", () => {
    const out = groupTokenIssues(["#a", "#b", "#c", "#d", "#e"].map((s) => token("color", s, "rgb(1, 2, 3)")));
    expect(out[0]!.claim).toBe(
      "color rgb(1, 2, 3) is not a design token; used on 5 elements: #a, #b, #c +2 more",
    );
  });

  it("passes non-token issues through untouched, keeping the order of what it was given", () => {
    const a = other("typography-001");
    const b = other("det-tap-#b1");
    const out = groupTokenIssues([a, token("color", "#a", "rgb(1, 2, 3)"), b, token("color", "#b", "rgb(1, 2, 3)")]);
    expect(out.map((i) => i.id)).toEqual(["typography-001", "det-token-group-color-1", "det-tap-#b1"]);
    expect(out[0]).toBe(a);
    expect(out[2]).toBe(b);
  });

  it("does not mutate its input", () => {
    const issues = [token("color", "#a", "rgb(1, 2, 3)"), other("typography-001")];
    const snapshot = structuredClone(issues);
    groupTokenIssues(issues);
    expect(issues).toEqual(snapshot);
  });
});
