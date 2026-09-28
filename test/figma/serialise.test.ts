import { describe, expect, it } from "vitest";
import { cssColor, isInteractive, serialise, type FigmaNode } from "../../src/figma/serialise.js";
import { deterministicCritique } from "../../src/critics/deterministic.js";
import { distill } from "../../src/distill/distill.js";

const solid = (r: number, g: number, b: number, a?: number) => [{ type: "SOLID", color: { r, g, b, a } }];

const frame = (children: FigmaNode[], fill = solid(1, 1, 1)): FigmaNode => ({
  id: "0:1",
  name: "Screen",
  type: "FRAME",
  absoluteBoundingBox: { x: 15445, y: 0, width: 393, height: 852 },
  fills: fill,
  children,
});

describe("cssColor", () => {
  it("emits rgb() for opaque colours, matching measure.ts's paint()", () => {
    expect(cssColor({ r: 0, g: 0.47843137, b: 1 })).toBe("rgb(0, 122, 255)");
    expect(cssColor({ r: 1, g: 1, b: 1 })).toBe("rgb(255, 255, 255)");
  });

  it("emits rgba() with at most 3 decimals when translucent", () => {
    expect(cssColor({ r: 0, g: 0, b: 0, a: 0.5 })).toBe("rgba(0, 0, 0, 0.5)");
  });

  it("multiplies paint opacity into the alpha channel", () => {
    expect(cssColor({ r: 0, g: 0, b: 0 }, 0.25)).toBe("rgba(0, 0, 0, 0.25)");
  });
});

describe("serialise", () => {
  it("makes bboxes relative to the root frame, not canvas-absolute", () => {
    // A frame parked at x=15445 (where design-loop actually placed the Settings screen) must not
    // report x=15445, or every inset and reach check would be meaningless.
    const doc = serialise(
      frame([
        { id: "1:1", name: "Card", type: "FRAME", absoluteBoundingBox: { x: 15465, y: 40, width: 350, height: 100 } },
      ]),
    );
    expect(doc.nodes[0]!.bbox).toEqual({ x: 20, y: 40, w: 350, h: 100 });
    expect(doc.viewport).toEqual({ w: 393, h: 852 });
  });

  it("uses the Figma node id as the selector, so selectors are unique and stable", () => {
    const doc = serialise(
      frame([
        { id: "1:1", name: "A", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 0, width: 10, height: 10 } },
        { id: "1:2", name: "B", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 20, width: 10, height: 10 } },
      ]),
    );
    expect(doc.nodes.map((n) => n.selector)).toEqual(["1:1", "1:2"]);
    expect(new Set(doc.nodes.map((n) => n.selector)).size).toBe(doc.nodes.length);
  });

  it("skips hidden and zero-area nodes", () => {
    const doc = serialise(
      frame([
        { id: "1:1", name: "Hidden", type: "FRAME", visible: false, absoluteBoundingBox: { x: 15445, y: 0, width: 10, height: 10 } },
        { id: "1:2", name: "Empty", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 0, width: 0, height: 10 } },
        { id: "1:3", name: "Real", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 0, width: 10, height: 10 } },
      ]),
    );
    expect(doc.nodes.map((n) => n.selector)).toEqual(["1:3"]);
  });

  it("resolves effectiveBackground from the nearest painted ancestor", () => {
    const doc = serialise(
      frame(
        [
          {
            id: "1:1",
            name: "Card",
            type: "FRAME",
            absoluteBoundingBox: { x: 15445, y: 0, width: 100, height: 50 },
            fills: solid(1, 1, 1),
            children: [
              {
                id: "1:2",
                name: "Label",
                type: "TEXT",
                characters: "Hello",
                absoluteBoundingBox: { x: 15445, y: 0, width: 50, height: 20 },
                fills: solid(0, 0, 0),
                style: { fontSize: 16, fontWeight: 400 },
              },
            ],
          },
        ],
        solid(0.99, 0.976, 0.941), // canvas #fdf9f0
      ),
    );
    const label = doc.nodes.find((n) => n.selector === "1:2")!;
    // The text paints no background of its own, so it inherits the white card, not the cream canvas.
    expect(label.style["effectiveBackground"]).toBe("rgb(255, 255, 255)");
    expect(label.style["color"]).toBe("rgb(0, 0, 0)");
    expect(label.style["backgroundColor"]).toBeUndefined();
  });

  it("marks nodes with a prototyping reaction as interactive", () => {
    expect(isInteractive({ id: "1:1", name: "Mystery", type: "FRAME", reactions: [{}] })).toBe(true);
  });

  it("falls back to naming conventions for interactivity", () => {
    expect(isInteractive({ id: "1:1", name: "Sign out", type: "FRAME" })).toBe(false);
    expect(isInteractive({ id: "1:1", name: "Primary Button", type: "FRAME" })).toBe(true);
    expect(isInteractive({ id: "1:1", name: "Field / Username", type: "FRAME" })).toBe(true);
  });

  it("gives interactive nodes a tag and role the deterministic critic recognises", () => {
    const doc = serialise(
      frame([
        { id: "1:1", name: "Toggle", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 0, width: 48, height: 28 } },
      ]),
    );
    expect(doc.nodes[0]!.tag).toBe("button");
    expect(doc.nodes[0]!.role).toBe("button");
  });
});

