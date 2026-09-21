import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRun } from "../../src/store/store.js";
import { buildReport, captureApproval } from "../../src/report/report.js";
import type { Issue } from "../../src/types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dl-")); });

const issue = (id: string, claim = `claim ${id}`): Issue =>
  ({ id, severity: "major", evidence: { selector: "#b1", observed: "o" }, claim, fix: "f", effort: "low" });
const crit = (score: number, verified: string[] = []) =>
  ({ critic: "typography" as const, score, issues: [], resolved: { claimed: verified, verified } });
type Over = { open?: Issue[]; verified?: string[]; prompt?: string; parent?: string | null; gatePass?: boolean };
const v = (index: number, composite: number, o: Over = {}) => ({
  index, png: Buffer.from("png"), html: "<p>h</p>",
  doc: { viewport: { w: 393, h: 852 }, nodes: [] },
  critiques: [crit(composite, o.verified ?? [])], composite, gatePass: o.gatePass ?? false,
  prompt: o.prompt ?? `PROMPT-${index}`, openIssues: o.open ?? [], parent: o.parent ?? null,
});
const spend = { stitchGenerations: 2, inputTokens: 1, outputTokens: 1, cachedTokens: 0, usd: 0.3 };
const fin = (over: Record<string, unknown> = {}) => ({
  stopReason: "converged" as const, committeeRank: ["v01", "v00"], spend,
  hallucinationRate: { typography: 0.1 }, degradations: [], sigma: 3, ...over,
});
const seed = async (o: { v0?: Over; v1?: Over; fin?: Record<string, unknown> } = {}) => {
  const run = await openRun(dir, "home", "2026-09-18");
  await run.writeVersion(v(0, 70, o.v0)); await run.writeVersion(v(1, 85, o.v1));
  await run.finalise(fin(o.fin));
  return run;
};
const page = async (run: { dir: string }) => readFileSync(await buildReport(run.dir), "utf8");
const section = (h: string, ver: string) => h.split(`data-version="${ver}"`)[1]?.split("<section")[0] ?? "";

type CandRow = { id: string; family: number; composite: number; blockers?: number; gatePass?: boolean };
const candidateInput = (r: CandRow) => ({
  id: r.id, family: r.family, png: Buffer.from(`png-${r.id}`), html: "<p>c</p>",
  doc: { viewport: { w: 393, h: 852 }, nodes: [] },
  critiques: [crit(r.composite)], composite: r.composite, gatePass: r.gatePass ?? true,
  openIssues: [], prompt: `PROMPT-${r.id}`,
});
const summary = (r: CandRow) => ({ id: r.id, family: r.family, composite: r.composite, blockers: r.blockers ?? 0, gatePass: r.gatePass ?? true });
/** Writes every candidate, records the selection, promotes the winner to v00, and finalises — the shape `run.ts` leaves behind. */
const seedWithCandidates = async (rows: CandRow[], winner: string, finOver: Record<string, unknown> = {}) => {
  const run = await openRun(dir, "home", "2026-09-18");
  for (const r of rows) await run.writeCandidate(candidateInput(r));
  const summaries = rows.map(summary);
  await run.writeSelection({ winner, rows: summaries });
  await run.promoteCandidate(winner);
  await run.finalise(fin({ committeeRank: ["v00"], candidates: summaries, selection: { winner, rows: summaries }, ...finOver }));
  return run;
};

