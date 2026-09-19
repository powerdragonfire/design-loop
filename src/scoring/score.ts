import type { Config, Critique, Issue } from "../types.js";

// Weighted mean over the critiques present. A critic dropped upstream is simply absent;
// the caller renormalises the weights to the survivors first, so a partial committee is
// an explicit, checked choice rather than a silent under-weighting. Used only to rank
// versions within a run -- never compared to an absolute constant.
export function composite(critiques: Critique[], weights: Config["weights"]): number {
  const total = critiques.reduce((sum, c) => sum + weights[c.critic], 0);
  // Written so NaN (a missing or NaN weight) fails the check rather than slipping past it.
  if (!(Math.abs(total - 1) <= 1e-9)) {
    throw new Error(`weights for present critics must sum to 1 (got ${total})`);
  }
  const result = critiques.reduce((sum, c) => sum + weights[c.critic] * c.score, 0);
  if (!Number.isFinite(result)) {
    throw new Error("composite is not finite: a critic score is NaN or infinite");
  }
  return result;
}

// Issues still open: this round's issues plus prior open issues (`carried`), de-duplicated
// by id with this round's version winning, minus anything a critic has *verified* resolved.
// Carrying forward is what makes "only verified closes an issue" true: without it a critic
// could close an issue by simply no longer mentioning it. `resolved.claimed` closes nothing.
export function openIssues(critiques: Critique[], carried: Issue[] = []): Issue[] {
  const verified = new Set(critiques.flatMap((c) => c.resolved.verified));
  const byId = new Map<string, Issue>();
  for (const i of carried) byId.set(i.id, i);
  for (const c of critiques) for (const i of c.issues) byId.set(i.id, i);
  return [...byId.values()].filter((i) => !verified.has(i.id));
}

// The gate is a count, not a number: zero open blockers, zero open majors, and every
// deterministic measurement passing. The composite score plays no part.
export function gate(
  critiques: Critique[],
  measurementsPass: boolean,
  carried: Issue[] = [],
): { pass: boolean; reasons: string[] } {
  const open = openIssues(critiques, carried);
  const reasons: string[] = [];
  for (const severity of ["blocker", "major"] as const) {
    const ids = open.filter((i) => i.severity === severity).map((i) => i.id);
    if (ids.length > 0) {
      reasons.push(`${ids.length} open ${severity}${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`);
    }
  }
  if (!measurementsPass) reasons.push("one or more deterministic measurements failed");
  return { pass: reasons.length === 0, reasons };
}