describe("serialise feeds the existing pipeline unchanged", () => {
  it("produces a doc the deterministic critic flags for a small tap target", () => {
    const doc = serialise(
      frame([
        { id: "1:1", name: "Toggle", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 100, width: 48, height: 28 } },
      ]),
    );
    const { critique } = deterministicCritique(doc, {});
    const tap = critique.issues.find((i) => i.id.startsWith("det-tap-"));
    expect(tap).toBeDefined();
    expect(tap!.evidence.selector).toBe("1:1");
    expect(tap!.evidence.observed).toBe("48x28px");
  });

  it("produces a doc the deterministic critic flags for failing contrast", () => {
    // #fdf9f0 on #007aff is 3.82:1 — the exact blocker the Stitch runs kept producing.
    const doc = serialise(
      frame([
        {
          id: "1:1",
          name: "Segment",
          type: "FRAME",
          absoluteBoundingBox: { x: 15445, y: 0, width: 80, height: 44 },
          fills: solid(0, 0.478, 1),
          children: [
            {
              id: "1:2",
              name: "Label",
              type: "TEXT",
              characters: "Light",
              absoluteBoundingBox: { x: 15445, y: 0, width: 40, height: 20 },
              fills: solid(0.992, 0.976, 0.941),
              style: { fontSize: 12, fontWeight: 600 },
            },
          ],
        },
      ]),
    );
    const { critique } = deterministicCritique(doc, {});
    const contrast = critique.issues.find((i) => i.id.startsWith("det-contrast-"));
    expect(contrast).toBeDefined();
    expect(contrast!.evidence.selector).toBe("1:2");
    expect(contrast!.evidence.observed).toMatch(/ratio 3\.8\d:1/);
  });

  it("distills to the same line format the critics' LEGEND describes", () => {
    const doc = serialise(
      frame([
        {
          id: "1:1",
          name: "Label",
          type: "TEXT",
          characters: "Settings",
          absoluteBoundingBox: { x: 15465, y: 10, width: 100, height: 22 },
          fills: solid(0, 0, 0),
          style: { fontSize: 16, fontWeight: 400 },
        },
      ]),
    );
    const text = distill(doc);
    expect(text.split("\n")[0]).toBe("viewport: 393x852");
    const line = text.split("\n")[1]!;
    expect(line.startsWith("1:1 <span> d=0 [20,10 100x22]")).toBe(true);
    expect(line).toContain('"Settings"');
    // selectors must never contain whitespace, or the digest line stops parsing for the model
    expect(doc.nodes.every((n) => !/\s/.test(n.selector))).toBe(true);
  });

  it("scores token conformance against a tokens file", () => {
    const doc = serialise(
      frame([
        {
          id: "1:1",
          name: "Label",
          type: "TEXT",
          characters: "Hi",
          absoluteBoundingBox: { x: 15445, y: 0, width: 50, height: 20 },
          fills: solid(1, 0, 0), // not a token
          style: { fontSize: 11, fontWeight: 400 }, // not a token either
        },
      ]),
    );
    const tokens = { color: { ok: { $value: "#0058bc" } }, typography: { body: { $value: "16px" } } };
    const { critique, measurementsPass } = deterministicCritique(doc, tokens);
    expect(critique.issues.some((i) => i.id.startsWith("det-token-"))).toBe(true);
    expect(critique.score).toBeLessThan(100);
    expect(measurementsPass).toBe(false);
  });
});
