import type { MeasuredDoc, MeasuredNode } from "../types.js";

// CSS initial values: a prop holding one of these tells a critic nothing.
const DEFAULT_VALUES = new Set(["rgba(0, 0, 0, 0)", "normal", "none", "static", "auto", "0px", "1"]);

// Raw floats like 30.000001 waste tokens; one decimal is finer than any critic needs.
const round1 = (n: number): string => String(Math.round(n * 10) / 10);

function line(n: MeasuredNode): string {
  const { x, y, w, h } = n.bbox;
  const styleKV = Object.entries(n.style)
    .filter(([, v]) => !DEFAULT_VALUES.has(v))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  // The selector is emitted verbatim: critics cite it and the evidence validator
  // resolves it against doc.nodes[].selector. JSON.stringify keeps the text on one line.
  return [
    n.selector,
    `<${n.tag}${n.role ? ` role=${n.role}` : ""}>`,
    `[${round1(x)},${round1(y)} ${round1(w)}x${round1(h)}]`,
    styleKV,
    n.text ? JSON.stringify(n.text) : "",
  ].filter(Boolean).join(" ");
}

export function distill(doc: MeasuredDoc): string {
  return [`viewport: ${doc.viewport.w}x${doc.viewport.h}`, ...doc.nodes.map(line)].join("\n");
}

// Approximation for the calibration A/B and logging only; never used for billing.
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
