// Re-exported from the Stitch SDK layer (not restated here) so the variant vocabulary
// stays single-sourced; stitch/ has no dependency back on this file, so this is not a cycle.
import type { CreativeRange, VariantAspect } from "./stitch/sdk.js";

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
