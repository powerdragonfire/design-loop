import type { Critique, CriticName, Issue, MeasuredDoc, MeasuredNode } from "../types.js";

// Drops every issue whose cited selector is absent from the measured document, and
// records dropped/total per critic. A critic with no issues rates 0. Only critics
// present in the input get an entry: a critic dropped upstream must not read as a
// perfect 0.
export function validateEvidence(
  critiques: Critique[],
  doc: MeasuredDoc,
): { critiques: Critique[]; hallucinationRate: Partial<Record<CriticName, number>> } {
  const selectors = new Set(doc.nodes.map((n) => n.selector));
  const counts: Partial<Record<CriticName, { dropped: number; total: number }>> = {};

  const validated = critiques.map((c) => {
    const issues = c.issues.filter((i) => selectors.has(i.evidence.selector));
    const tally = (counts[c.critic] ??= { dropped: 0, total: 0 });
    tally.total += c.issues.length;
    tally.dropped += c.issues.length - issues.length;
    return { ...c, issues };
  });

  const hallucinationRate: Partial<Record<CriticName, number>> = {};
  for (const [critic, { dropped, total }] of Object.entries(counts) as [
    CriticName,
    { dropped: number; total: number },
  ][]) {
    hallucinationRate[critic] = total === 0 ? 0 : dropped / total;
  }
  return { critiques: validated, hallucinationRate };
}

const fingerprint = (n: MeasuredNode): string => JSON.stringify(n.style) + JSON.stringify(n.bbox);

function bySelector(doc: MeasuredDoc): Map<string, MeasuredNode> {
  return new Map(doc.nodes.map((n) => [n.selector, n]));
}

// A claimed resolution is never trusted on its own. It is verified only when a
// previous document exists, the id was raised in the previous round, and the cited
// element's style or geometry differs between rounds. An element present in only one
// document was added or removed, which counts as changed; one absent from both gives
// nothing to observe, so it does not. The critic's own `verified` list is discarded
// and recomputed, and `claimed` is left untouched.
export function promoteResolutions(
  critiques: Critique[],
  prev: MeasuredDoc | null,
  cur: MeasuredDoc,
  prevIssues: Issue[],
): Critique[] {
  if (prev === null) {
    return critiques.map((c) => ({ ...c, resolved: { claimed: [...c.resolved.claimed], verified: [] } }));
  }
  const prevNodes = bySelector(prev);
  const curNodes = bySelector(cur);
  const selectorOf = new Map(prevIssues.map((i) => [i.id, i.evidence.selector]));

  const changed = (selector: string): boolean => {
    const before = prevNodes.get(selector);
    const after = curNodes.get(selector);
    if (!before && !after) return false;
    if (!before || !after) return true;
    return fingerprint(before) !== fingerprint(after);
  };

  return critiques.map((c) => {
    const verified = [
      ...new Set(
        c.resolved.claimed.filter((id) => {
          const selector = selectorOf.get(id);
          return selector !== undefined && changed(selector);
        }),
      ),
    ];
    return { ...c, resolved: { claimed: [...c.resolved.claimed], verified } };
  });
}