describe("buildReport", () => {
  it("shows every version, including the lower-scoring one", async () => {
    const h = await page(await seed());
    expect(h).toContain('data-version="v00"');
    expect(h).toContain('data-version="v01"');
  });

  it("shows the score delta between rounds", async () => {
    expect(await page(await seed())).toMatch(/\+15/);
  });

  it("shows the stop reason, the spend and the noise floor it was judged against", async () => {
    const h = await page(await seed());
    expect(h).toContain("converged");
    expect(h).toContain("$0.30");
    expect(h).toMatch(/σ\s*=?\s*3|sigma\s*=?\s*3/i);
  });

  it("embeds screenshots and references nothing external, so it opens from disk", async () => {
    const h = await page(await seed());
    expect(h).toContain("data:image/png;base64,");
    expect(h).not.toMatch(/(src|href)="https?:/);
  });

  it("escapes untrusted text: issue claims come from a model and Stitch", async () => {
    const h = await page(await seed({ v1: { open: [issue("typography-001", "<script>alert(1)</script>")] } }));
    expect(h).not.toContain("<script>alert(1)");
    expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows the prompt that produced each version", async () => {
    const h = await page(await seed());
    expect(section(h, "v00")).toContain("PROMPT-0");
    expect(section(h, "v01")).toContain("PROMPT-1");
  });

  it("shows which issues an edit targeted, and says so when the chair asked for more than it got", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70));
    await run.writeVersion({ ...v(1, 85), parent: "v00", changes: { requested: 5, applied: [issue("typography-001", "shrink the hero")] } });
    await run.finalise(fin());
    const h = await page(run);
    expect(section(h, "v01")).toMatch(/This edit targeted/i);
    expect(section(h, "v01")).toContain("typography-001");
    expect(section(h, "v01")).toContain("shrink the hero");
    expect(section(h, "v01")).toContain("The chair asked for 5 changes");
    expect(section(h, "v00")).not.toMatch(/This edit targeted/i);
  });

  it("escapes an untrusted claim in the targeted-changes list too", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70));
    await run.writeVersion({ ...v(1, 85), parent: "v00", changes: { requested: 1, applied: [issue("typography-001", "<img src=x onerror=alert(1)>")] } });
    await run.finalise(fin());
    const h = await page(run);
    expect(h).not.toContain("<img src=x");
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders the complete versions and names an incomplete directory it skipped", async () => {
    const run = await seed();
    mkdirSync(join(run.dir, "v02"));
    writeFileSync(join(run.dir, "v02", "screen.png"), "png");
    const h = await page(run);
    expect(h).toContain('data-version="v00"');
    expect(h).toContain('data-version="v01"');
    expect(h).not.toContain('data-version="v02"');
    expect(h).toMatch(/incomplete version/i);
    expect(h).toContain(join(run.dir, "v02"));
  });

  it("warns when a critic was dropped, with its cause", async () => {
    const h = await page(await seed({ fin: { degradations: [{ version: "v01", critic: "feasibility", error: "HTTP 400 boom" }] } }));
    expect(h).toMatch(/dropped/i);
    expect(h).toContain("feasibility");
    expect(h).toContain("HTTP 400 boom");
  });

  it("marks the committee's pick, and the approved version once approved", async () => {
    const run = await seed();
    expect(section(await page(run), "v01")).toContain("Committee pick");
    expect(await page(run)).not.toContain("Approved by you");
    await captureApproval(run.dir, "v00");
    const h = await page(run);
    expect(section(h, "v00")).toContain("Approved by you");
    expect(section(h, "v01")).not.toContain("Approved by you");
  });

  it("tells the operator exactly which command approves a version", async () => {
    const run = await seed();
    expect(await page(run)).toContain(`design-loop approve ${run.dir} v01`);
  });

  it("labels the issue lifecycle against the previous version", async () => {
    const h = await page(await seed({
      v0: { open: [issue("typography-001"), issue("typography-002")] },
      v1: { open: [issue("typography-002"), issue("typography-003")], verified: ["typography-001"] },
    }));
    const s = section(h, "v01");
    expect(s).toMatch(/typography-001[\s\S]*?resolved \(verified\)/);
    expect(s).toMatch(/typography-002[\s\S]*?persisted/);
    expect(s).toMatch(/typography-003[\s\S]*?new/);
  });

  it("flags an issue that vanished without being verified", async () => {
    const h = await page(await seed({ v0: { open: [issue("typography-001")] }, v1: { open: [] } }));
    expect(section(h, "v01")).toContain("gone without verification");
  });

  it("measures the lifecycle against the PARENT after a regression, not the previous round", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 80, { open: [issue("typography-001")] }));
    await run.writeVersion(v(1, 40, { open: [issue("typography-001"), issue("typography-009")], parent: "v00" }));
    await run.writeVersion(v(2, 82, { open: [issue("typography-001")], parent: "v00" }));
    await run.finalise(fin({ committeeRank: ["v02", "v00", "v01"] }));
    const s = section(await page(run), "v02");
    expect(s).toContain("built from v00");
    expect(s).toMatch(/typography-001[\s\S]*?persisted/);
    expect(s).not.toContain("typography-009");
  });

  it("shows why an aborted run stopped", async () => {
    const h = await page(await seed({ fin: { stopReason: "aborted", abortReason: "Stitch quota exhausted" } }));
    expect(h).toContain("aborted");
    expect(h).toContain("Stitch quota exhausted");
  });

  it("builds for a run that was never finalised, and says so", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v(0, 70));
    expect(await page(run)).toMatch(/not finalised/i);
  });
});

