import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { measure } from "../../src/measure/measure.js";

const html = readFileSync(new URL("../fixtures/html/simple.html", import.meta.url), "utf8");

describe("measure", () => {
  it("reports the phone viewport", async () => {
    const doc = await measure(html);
    expect(doc.viewport).toEqual({ w: 393, h: 852 });
  });

  it("captures real geometry, not CSS text", async () => {
    const doc = await measure(html);
    const btn = doc.nodes.find(n => n.selector === "#b1")!;
    expect(btn.bbox.w).toBe(30);
    expect(btn.bbox.h).toBe(30);
  });

  it("captures cascaded computed colours as rgb", async () => {
    const doc = await measure(html);
    const p = doc.nodes.find(n => n.selector === "#p1")!;
    expect(p.style.color).toBe("rgb(42, 42, 51)");
    expect(p.style.backgroundColor).toBe("rgb(11, 11, 15)"); // .faint sets its own background
  });

  it("skips invisible and zero-area nodes", async () => {
    const doc = await measure(`<div style="display:none" id="x">hi</div>`);
    expect(doc.nodes.find(n => n.selector === "#x")).toBeUndefined();
  });

  it("reports only an element's OWN text, not its descendants' text", async () => {
    const doc = await measure(`<div id="d"><p id="t">hi</p></div>`);
    expect(doc.nodes.find(n => n.selector === "#d")!.text).toBe("");
    expect(doc.nodes.find(n => n.selector === "#t")!.text).toBe("hi");
  });

  it("supplies effectiveBackground from the nearest painted ancestor, through body", async () => {
    const doc = await measure(`<body style="margin:0;background:#0B0B0F"><div><p id="t">hi</p></div></body>`);
    expect(doc.nodes.find(n => n.selector === "#t")!.style.effectiveBackground).toBe("rgb(11, 11, 15)");
  });

  it("uses an element's own background as its effectiveBackground", async () => {
    const doc = await measure(html);
    expect(doc.nodes.find(n => n.selector === "#p1")!.style.effectiveBackground).toBe("rgb(11, 11, 15)");
  });

  it("falls back to white when nothing paints a background", async () => {
    const doc = await measure(`<p id="t">hi</p>`);
    expect(doc.nodes.find(n => n.selector === "#t")!.style.effectiveBackground).toBe("rgb(255, 255, 255)");
  });

  it("gives every node a unique selector, even with duplicate or awkward ids", async () => {
    const doc = await measure(`<p id="a">x</p><p id="a">y</p><p id="b:c">z</p>`);
    const sels = doc.nodes.map(n => n.selector);
    expect(new Set(sels).size).toBe(sels.length);
    expect(sels).not.toContain("#a");
    expect(sels).toContain("#b\\:c");
  });

  it("reports depth as the number of ancestors between a node and <body>", async () => {
    const doc = await measure(`<div id="a"><div id="b"><p id="c">x</p></div></div>`);
    const depth = (sel: string) => doc.nodes.find(n => n.selector === sel)!.depth;
    expect(["#a", "#b", "#c"].map(depth)).toEqual([0, 1, 2]);
  });

  it("normalises a colour in any syntax to rgb(), so the contrast and token checks can read it", async () => {
    const doc = await measure(`<p id="t" style="color:oklch(0.7 0.15 50)">hi</p>`);
    expect(doc.nodes.find(n => n.selector === "#t")!.style.color).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });

  it("keeps the alpha of a translucent colour, rounded to three decimals", async () => {
    const doc = await measure(`<p id="t" style="color:rgba(255, 0, 0, 0.5)">hi</p>`);
    // 0.5 alpha is stored as the byte 128, so it reads back as 128/255 = 0.502.
    expect(doc.nodes.find(n => n.selector === "#t")!.style.color).toBe("rgba(255, 0, 0, 0.502)");
  });

  it("treats a zero-alpha background as unpainted, whatever its colour channels say", async () => {
    const doc = await measure(
      `<body style="margin:0;background:#0B0B0F"><div style="background:rgba(255,255,255,0)"><p id="t">hi</p></div></body>`,
    );
    expect(doc.nodes.find(n => n.selector === "#t")!.style.effectiveBackground).toBe("rgb(11, 11, 15)");
  });

  it("measures an inline SVG as one node, not one line per shape inside the icon", async () => {
    const doc = await measure(
      `<svg id="icon" width="24" height="24"><circle cx="5" cy="5" r="4"/><rect x="1" y="1" width="8" height="8"/><path d="M0 0 L10 10"/></svg>`,
    );
    expect(doc.nodes.filter(n => n.tag === "svg")).toHaveLength(1);
    expect(doc.nodes.map(n => n.tag)).not.toContain("circle");
    expect(doc.nodes.map(n => n.tag)).not.toContain("rect");
    expect(doc.nodes.map(n => n.tag)).not.toContain("path");
  });
}, 30_000);
