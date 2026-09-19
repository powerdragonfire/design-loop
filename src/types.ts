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
}

export interface Contract {
  tokens: Record<string, unknown>;
  brief: string;
  config: Config;
  screens: Record<string, string>;
}
