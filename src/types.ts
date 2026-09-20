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
