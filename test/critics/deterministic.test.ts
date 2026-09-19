import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { measure } from "../../src/measure/measure.js";
import { deterministicCritique, contrastRatio } from "../../src/critics/deterministic.js";
import type { MeasuredDoc, MeasuredNode } from "../../src/types.js";

const html = readFileSync(new URL("../fixtures/html/simple.html", import.meta.url), "utf8");
const tokens = { color: { accent: "#FF7A1A", bg: "#0B0B0F", border: "#2A2A33" } };

describe("contrastRatio", () => {
  it("is 21 for black on white", () => {
    expect(contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)")).toBeCloseTo(21, 1);
  });
  it("is 1 for identical colours", () => {
    expect(contrastRatio("rgb(11, 11, 15)", "rgb(11, 11, 15)")).toBeCloseTo(1, 2);
  });
});

describe("deterministicCritique", () => {
  it("flags a 30x30 tap target as a blocker", async () => {
    const { critique } = deterministicCritique(await measure(html), tokens);
    const i = critique.issues.find(i => i.evidence.selector === "#b1")!;
    expect(i.severity).toBe("blocker");
    expect(i.claim).toMatch(/44/);
  });

  it("flags #2A2A33 on #0B0B0F as failing contrast", async () => {
    const { critique } = deterministicCritique(await measure(html), tokens);
    expect(critique.issues.some(i =>
      i.evidence.selector === "#p1" && /contrast/i.test(i.claim))).toBe(true);
  });

  it("flags a CTA inside the home-indicator inset", async () => {
    const { critique } = deterministicCritique(await measure(html), tokens);
    expect(critique.issues.some(i =>
      i.evidence.selector === "#c1" && /home indicator/i.test(i.claim))).toBe(true);
  });

  it("sets measurementsPass false when any measurement fails", async () => {
    const { measurementsPass } = deterministicCritique(await measure(html), tokens);
    expect(measurementsPass).toBe(false);
  });

  it("emits every measurement failure as a blocker", async () => {
    const { critique } = deterministicCritique(await measure(html), tokens);
    expect(critique.issues.every(i => i.severity === "blocker")).toBe(true);
  });

  it("does not flag a full-height, non-interactive wrapper as inside the home indicator", async () => {
    const page = `<body style="margin:0"><div id="w" style="height:852px;background:#0B0B0F"></div></body>`;
    const { critique } = deterministicCritique(await measure(page), tokens);
    expect(critique.issues.some(i => i.evidence.selector === "#w")).toBe(false);
  });

  it("does not flag an interactive element that sits below the fold", async () => {
    const page = `<body style="margin:0"><button id="f" style="margin-top:2000px;width:60px;height:60px;color:#0B0B0F;background:#FF7A1A">x</button></body>`;
    const { critique } = deterministicCritique(await measure(page), tokens);
    expect(critique.issues.some(i => i.evidence.selector === "#f")).toBe(false);
  });
}, 30_000);

// Pure unit tests on hand-built docs: token flattening and scoring need no browser.
function node(over: Partial<MeasuredNode> & { style?: Record<string, string> }): MeasuredNode {
  return {
    selector: "#n", tag: "div", role: null, text: "", bbox: { x: 0, y: 0, w: 100, h: 100 },
    ...over,
    style: {
      color: "rgb(255, 122, 26)", backgroundColor: "rgba(0, 0, 0, 0)",
      fontSize: "16px", fontWeight: "400", borderRadius: "0px",
      effectiveBackground: "rgb(11, 11, 15)", ...over.style,
    },
  };
}
const doc = (...nodes: MeasuredNode[]): MeasuredDoc => ({ viewport: { w: 393, h: 852 }, nodes });

