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
}, 30_000);
