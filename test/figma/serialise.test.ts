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

  it("uses the layer-name path as the selector, unique within the frame", () => {
    const doc = serialise(
      frame([
        { id: "1:1", name: "A", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 0, width: 10, height: 10 } },
        { id: "1:2", name: "B", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 20, width: 10, height: 10 } },
      ]),
    );
    expect(doc.nodes.map((n) => n.selector)).toEqual(["A", "B"]);
    expect(new Set(doc.nodes.map((n) => n.selector)).size).toBe(doc.nodes.length);
  });

  it("gives a duplicated frame the same selectors, though every node id changed", () => {
    // Each round is a duplicate of the last, and a duplicate gets fresh ids. The store tracks issues by
    // selector-derived ids, so selectors must survive duplication or nothing can be tracked across rounds.
    const tree = (a: string, b: string, c: string): FigmaNode => frame([
      { id: a, name: "Tile grid", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 0, width: 350, height: 200 },
        children: [
          { id: b, name: "Tile / Account", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 0, width: 169, height: 166 } },
          { id: c, name: "Tile / Albums", type: "FRAME", absoluteBoundingBox: { x: 15626, y: 0, width: 169, height: 166 } },
        ] },
    ]);
    const v00 = serialise(tree("2072:1", "2072:2", "2072:3")).nodes.map((n) => n.selector);
    const v01 = serialise(tree("2076:1", "2076:2", "2076:3")).nodes.map((n) => n.selector);
    expect(v01).toEqual(v00);
    expect(v00).toEqual(["Tile_grid", "Tile_grid>Tile_/_Account", "Tile_grid>Tile_/_Albums"]);
  });

  it("tells same-named siblings apart by order, and never puts whitespace in a selector", () => {
    const doc = serialise(frame([
      { id: "1:1", name: "Frame", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 0, width: 10, height: 10 } },
      { id: "1:2", name: "Frame", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 20, width: 10, height: 10 } },
    ]));
    expect(doc.nodes.map((n) => n.selector)).toEqual(["Frame", "Frame[1]"]);
    expect(doc.nodes.every((n) => !/\s/.test(n.selector))).toBe(true);
  });

  it("names each node's nearest measured ancestor as its parent", () => {
    const doc = serialise(frame([
      { id: "1:1", name: "Grid", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 0, width: 350, height: 200 },
        children: [{ id: "1:2", name: "Tile", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 0, width: 169, height: 166 } }] },
    ]));
    expect(doc.nodes.find((n) => n.selector === "Grid")!.parent).toBeUndefined();
    expect(doc.nodes.find((n) => n.selector === "Grid>Tile")!.parent).toBe("Grid");
  });

  it("measures nested controls once, at the outermost hit area", () => {
    // The Spontai header: a 44x44 "Leading action" holding a 36x44 "Button". The tap target is the outer
    // one; measuring the inner one too reported a blocker that did not exist.
    const doc = serialise(frame([
      { id: "1:1", name: "Leading action", type: "FRAME", absoluteBoundingBox: { x: 15461, y: 100, width: 44, height: 44 },
        children: [{ id: "1:2", name: "Button", type: "FRAME", absoluteBoundingBox: { x: 15465, y: 100, width: 36, height: 44 } }] },
    ]));
    expect(doc.nodes.map((n) => [n.selector, n.role])).toEqual([["Leading_action", "button"], ["Leading_action>Button", null]]);
    const { critique } = deterministicCritique(doc, {});
    expect(critique.issues.filter((i) => i.id.startsWith("det-tap-"))).toEqual([]);
  });

  it("skips hidden and zero-area nodes", () => {
    const doc = serialise(
      frame([
        { id: "1:1", name: "Hidden", type: "FRAME", visible: false, absoluteBoundingBox: { x: 15445, y: 0, width: 10, height: 10 } },
        { id: "1:2", name: "Empty", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 0, width: 0, height: 10 } },
        { id: "1:3", name: "Real", type: "FRAME", absoluteBoundingBox: { x: 15445, y: 0, width: 10, height: 10 } },
      ]),
    );
    expect(doc.nodes.map((n) => n.selector)).toEqual(["Real"]);
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
    const label = doc.nodes.find((n) => n.selector === "Card>Label")!;
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

  describe("interactivity from component names", () => {
    const names = {
      components: {
        "c:action": { name: "Settings/Account action" },
        "c:variant": { name: "State=Default, Size=Large", componentSetId: "s:button" },
        "c:avatar": { name: "Data / Avatar Stack" },
      },
      componentSets: { "s:button": { name: "Primary Button" } },
    };
    const instance = (name: string, componentId: string): FigmaNode => ({ id: "9:9", name, type: "INSTANCE", componentId });

    it("reads an instance named for its label through its main component", () => {
      // The real Spontai case: the layer is called "Sign out", which says nothing; its component says "action".
      expect(isInteractive(instance("Sign out", "c:action"), names)).toBe(true);
      expect(isInteractive(instance("Sign out", "c:action"))).toBe(false); // without the names it cannot tell
    });

    it("reads a variant through its component set, since the variant is named only by its props", () => {
      expect(isInteractive(instance("Save", "c:variant"), names)).toBe(true);
    });

    it("leaves a decorative instance alone", () => {
      expect(isInteractive(instance("Avatars", "c:avatar"), names)).toBe(false);
    });

    it("feeds the names into the doc, so tap and safe-area checks see the instance", () => {
      const doc = serialise(
        frame([{ ...instance("Sign out", "c:action"), absoluteBoundingBox: { x: 15445, y: 100, width: 120, height: 30 } }]),
        names,
      );
      expect(doc.nodes[0]!.tag).toBe("button");
      expect(doc.nodes[0]!.role).toBe("button");
      const { critique } = deterministicCritique(doc, {});
      expect(critique.issues.some((i) => i.id.startsWith("det-tap-"))).toBe(true); // 120x30 is under 44pt tall
    });
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
    expect(tap!.evidence.selector).toBe("Toggle");
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
    expect(contrast!.evidence.selector).toBe("Segment>Label");
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
    expect(line.startsWith("Label <span> d=0 [20,10 100x22]")).toBe(true);
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
