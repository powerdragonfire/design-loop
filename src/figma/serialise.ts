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
  /** Shared styles the node uses, by kind; `text` is looked up in `FigmaNodeResponse.styles` for its name. */
  styles?: Record<string, string>;
  /** How the node behaves when its frame scrolls. `FIXED` and `STICKY_SCROLLS` stay on screen. */
  scrollBehavior?: string;
  /** The older spelling of `scrollBehavior: "FIXED"`. */
  isFixed?: boolean;
  /** Set on a scrolling frame: its LAST this-many children are fixed (the Plugin API's own definition). */
  numberOfFixedChildren?: number;
  children?: FigmaNode[];
}

/** The component and set names an instance resolves to. */
export interface ComponentNames {
  components?: Record<string, { name: string; componentSetId?: string }>;
  componentSets?: Record<string, { name: string }>;
  /** Shared style names by id, so a text layer set in `typography/headline-md` can be exposed as a heading. */
  styles?: Record<string, { name: string }>;
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
const CONTROL_WORDS = new Set(["button", "btn", "link", "tab", "toggle", "switch", "chip", "action", "row", "field", "input", "cta"]);

/**
 * A name says "control" only when the control word is its HEAD noun: the last word of one of its `/` segments.
 * "Primary Button", "Leading action", "Tab / Today" and "Switch row / Push" are controls; "Action bar",
 * "Invite link card" and "Navigation / Trip Tab Bar" are containers that merely mention one, and reading those as
 * a button made each one a single tap target that swallowed the real buttons inside it.
 *
 * A trailing "Item", with a "Bar" before it, names one member of the thing before it: "Tab Bar Item" is a tab,
 * while "Checklist Item" is still not a control.
 */
function namesControl(name: string): boolean {
  return name.split("/").some((segment) => {
    const words = segment.toLowerCase().match(/[a-z]+/g) ?? [];
    if (words.at(-1) === "item") {
      words.pop();
      if (words.at(-1) === "bar") words.pop();
    }
    return words.length > 0 && CONTROL_WORDS.has(words[words.length - 1]!);
  });
}

const hasReactions = (node: FigmaNode): boolean => Array.isArray(node.reactions) && node.reactions.length > 0;

/**
 * An instance's own layer name is usually its label ("Sign out"), which says nothing about what it is. Its main
 * component says more ("Settings/Account action"), and for a variant the component is named only by its props
 * ("State=Default, Size=Large") — the word "Button" lives on the component SET. All three are checked.
 */
export function isInteractive(node: FigmaNode, names: ComponentNames = {}): boolean {
  if (hasReactions(node)) return true;
  if (namesControl(node.name)) return true;
  const component = node.componentId ? names.components?.[node.componentId] : undefined;
  if (!component) return false;
  if (namesControl(component.name)) return true;
  const set = component.componentSetId ? names.componentSets?.[component.componentSetId] : undefined;
  return set !== undefined && namesControl(set.name);
}

/** Figma's default layer names, which name nothing a screen reader could announce. */
const GENERIC_NAME = /^(frame|group|rectangle|ellipse|vector|image|photo|instance|icon|component|union|subtract|mask|layer|slot|auto layout)(\s*\d+)?$/i;

/** A variant whose props say it is the selected / active / on state of its control. */
const SELECTED_VARIANT = /(^|[,\s])(state|selected|active|checked|value)\s*=\s*(selected|active|on|true|checked)\b/i;

/** Text style names that mark a heading: Spontai's `typography/headline-*`, and the usual display/title/heading. */
const HEADING_STYLE = /(headline|heading|display|title)/i;

const hasImageFill = (node: FigmaNode): boolean => (node.fills ?? []).some((p) => p.visible !== false && p.type === "IMAGE");

/** The tag a node has when it is not the control: interactivity is decided by the walk, not per node. */
function baseTag(node: FigmaNode): string {
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

/** A layer name as one whitespace-free selector segment: distill prints the selector as a line's first token. */
const segment = (node: FigmaNode): string => node.name.trim().replace(/\s+/g, "_") || node.type.toLowerCase();

/**
 * Turns a Figma frame into the same `MeasuredDoc` the Chromium path produces, so every downstream
 * consumer — distill, the deterministic critic, evidence validation, inspect, the report — works
 * unchanged.
 *
 * `selector` must be unique and STABLE ACROSS ROUNDS: the store tracks issues by id and deterministic ids
 * embed the selector, evidence is validated against it, and a resolution is verified by comparing the same
 * selector before and after. Node ids are not stable here — every round is a duplicate of the last, and a
 * duplicate gets fresh ids — so the selector is the path of layer names from the root, which duplication
 * preserves (`Content>Tile_grid>Tile_/_Notifications>Content>Switch_row_/_Push`). Siblings sharing a name
 * are told apart by their order among those siblings (`Frame[1]`). Renaming a layer changes its path, which
 * is honest: it is then a different element.
 *
 * `effectiveBackground` is resolved here because a check cannot walk ancestors from a single node, and
 * `parent` names the nearest emitted ancestor so checks that compare siblings can group them.
 */
export function serialise(root: FigmaNode, opts: SerialiseOptions = {}): MeasuredDoc {
  /**
   * How many separate controls a subtree holds. A node named like a control that holds two or more is a
   * container of controls ("Chip row", "Button group"), not one big target; with one or none it is the hit
   * area, and the control inside it is measured once, as part of it. A prototyping reaction is a hard signal
   * and always makes the node the target.
   */
  const counted = new Map<FigmaNode, number>();
  const inside = (node: FigmaNode): number => (node.children ?? []).reduce((sum, c) => sum + controlsIn(c), 0);
  const isControl = (node: FigmaNode): boolean => isInteractive(node, opts) && (hasReactions(node) || inside(node) < 2);
  const controlsIn = (node: FigmaNode): number => {
    const known = counted.get(node);
    if (known !== undefined) return known;
    const n = node.visible === false ? 0 : isControl(node) ? 1 : inside(node);
    counted.set(node, n);
    return n;
  };
  const hasText = (node: FigmaNode): boolean =>
    node.visible !== false && ((node.type === "TEXT" && !!node.characters?.trim()) || (node.children ?? []).some(hasText));
  const componentName = (node: FigmaNode): string | undefined =>
    node.componentId ? opts.components?.[node.componentId]?.name : undefined;

  const box = root.absoluteBoundingBox;
  const originX = box?.x ?? 0;
  const originY = box?.y ?? 0;
  const viewport = opts.viewport ?? { w: Math.round(box?.width ?? 0), h: Math.round(box?.height ?? 0) };
  const nodes: MeasuredNode[] = [];

  /**
   * `path` is this node's selector. `parent` is the nearest ancestor that was emitted. `inControl` is true
   * inside something already counted as a control: nested controls are one tap target, the outermost, so
   * an inner "Button" inside a 44pt "Leading action" is not measured again as a separate, smaller target.
   */
  const walk = (
    node: FigmaNode, path: string, parent: string | undefined, depth: number, inheritedBg: string, inControl: boolean,
    pinned: boolean, fixed: boolean,
  ): void => {
    if (node.visible === false) return;

    const own = solidFill(node);
    // A TEXT node's fill is its glyph colour, NOT a background — treating it as one made every label
    // its own backdrop and reported 1.00:1 contrast, hiding real failures. Only non-text nodes paint.
    const ownBackground = node.type === "TEXT" ? null : own;
    // A node that paints nothing inherits whatever is painted behind it. Partial alpha is not
    // composited, matching measure.ts's documented v1 limitation.
    const effectiveBg = ownBackground ?? inheritedBg;

    const b = node.absoluteBoundingBox;
    const control = !inControl && isControl(node);
    // Zero-area nodes are dropped exactly as the DOM path drops zero-area rects: they cannot be seen,
    // cited, or tapped, and they would dilute the hallucination rate with unciteable selectors.
    const emitted = !!(b && b.width > 0 && b.height > 0);
    if (b && emitted) {
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
      if (fixed) style["position"] = "fixed";

      // What a screen reader would get. Figma has no aria, so it is read from what the file does say: a text
      // style named like a heading, an image fill, a control's own layer name when it shows no text, and a
      // variant named for its selected state. Without these the critics flag, every round, a missing heading or
      // accessible name the designer has no way to add.
      const image = node.type !== "TEXT" && hasImageFill(node);
      const textStyle = node.styles?.["text"] ? opts.styles?.[node.styles["text"]]?.name : undefined;
      const heading = node.type === "TEXT" && !!text.trim() && (HEADING_STYLE.test(textStyle ?? "") || /^heading\b/i.test(node.name));
      const ownName = node.name.trim();
      const named = ownName !== "" && !GENERIC_NAME.test(ownName) && ownName !== componentName(node);
      const label = ((control && !hasText(node)) || image) && named ? ownName : undefined;
      const selected = control && SELECTED_VARIANT.test(componentName(node) ?? "");

      nodes.push({
        selector: path,
        ...(parent !== undefined ? { parent } : {}),
        tag: control ? "button" : image ? "img" : baseTag(node),
        role: control ? "button" : image ? "img" : heading ? "heading" : null,
        ...(label !== undefined ? { label } : {}),
        ...(selected ? { selected } : {}),
        pinned,
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

    walkChildren(node, path, emitted ? path : parent, depth + 1, effectiveBg, inControl || control, pinned);
  };

  const walkChildren = (
    node: FigmaNode, path: string | null, parent: string | undefined, depth: number, bg: string, inControl: boolean, pinned: boolean,
  ): void => {
    // Every child counts towards a name's occurrence index, hidden or not, so hiding one layer does not
    // renumber its siblings between rounds.
    const seen = new Map<string, number>();
    const children = node.children ?? [];
    // The Plugin API's `numberOfFixedChildren` counts from the END of the list: the topmost layers.
    const firstFixed = children.length - (node.numberOfFixedChildren ?? 0);
    children.forEach((child, index) => {
      const seg = segment(child);
      const n = seen.get(seg) ?? 0;
      seen.set(seg, n + 1);
      const own = n === 0 ? seg : `${seg}[${n}]`;
      const fixed = index >= firstFixed || child.isFixed === true ||
        child.scrollBehavior === "FIXED" || child.scrollBehavior === "STICKY_SCROLLS";
      walk(child, path === null ? own : `${path}>${own}`, parent, depth, bg, inControl, pinned || fixed, fixed);
    });
  };

  // The root frame itself is the canvas, not a node in it — the DOM path does not emit <body> either.
  const rootBg = solidFill(root) ?? opts.rootBackground ?? "rgb(255, 255, 255)";
  walkChildren(root, null, undefined, 0, rootBg, false, false);

  return { viewport, nodes };
}