describe("candidate gallery", () => {
  it("renders a candidate gallery above the versions and marks the winner", async () => {
    const rows: CandRow[] = [
      { id: "c0", family: 0, composite: 70 }, { id: "c1", family: 0, composite: 72 },
      { id: "c2", family: 1, composite: 68 }, { id: "c3", family: 1, composite: 90 },
      { id: "c4", family: 1, composite: 65 }, { id: "c5", family: 0, composite: 60 },
    ];
    const h = await page(await seedWithCandidates(rows, "c3"));
    expect(h).toContain("6 candidates");
    expect(h.indexOf('<div class="versions">')).toBeGreaterThan(h.indexOf('data-gallery="candidates"'));
    expect(h).toMatch(/c3[\s\S]{0,200}winner/i);
  });

  it("says why the winner won when it was not the highest composite", async () => {
    // sigma 3 (fin()'s default): leader c0 at 90, c1 at 89 is within it and ties; c1 has fewer blockers.
    const rows: CandRow[] = [{ id: "c0", family: 0, composite: 90, blockers: 2 }, { id: "c1", family: 0, composite: 89, blockers: 0 }];
    const h = await page(await seedWithCandidates(rows, "c1"));
    expect(h).toMatch(/within .* of the leader/i);
  });

  it("omits the gallery entirely for a run that had no candidate stage", async () => {
    const h = await page(await seed());
    expect(h).not.toContain('data-gallery="candidates"');
  });

  it("prints the approve command for every candidate cell, and marks the one approved by a human", async () => {
    const rows: CandRow[] = [{ id: "c0", family: 0, composite: 70 }, { id: "c1", family: 0, composite: 90 }];
    const run = await seedWithCandidates(rows, "c1");
    await captureApproval(run.dir, "c0");
    const h = await page(run);
    const cell = (id: string) => h.split(`data-candidate="${id}"`)[1]?.split('<div class="candidate')[0] ?? "";
    expect(cell("c0")).toContain(`design-loop approve ${run.dir} c0`);
    expect(cell("c1")).toContain(`design-loop approve ${run.dir} c1`);
    expect(cell("c0")).toContain("Approved by you");
    expect(cell("c1")).not.toContain("Approved by you");
  });

  it("shows a critic dropped from the winning candidate on v00's card, keyed by the candidate id", async () => {
    // run.ts records a candidate-stage degradation under the candidate id (e.g. "c1"), never "v00" —
    // v00's card must still surface it (spec fix 6a).
    const rows: CandRow[] = [{ id: "c0", family: 0, composite: 70 }, { id: "c1", family: 0, composite: 90 }];
    const run = await seedWithCandidates(rows, "c1", {
      degradations: [{ version: "c1", critic: "feasibility", error: "HTTP 400 boom" }],
    });
    const s = section(await page(run), "v00");
    expect(s).toMatch(/critic dropped/i);
    expect(s).toContain("feasibility");
  });
});

describe("captureApproval", () => {
  it("approves a run in a LATER process, from its directory alone", async () => {
    const run = await seed();
    await captureApproval(run.dir, "v01");
    const m = JSON.parse(readFileSync(join(run.dir, "manifest.json"), "utf8"));
    expect(m.humanPick).toBe("v01");
    expect(m.agreedWithTop).toBe(true);
  });
});
