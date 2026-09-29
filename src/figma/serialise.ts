import type { MeasuredDoc, MeasuredNode } from "../types.js";

/**
 * The subset of Figma's node shape this serialiser reads. Deliberately our own type rather than a
 * vendor import: the REST API (`GET /v1/files/:key/nodes`) and the Plugin API agree on these fields,
 * so one serialiser serves both, and a test can build a tree by hand without a Figma dependency.
 */
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  fills?: FigmaPaint[];
  characters?: string;
  style?: {
    fontFamily?: string;
    fontWeight?: number;
    fontSize?: number;
  };
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  /** Prototyping links. Their presence is the strongest available signal that a node is tappable. */
  reactions?: unknown[];
  /** INSTANCE only: the main component, looked up in `FigmaNodeResponse.components` for its name. */
  componentId?: string;
  children?: FigmaNode[];
}

/** The component and set names an instance resolves to. */
export interface ComponentNames {
  components?: Record<string, { name: string; componentSetId?: string }>;
  componentSets?: Record<string, { name: string }>;
}

/** What `GET /v1/files/:key/nodes` returns for one id: the subtree, plus the names its instances point at. */
export interface FigmaNodeResponse extends ComponentNames {
  document: FigmaNode;
}

export interface FigmaPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a?: number };
}

/**
 * Matches `measure.ts`'s in-browser `paint()` byte-for-byte: opaque colours are `rgb(r, g, b)`,
 * translucent ones `rgba(r, g, b, a)` with alpha to at most 3 decimals. The deterministic critic
 * canonicalises through this exact string form, `smoke` asserts `/^rgba?\(/` on it, and the critics'
 * LEGEND promises models "Colours are rgb()/rgba() only" — so the format is a contract, not a detail.
 */
export function cssColor(color: { r: number; g: number; b: number; a?: number }, opacity?: number): string {
  const ch = [color.r, color.g, color.b].map((v) => Math.round(v * 255));
  const a = (color.a ?? 1) * (opacity ?? 1);
  return a >= 1
    ? `rgb(${ch.join(", ")})`
    : `rgba(${ch.join(", ")}, ${Number(a.toFixed(3))})`;
}

/** The first visible solid fill, or null when a node paints nothing we can read. */
function solidFill(node: FigmaNode): string | null {
  for (const p of node.fills ?? []) {
    if (p.visible === false) continue;
    // Gradients and images are not colours we can compare against tokens or contrast-check, so they
    // are skipped rather than guessed at — the same choice measure.ts makes for oklch()/color().
    if (p.type !== "SOLID" || !p.color) continue;
    const css = cssColor(p.color, p.opacity);
    if (css.startsWith("rgba(") && css.endsWith(", 0)")) continue; // fully transparent paints nothing
    return css;
  }
  return null;
}

/** Figma gives radii per-corner or as one value; the critic accepts either `12px` or `12px 0px …`. */
function radius(node: FigmaNode): string | null {
  if (Array.isArray(node.rectangleCornerRadii) && node.rectangleCornerRadii.length === 4) {
    const parts = node.rectangleCornerRadii.map((r) => `${Number(r.toFixed(2))}px`);
    return parts.every((p) => p === parts[0]) ? parts[0]! : parts.join(" ");
  }
  if (typeof node.cornerRadius === "number") return `${Number(node.cornerRadius.toFixed(2))}px`;
  return null;
}

const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION", "SLOT"]);

/**
 * `tapIssues` and `insetIssues` only look at nodes whose `tag` is button/a/input/select or whose
 * `role` is "button" (deterministic.ts). Figma has no such concept, so without a mapping BOTH checks
 * go silent and the gate never fires on reach or size — the single easiest way to get a Figma run
 * that looks clean and is not. A prototyping reaction is the only hard signal Figma gives; beyond
 * that this falls back to the naming conventions design systems actually use.
 */
const INTERACTIVE_NAME = /(^|[^a-z])(button|btn|link|tab|toggle|switch|chip|action|row|field|input|cta)([^a-z]|$)/i;

/**
 * An instance's own layer name is usually its label ("Sign out"), which says nothing about what it is. Its main
 * component says more ("Settings/Account action"), and for a variant the component is named only by its props
 * ("State=Default, Size=Large") — the word "Button" lives on the component SET. All three are checked.
 */
