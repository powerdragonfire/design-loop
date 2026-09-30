export type Severity = "blocker" | "major" | "minor";
export type Effort = "low" | "medium" | "high";
export type CriticName =
  | "typography" | "behavioural" | "accessibility"
  | "tokenConformance" | "feasibility";

export interface Issue {
  id: string;
  severity: Severity;
  evidence: { selector: string; observed: string };
  claim: string;
  fix: string;
  effort: Effort;
}

export interface Critique {
  critic: CriticName;
  score: number;
  issues: Issue[];
  resolved: { claimed: string[]; verified: string[] };
}

export interface MeasuredNode {
  selector: string;
  tag: string;
  role: string | null;
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
  style: Record<string, string>;
  /** Ancestor elements between this node and <body>; direct children of body are 0. */
  depth?: number;
  /**
   * The selector of the nearest measured ancestor, so a check can compare siblings (tiles in one grid).
   * Only the Figma serialiser sets it today; checks that need it skip a doc without it.
   */
  parent?: string;
  /**
   * The accessible name a screen reader would announce, when it is not the node's own text: an icon-only
   * control's name, an image's alt text. Absent when the node has none.
   */
  label?: string;
  /** A control currently in its selected / on / checked state, read from its variant. */
  selected?: boolean;
  /**
   * The node stays put while the page scrolls (it or an ancestor is fixed or sticky). Both measuring paths set it
   * on every node; a doc stored before it existed has it nowhere, and the inset check then behaves as it used to.
   */
  pinned?: boolean;
}

export interface MeasuredDoc {
  viewport: { w: number; h: number };
  nodes: MeasuredNode[];
}

// Owned here, not in stitch/sdk.ts: types.ts is the domain-types foundation most of the
// codebase imports, while stitch/ is a vendor-adapter leaf — a foundation must not depend
// on a leaf. sdk.ts imports these back and re-exports them for its existing consumers.
export type CreativeRange = "REFINE" | "EXPLORE" | "REIMAGINE";
export type VariantAspect = "LAYOUT" | "COLOR_SCHEME" | "IMAGES" | "TEXT_FONT" | "TEXT_CONTENT";

export interface Config {
  sigma: number | null;
  maxRounds: number;
  convergenceSigmas: number;
  convergenceRounds: number;
  models: { critic: string; chair: string };
  weights: Record<CriticName, number>;
  batchMode: boolean;
  // First-round variant generation. A design folder that never opts in loads with
  // families: 1, variantsPerFamily: 0 — today's single-generation behavior, unchanged.
  candidates: {
    families: number;
    variantsPerFamily: number;
    creativeRange: CreativeRange;
    aspects: VariantAspect[];
  };
  /** Where critiques come from: the Anthropic API, or files written by Claude Code subagents. */
  criticMode: "api" | "agent";
  /**
   * Where screens come from. Optional on the type so a hand-built Config (tests, older callers) still reads as
   * Stitch; `loadContract` always fills it in.
   */
  generator?: "stitch" | "figma";
  /** The Figma file a Figma run reads frames from, and the page new frames go on. The token is FIGMA_TOKEN. */
  figma?: { fileKey: string; pageId?: string };
}

export interface Contract {
  tokens: Record<string, unknown>;
  brief: string;
  config: Config;
  screens: Record<string, string>;
}

/** Token spend accumulated by an LLM client; the manifest records it (spec §11). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}
