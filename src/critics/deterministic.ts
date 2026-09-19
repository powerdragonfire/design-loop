import { HOME_INDICATOR_INSET, VIEWPORT } from "../measure/measure.js";
import type { Critique, Issue, MeasuredDoc, MeasuredNode } from "../types.js";

const MIN_CONTRAST = 4.5;
const MIN_CONTRAST_LARGE = 3.0;
const MIN_TAP = 44;

// ---- colour ---------------------------------------------------------------

interface Rgba { r: number; g: number; b: number; a: number }

const RGB_RE = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i;
const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function parseColor(s: string): Rgba | null {
  const str = s.trim();
  const rgb = RGB_RE.exec(str);
  if (rgb) {
    return { r: +rgb[1]!, g: +rgb[2]!, b: +rgb[3]!, a: rgb[4] === undefined ? 1 : +rgb[4] };
  }
  const hex = HEX_RE.exec(str);
  if (hex) {
    let h = hex[1]!;
    if (h.length <= 4) h = [...h].map(c => c + c).join("");
    const byte = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: h.length === 8 ? byte(6) / 255 : 1 };
  }
  return null;
}

/** Canonical `rgb(...)` / `rgba(...)` form so hex tokens and computed styles compare equal. */
function colorKey(c: Rgba): string {
  const ch = [c.r, c.g, c.b].map(Math.round).join(", ");
  return c.a >= 1 ? `rgb(${ch})` : `rgba(${ch}, ${Number(c.a.toFixed(2))})`;
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio. A translucent foreground is composited over `bg` first. */
export function contrastRatio(fg: string, bg: string): number {
  const b = parseColor(bg);
  let f = parseColor(fg);
  if (!f || !b) throw new Error(`contrastRatio: unparseable colour (${fg} on ${bg})`);
  if (f.a < 1) {
    f = {
      r: f.r * f.a + b.r * (1 - f.a),
      g: f.g * f.a + b.g * (1 - f.a),
      b: f.b * f.a + b.b * (1 - f.a),
      a: 1,
    };
  }
  const [l1, l2] = [luminance(f), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---- tokens ---------------------------------------------------------------

interface AllowedTokens {
  colors: Set<string>;
  fontSizes: Set<string>;
  radii: Set<string>;
}

/** `16px`, `1.5rem`, or a bare number (px) -> canonical `16px`; anything else -> null. */
function dimension(v: string | number): string | null {
  const m = typeof v === "number" ? [v, String(v), "px"] : /^(-?\d*\.?\d+)\s*(px|rem|em)?$/i.exec(v.trim());
  if (!m) return null;
  const unit = String(m[2] ?? "px").toLowerCase();
  const n = Number(m[1]) * (unit === "px" ? 1 : 16);
  return `${Number(n.toFixed(2))}px`;
}

const FONT_SIZE_KEY = /^font-?sizes?$/i;
const TYPE_GROUP = /^(type-?scale|typography|type|text-?sizes?)$/i;
const NOT_A_SIZE = /line-?height|letter-?spacing|leading|tracking|weight/i;
const RADIUS_KEY = /^(radius|radii|border-?radius|corner-?radius|rounded)$/i;

/**
 * Flatten a tokens file into the sets of literals designs may use. Accepts both W3C DTCG
 * leaves (`{ "$value": "#FF7A1A" }`, `$type` inherited from groups) and bare leaves.
 * A category stays empty (= unchecked) unless the file actually defines it.
 */
function allowedTokens(tokens: Record<string, unknown>): AllowedTokens {
  const out: AllowedTokens = { colors: new Set(), fontSizes: new Set(), radii: new Set() };
  const walk = (node: unknown, path: string[], type: string | undefined): void => {
    if (typeof node === "string" || typeof node === "number") {
      const key = path.some(p => FONT_SIZE_KEY.test(p)) || type === "fontSize" ? "fontSizes" : null;
      const radius = path.some(p => RADIUS_KEY.test(p)) || type === "borderRadius";
      if (typeof node === "string") {
        const c = parseColor(node);
        if (c) { out.colors.add(colorKey(c)); return; }
      }
      const dim = dimension(node);
      if (NOT_A_SIZE.test(path.join("."))) return;
      if (radius) {
        out.radii.add(dim ?? String(node).trim().toLowerCase());
      } else if (dim && (key || path.slice(0, -1).some(p => TYPE_GROUP.test(p)))) {
        out.fontSizes.add(dim);
      }
      return;
    }
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    const t = typeof obj["$type"] === "string" ? obj["$type"] : type;
    if ("$value" in obj) return walk(obj["$value"], path, t);
    for (const [k, v] of Object.entries(obj)) {
      if (!k.startsWith("$")) walk(v, [...path, k], t);
    }
  };
  walk(tokens, [], undefined);
  return out;
}

// ---- checks ---------------------------------------------------------------

const px = (s: string | undefined): number => parseFloat(s ?? "");
const isInteractive = (n: MeasuredNode): boolean =>
  ["button", "a", "input", "select"].includes(n.tag) || n.role === "button";

function contrastIssues(nodes: MeasuredNode[]): Issue[] {
  const out: Issue[] = [];
  for (const n of nodes) {
    if (!n.text.trim()) continue;
    const fg = n.style["color"] ?? "";
    const bg = n.style["effectiveBackground"] ?? "";
    // Colour spaces we cannot parse (oklch, color(), ...) are skipped rather than guessed at.
    if (!parseColor(fg) || !parseColor(bg)) continue;
    const size = px(n.style["fontSize"]);
    const weight = parseFloat(n.style["fontWeight"] ?? "400");
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const min = large ? MIN_CONTRAST_LARGE : MIN_CONTRAST;
    const ratio = contrastRatio(fg, bg);
    if (ratio >= min) continue;
    out.push({
      id: `det-contrast-${n.selector}`,
      severity: "blocker",
      evidence: { selector: n.selector, observed: `${fg} on ${bg}, ${size}px/${weight}, ratio ${ratio.toFixed(2)}:1` },
      claim: `Text contrast ${ratio.toFixed(2)}:1 is below the WCAG AA minimum of ${min}:1`,
      fix: `Change the text or background colour so contrast is at least ${min}:1`,
      effort: "low",
    });
  }
  return out;
}

function tapIssues(nodes: MeasuredNode[]): Issue[] {
  return nodes.filter(isInteractive).flatMap(n => {
    const { w, h } = n.bbox;
    if (w >= MIN_TAP && h >= MIN_TAP) return [];
    return [{
      id: `det-tap-${n.selector}`,
      severity: "blocker" as const,
      evidence: { selector: n.selector, observed: `${Math.round(w)}x${Math.round(h)}px` },
      claim: `Tap target is ${Math.round(w)}x${Math.round(h)}px, below the ${MIN_TAP}x${MIN_TAP}px minimum`,
      fix: `Enlarge the hit area to at least ${MIN_TAP}x${MIN_TAP}px (padding or min-width/min-height)`,
      effort: "low" as const,
    }];
  });
}

function insetIssues(nodes: MeasuredNode[]): Issue[] {
  const top = VIEWPORT.h - HOME_INDICATOR_INSET;
  return nodes.filter(isInteractive).flatMap(n => {
    const { y, h } = n.bbox;
    // Interactive elements that start on the first screen and reach into the inset.
    // Below-the-fold elements are not pinned to the bottom; wrappers are not interactive.
    if (!(y < VIEWPORT.h && y + h > top)) return [];
    return [{
      id: `det-inset-${n.selector}`,
      severity: "blocker" as const,
      evidence: { selector: n.selector, observed: `y ${Math.round(y)}-${Math.round(y + h)}px, inset starts at ${top}px` },
      claim: `Interactive element overlaps the ${HOME_INDICATOR_INSET}px home indicator safe area`,
      fix: `Keep bottom controls at least ${HOME_INDICATOR_INSET}px above the bottom edge (safe-area padding)`,
      effort: "low" as const,
    }];
  });
}

/** Returns the issues plus how many token literals were examined (for the score). */
function tokenIssues(nodes: MeasuredNode[], tokens: Record<string, unknown>): { issues: Issue[]; total: number } {
  const allowed = allowedTokens(tokens);
  const issues: Issue[] = [];
  let total = 0;
  const examine = (n: MeasuredNode, prop: string, ok: boolean, value: string, hint: string): void => {
    total++;
    if (ok) return;
    issues.push({
      id: `det-token-${prop}-${n.selector}`,
      severity: "blocker",
      evidence: { selector: n.selector, observed: `${prop}: ${value}` },
      claim: `${prop} ${value} is not a design token`,
      fix: hint,
      effort: "low",
    });
  };
  for (const n of nodes) {
    if (allowed.colors.size > 0) {
      for (const prop of ["color", "backgroundColor"] as const) {
        // `color` is inherited by every node but only painted where there is own text;
        // examining it elsewhere would flag the browser-default black on plain wrappers.
        if (prop === "color" && !n.text.trim()) continue;
        const value = n.style[prop] ?? "";
        const c = parseColor(value);
        if (!c || c.a === 0) continue; // unparseable, or fully transparent (browser default)
        examine(n, prop, allowed.colors.has(colorKey(c)), value, "Use a colour from the tokens file");
      }
    }
    // Like `color`, font size is inherited: only examine it where text is painted.
    const fontSize = dimension(n.style["fontSize"] ?? "");
    if (allowed.fontSizes.size > 0 && fontSize && n.text.trim()) {
      examine(n, "fontSize", allowed.fontSizes.has(fontSize), fontSize, "Use a size from the type scale in the tokens file");
    }
    const parts = (n.style["borderRadius"] ?? "").split(/[\s/]+/).filter(Boolean)
      .map(p => dimension(p) ?? p.toLowerCase());
    if (allowed.radii.size > 0 && parts.some(p => p !== "0px")) {
      examine(n, "borderRadius", parts.every(p => p === "0px" || allowed.radii.has(p)),
        n.style["borderRadius"] ?? "", "Use a radius from the tokens file");
    }
  }
  return { issues, total };
}

/**
 * Re-measure a screen without any LLM. The critique's `score` reflects token conformance only;
 * contrast, tap-target and inset failures are listed as issues (for the gate and the
 * accessibility critic) but never lower it, so one defect is not penalised twice.
 */
export function deterministicCritique(
  doc: MeasuredDoc,
  tokens: Record<string, unknown>,
): { critique: Critique; measurementsPass: boolean } {
  const token = tokenIssues(doc.nodes, tokens);
  // Ids are content-derived (check + selector), so they survive edits to other elements;
  // Task 4 tracks issues across rounds by id. Order matters to callers: contrast, tap, token, inset.
  const issues: Issue[] = [
    ...contrastIssues(doc.nodes),
    ...tapIssues(doc.nodes),
    ...token.issues,
    ...insetIssues(doc.nodes),
  ];
  const score = token.total === 0 ? 100 : (100 * (token.total - token.issues.length)) / token.total;
  return {
    critique: { critic: "tokenConformance", score, issues, resolved: { claimed: [], verified: [] } },
    measurementsPass: issues.length === 0,
  };
}