describe("deterministicCritique token conformance", () => {
  it("reports the tokenConformance critic with empty resolved", () => {
    const { critique } = deterministicCritique(doc(node({})), tokens);
    expect(critique.critic).toBe("tokenConformance");
    expect(critique.resolved).toEqual({ claimed: [], verified: [] });
  });

  it("accepts DTCG leaves and bare leaves, normalising 3, 6 and 8 digit hex", () => {
    const dtcg = { color: { $type: "color", accent: { $value: "#f71" }, bg: { $value: "#0B0B0FFF" } } };
    const d = doc(node({ text: "x", style: { color: "rgb(255, 119, 17)", backgroundColor: "rgb(11, 11, 15)" } }));
    const { critique } = deterministicCritique(d, dtcg);
    expect(critique.issues).toEqual([]);
    expect(critique.score).toBe(100);
  });

  it("flags an off-token colour with a det-token id and scores conforming/total", () => {
    // color conforms (accent); backgroundColor is off-token -> 1 of 2 literals conforming
    const d = doc(node({ text: "hi", style: { backgroundColor: "rgb(1, 2, 3)" } }));
    const { critique } = deterministicCritique(d, tokens);
    expect(critique.issues.map(i => i.id)).toEqual(["det-token-backgroundColor-#n"]);
    expect(critique.issues[0]!.evidence.selector).toBe("#n");
    expect(critique.score).toBe(50);
  });

  it("does not let contrast, tap or inset failures lower the score", () => {
    const d = doc(node({
      tag: "button", text: "x", bbox: { x: 0, y: 800, w: 20, h: 20 },
      style: { color: "rgb(11, 11, 15)" },
    }));
    const { critique } = deterministicCritique(d, tokens);
    expect(critique.issues.map(i => i.id)).toEqual(
      expect.arrayContaining(["det-contrast-#n", "det-tap-#n", "det-inset-#n"]));
    expect(critique.score).toBe(100);
  });

  it("skips fontSize and borderRadius when tokens define neither", () => {
    const d = doc(node({ style: { fontSize: "13.3px", borderRadius: "7px" } }));
    expect(deterministicCritique(d, tokens).critique.issues).toEqual([]);
  });

  it("checks fontSize and borderRadius when tokens define them, ignoring 0px radii", () => {
    const full = { ...tokens, fontSize: { body: "16px", title: "1.5rem" }, radius: { md: "8px" } };
    const ok = doc(node({ text: "x", style: { fontSize: "24px", borderRadius: "8px" } }));
    expect(deterministicCritique(ok, full).critique.issues).toEqual([]);
    const bad = doc(node({ text: "x", style: { fontSize: "13px", borderRadius: "7px" } }));
    expect(deterministicCritique(bad, full).critique.issues).toHaveLength(2);
    const square = doc(node({ style: { borderRadius: "0px" } }));
    expect(deterministicCritique(square, full).critique.score).toBe(100);
  });

  it("scores 100 when the tokens define no checkable category", () => {
    const { critique } = deterministicCritique(doc(node({ style: { color: "rgb(1, 2, 3)" } })), { spacing: { s: "4px" } });
    expect(critique.score).toBe(100);
    expect(critique.issues).toEqual([]);
  });

  it("applies a 3:1 threshold to large text", () => {
    // ~3.5:1: fails at 14px body, passes as 24px large text
    const style = { color: "rgb(117, 117, 130)", effectiveBackground: "rgb(11, 11, 15)" };
    const small = deterministicCritique(doc(node({ text: "a", style: { ...style, fontSize: "14px" } })), { spacing: {} });
    const large = deterministicCritique(doc(node({ text: "a", style: { ...style, fontSize: "24px" } })), { spacing: {} });
    expect(contrastRatio(style.color, style.effectiveBackground)).toBeGreaterThan(3);
    expect(contrastRatio(style.color, style.effectiveBackground)).toBeLessThan(4.5);
    expect(small.critique.issues.map(i => i.id)).toEqual(["det-contrast-#n"]);
    expect(large.critique.issues).toEqual([]);
  });
});

describe("deterministicCritique token scoping", () => {
  it("does not examine the inherited text colour of nodes with no own text", () => {
    const d = doc(node({ text: "", style: { color: "rgb(0, 0, 0)" } }));
    const { critique } = deterministicCritique(d, tokens);
    expect(critique.issues).toEqual([]);
    expect(critique.score).toBe(100);
  });
});

describe("deterministicCritique fontSize scoping", () => {
  it("does not examine or count the inherited font size of text-less wrappers", () => {
    const scale = { ...tokens, fontSize: { sm: "12px", md: "14px", lg: "18px" } };
    const text = node({ selector: "#t", text: "hi", style: { fontSize: "14px" } });
    const wrapper = node({ selector: "#w", text: "", style: { fontSize: "16px" } }); // ambient 16px, not on the scale
    const { critique } = deterministicCritique(doc(wrapper, text), scale);
    expect(critique.issues).toEqual([]);
    expect(critique.score).toBe(100);
  });

  it("still flags an off-scale font size on a node with own text", () => {
    const scale = { ...tokens, fontSize: { sm: "12px", md: "14px", lg: "18px" } };
    const { critique } = deterministicCritique(doc(node({ text: "hi", style: { fontSize: "16px" } })), scale);
    expect(critique.issues.map(i => i.id)).toEqual(["det-token-fontSize-#n"]);
    expect(critique.score).toBe(50); // color conforms, backgroundColor is transparent (skipped), fontSize off
  });
});

describe("deterministicCritique issue ids", () => {
  const btn = (id: string, size: number) =>
    `<button id="${id}" style="display:block;width:${size}px;height:${size}px;color:#0B0B0F;background:#FF7A1A">x</button>`;
  const ids = async (page: string) =>
    deterministicCritique(await measure(`<body style="margin:0;background:#0B0B0F">${page}</body>`), tokens)
      .critique.issues.map(i => i.id);

  it("derives ids from the check and selector", async () => {
    expect(await ids(btn("a", 30))).toEqual(["det-tap-#a"]);
  });

  it("keeps a defect's id when an unrelated element is fixed", async () => {
    const before = await ids(btn("a", 30) + btn("b", 30));
    const after = await ids(btn("a", 44) + btn("b", 30));
    expect(before).toEqual(["det-tap-#a", "det-tap-#b"]);
    expect(after).toEqual(["det-tap-#b"]);
  });
});