export function isInteractive(node: FigmaNode, names: ComponentNames = {}): boolean {
  if (Array.isArray(node.reactions) && node.reactions.length > 0) return true;
  if (INTERACTIVE_NAME.test(node.name)) return true;
  const component = node.componentId ? names.components?.[node.componentId] : undefined;
  if (!component) return false;
  if (INTERACTIVE_NAME.test(component.name)) return true;
  const set = component.componentSetId ? names.componentSets?.[component.componentSetId] : undefined;
  return set !== undefined && INTERACTIVE_NAME.test(set.name);
}

function tagOf(node: FigmaNode, names: ComponentNames): string {
  if (isInteractive(node, names)) return "button";
  if (node.type === "TEXT") return "span";
  if (CONTAINER_TYPES.has(node.type)) return "div";
  return node.type.toLowerCase();
}

export interface SerialiseOptions extends ComponentNames {
  /**
   * Viewport the bboxes are expressed in. Defaults to the root frame's own size. Coordinates are made
   * relative to the root, because `insetIssues` compares `bbox.y` against a fixed viewport height and
   * Figma's `absoluteBoundingBox` is canvas-absolute (a frame at x=15445 would fail every check).
   */
  viewport?: { w: number; h: number };
  /** Background painted behind the root, used when no ancestor paints one. Matches the browser's white canvas. */
  rootBackground?: string;
}

/**
 * Turns a Figma frame into the same `MeasuredDoc` the Chromium path produces, so every downstream
 * consumer — distill, the deterministic critic, evidence validation, inspect, the report — works
 * unchanged.
 *
 * Two properties matter more than completeness. `selector` must be unique and stable across rounds:
 * Figma node ids are both, which is strictly better than the positional CSS paths the HTML path falls
 * back to on pages without ids. And `effectiveBackground` must be resolved here, because MeasuredDoc
 * has no parent links and the contrast check cannot walk ancestors itself.
 */
export function serialise(root: FigmaNode, opts: SerialiseOptions = {}): MeasuredDoc {
  const box = root.absoluteBoundingBox;
  const originX = box?.x ?? 0;
  const originY = box?.y ?? 0;
  const viewport = opts.viewport ?? { w: Math.round(box?.width ?? 0), h: Math.round(box?.height ?? 0) };
  const nodes: MeasuredNode[] = [];

  const walk = (node: FigmaNode, depth: number, inheritedBg: string): void => {
    if (node.visible === false) return;

    const own = solidFill(node);
    // A TEXT node's fill is its glyph colour, NOT a background — treating it as one made every label
    // its own backdrop and reported 1.00:1 contrast, hiding real failures. Only non-text nodes paint.
    const ownBackground = node.type === "TEXT" ? null : own;
    // A node that paints nothing inherits whatever is painted behind it. Partial alpha is not
    // composited, matching measure.ts's documented v1 limitation.
    const effectiveBg = ownBackground ?? inheritedBg;

    const b = node.absoluteBoundingBox;
    // Zero-area nodes are dropped exactly as the DOM path drops zero-area rects: they cannot be seen,
    // cited, or tapped, and they would dilute the hallucination rate with unciteable selectors.
    if (b && b.width > 0 && b.height > 0) {
      const style: Record<string, string> = {};
      const text = node.characters ?? "";

      if (node.type === "TEXT" && own) style["color"] = own;
      else if (ownBackground) style["backgroundColor"] = ownBackground;
      style["effectiveBackground"] = effectiveBg;

      if (node.style?.fontSize !== undefined) style["fontSize"] = `${Number(node.style.fontSize.toFixed(2))}px`;
      if (node.style?.fontWeight !== undefined) style["fontWeight"] = String(node.style.fontWeight);
      if (node.style?.fontFamily) style["fontFamily"] = node.style.fontFamily;
      const r = radius(node);
      if (r) style["borderRadius"] = r;
      if (node.opacity !== undefined && node.opacity < 1) style["opacity"] = String(Number(node.opacity.toFixed(3)));

      nodes.push({
        selector: node.id,
        tag: tagOf(node, opts),
        role: isInteractive(node, opts) ? "button" : null,
        text,
        bbox: {
          x: Number((b.x - originX).toFixed(2)),
          y: Number((b.y - originY).toFixed(2)),
          w: Number(b.width.toFixed(2)),
          h: Number(b.height.toFixed(2)),
        },
        style,
        depth,
      });
    }

    for (const child of node.children ?? []) walk(child, depth + 1, effectiveBg);
  };

  // The root frame itself is the canvas, not a node in it — the DOM path does not emit <body> either.
  const rootBg = solidFill(root) ?? opts.rootBackground ?? "rgb(255, 255, 255)";
  for (const child of root.children ?? []) walk(child, 0, rootBg);

  return { viewport, nodes };
}
