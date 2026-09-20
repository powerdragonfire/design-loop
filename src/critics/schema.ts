import type { CriticName, Critique, Issue } from "../types.js";

export const SEVERITIES = ["blocker", "major", "minor"] as const;
export const EFFORTS = ["low", "medium", "high"] as const;
export const CRITIC_NAMES = ["typography", "behavioural", "accessibility", "tokenConformance", "feasibility"] as const;

// Pins the Critique shape. Only keywords structured outputs accept: any string or numeric constraint
// (minLength, minimum, ...) is a 400 that would drop all four critics. Non-empty id/selector and the
// score range are enforced by parseCritique; the enums matter because Task 5's gate treats an unknown
// severity or an empty id as "not open", so without them it could pass with a live issue.
const ISSUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "severity", "evidence", "claim", "fix", "effort"],
  properties: {
    id: { type: "string" },
    severity: { type: "string", enum: [...SEVERITIES] },
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["selector", "observed"],
      properties: { selector: { type: "string" }, observed: { type: "string" } },
    },
    claim: { type: "string" },
    fix: { type: "string" },
    effort: { type: "string", enum: [...EFFORTS] },
  },
} as const;

export const CRITIQUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["critic", "score", "issues", "resolved"],
  properties: {
    critic: { type: "string", enum: [...CRITIC_NAMES] },
    score: { type: "number" },
    issues: { type: "array", items: ISSUE_SCHEMA },
    resolved: {
      type: "object",
      additionalProperties: false,
      required: ["claimed", "verified"],
      properties: {
        claimed: { type: "array", items: { type: "string" } },
        verified: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

/** Structured outputs may not enforce every constraint the schema states, so the shape is checked here too. */
function invalid(critic: CriticName, why: string): never {
  throw new Error(`${critic} returned an invalid critique: ${why}`);
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function parseCritique(critic: CriticName, raw: unknown): Critique {
  if (!isObj(raw)) return invalid(critic, "not an object");
  if (typeof raw.score !== "number" || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > 100) {
    return invalid(critic, "score is not a number in 0..100");
  }
  if (!Array.isArray(raw.issues)) return invalid(critic, "issues is not an array");
  const prefix = `${critic}-`;
  const prefixed = (id: string) => (id.startsWith(prefix) ? id : prefix + id);
  // Every id in the reply, so a renumbered duplicate cannot collide with a later issue.
  const taken = new Set<string>(raw.issues.map((i: any) => (isNonEmpty(i?.id) ? prefixed(i.id) : "")));
  const seen = new Set<string>();
  // The first occurrence keeps its id; later ones get -2, -3, ..., skipping ids used elsewhere in the reply.
  const unique = (id: string): string => {
    let out = id;
    for (let n = 2; seen.has(out) || (out !== id && taken.has(out)); n++) out = `${id}-${n}`;
    seen.add(out);
    return out;
  };
  const issues = raw.issues.map((i: unknown, n: number): Issue => {
    if (!isObj(i)) return invalid(critic, `issue ${n} is not an object`);
    if (!isNonEmpty(i.id)) return invalid(critic, `issue ${n} has no id`);
    if (!SEVERITIES.includes(i.severity)) return invalid(critic, `issue ${n} has unknown severity`);
    if (!EFFORTS.includes(i.effort)) return invalid(critic, `issue ${n} has unknown effort`);
    if (!isObj(i.evidence) || !isNonEmpty(i.evidence.selector)) return invalid(critic, `issue ${n} cites no selector`);
    return {
      // Prefixing keeps ids collision-free across critics and keeps `det-` reserved for the deterministic pass.
      id: unique(prefixed(i.id)),
      severity: i.severity,
      evidence: { selector: i.evidence.selector, observed: String(i.evidence.observed ?? "") },
      claim: String(i.claim ?? ""),
      fix: String(i.fix ?? ""),
      effort: i.effort,
    };
  });
  if (!isObj(raw.resolved) || !Array.isArray(raw.resolved.claimed)) return invalid(critic, "resolved.claimed is missing");
  return {
    critic,
    score: raw.score,
    issues,
    // A model never verifies itself: verification is mechanical (Task 4).
    resolved: { claimed: raw.resolved.claimed.map(String), verified: [] },
  };
}

/** Next free number for this critic's NEW issues: max numeric suffix among its open ids, plus one. */
export function nextIssueId(critic: CriticName, open: Issue[]): string {
  const re = new RegExp(`^${critic}-(\\d+)`);
  const max = open.reduce((m, i) => Math.max(m, Number(re.exec(i.id)?.[1] ?? 0)), 0);
  return `${critic}-${String(max + 1).padStart(3, "0")}`;
}
