import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { MeasuredDoc } from "../../src/types.js";
import { measure } from "../../src/measure/measure.js";
import { distill, estimateTokens } from "../../src/distill/distill.js";

const html = readFileSync(new URL("../fixtures/html/simple.html", import.meta.url), "utf8");

describe("distill", () => {
  it("emits one line per node, selector first", async () => {
    const out = distill(await measure(html));
    expect(out.split("\n").some(l => l.startsWith("#b1"))).toBe(true);
  });

  it("keeps every selector the evidence validator will resolve", async () => {
    const doc = await measure(html);
    const out = distill(doc);
    for (const n of doc.nodes) expect(out).toContain(n.selector);
  });

  it("keeps geometry and the style props critics reason about", async () => {
    const out = distill(await measure(html));
    const line = out.split("\n").find(l => l.startsWith("#p1"))!;
    expect(line).toMatch(/14px/);
    expect(line).toMatch(/rgb\(42, 42, 51\)/);
  });

  it("is smaller than realistic source HTML, because it drops everything outside <body>", async () => {
    // simple.html is ~130 tokens, smaller than any per-node style digest, so it
    // cannot show compression. Real Stitch pages carry a large <head> (Tailwind
    // config, style blocks, fonts) that a critic never needs; that is where the
    // saving comes from. Pad the head programmatically so the test is honest.
    const cfg = JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, `value-${i}`])));
    const padded = html.replace("<head>", `<head><script>window.__cfg=${cfg}</script>`);
    expect(estimateTokens(padded)).toBeGreaterThan(estimateTokens(html) + 500);
    const out = distill(await measure(padded));
    expect(estimateTokens(out)).toBeLessThan(estimateTokens(padded));
    expect(out).not.toContain("value-199");
  });
}, 30_000);

describe("distill (pure function contract)", () => {
  const doc: MeasuredDoc = {
    viewport: { w: 393, h: 852 },
    nodes: [{
      selector: "main:nth-of-type(1) > div:nth-of-type(2)",
      tag: "div",
      role: "button",
      text: 'Say "hi"\nthere',
      bbox: { x: 0, y: 30.000001, w: 393, h: 55.96 },
      style: { color: "rgb(1, 2, 3)", opacity: "1", position: "static", borderRadius: "0px", effectiveBackground: "rgb(11, 11, 15)" },
    }],
  };

  it("starts with the viewport line derived from the doc", () => {
    expect(distill(doc).split("\n")[0]).toBe("viewport: 393x852");
    expect(distill({ ...doc, viewport: { w: 100, h: 200 } }).split("\n")[0]).toBe("viewport: 100x200");
  });

  it("rounds bbox to one decimal but leaves the selector untouched", () => {
    const l = distill(doc).split("\n")[1];
    expect(l.startsWith("main:nth-of-type(1) > div:nth-of-type(2) <div role=button> [0,30 393x56] ")).toBe(true);
  });

  it("drops initial-value props, keeps the rest including effectiveBackground", () => {
    const l = distill(doc).split("\n")[1];
    expect(l).toContain("color=rgb(1, 2, 3)");
    expect(l).toContain("effectiveBackground=rgb(11, 11, 15)");
    expect(l).not.toMatch(/opacity=|position=|borderRadius=/);
  });

  it("keeps multi-line own text on a single line", () => {
    const lines = distill(doc).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Say \\"hi\\"\\nthere"');
  });

  it("is deterministic and does not mutate its input", () => {
    const snapshot = JSON.stringify(doc);
    expect(distill(doc)).toBe(distill(doc));
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});
