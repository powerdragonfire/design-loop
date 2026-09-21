import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { openExistingRun, writeAtomic, type CandidateSummary } from "../store/store.js";
import type { Critique, Issue } from "../types.js";

/** What the page needs of `manifest.json`; every field is optional because a run may not be finalised. */
interface ManifestView {
  screen?: string;
  date?: string;
  stopReason?: string;
  abortReason?: string;
  committeeRank?: string[];
  spend?: { stitchGenerations: number; inputTokens: number; outputTokens: number; cachedTokens: number; usd: number | null };
  hallucinationRate?: Record<string, number>;
  degradations?: { version: string; critic: string; error: string }[];
  sigma?: number;
  humanPick?: string;
  agreedWithTop?: boolean;
  /** Absent for a run finalised before the candidate stage existed; a report from one shows no gallery. */
  candidates?: CandidateSummary[];
  selection?: { winner: string; rows: CandidateSummary[] } | null;
}

/** `vNN/changes.json`: what the chair asked the edit that produced this version to change. */
interface ChangesView {
  requested: number;
  applied: { id: string; claim: string }[];
}

interface VersionView {
  name: string;
  composite: number;
  gatePass: boolean;
  png: string;
  prompt: string;
  parent: string | null;
  open: Issue[];
  critiques: Critique[];
  changes: ChangesView | null;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Issue claims, critic errors, prompts and abort reasons come from models and Stitch: every one goes through this. */
const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const signed = (n: number): string => (n > 0 ? `+${num(n)}` : n < 0 ? `-${num(-n)}` : "±0");

/** The command is meant to be pasted into a shell, so a path with spaces or metacharacters is quoted. */
const shellQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

const readJson = async <T>(file: string): Promise<T> => parseJson<T>(file, await readFile(file, "utf8"));

function parseJson<T>(file: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

async function readOptionalJson<T>(file: string): Promise<T | null> {
  const raw = await readOptional(file);
  return raw === null ? null : parseJson<T>(file, raw);
}

async function readVersion(runDir: string, name: string): Promise<VersionView> {
  const dir = join(runDir, name);
  const { composite, gatePass } = await readJson<{ composite: number; gatePass: boolean }>(join(dir, "composite.json"));
  const files = (await readdir(join(dir, "critiques"))).filter((f) => f.endsWith(".json")).sort();
  return {
    name,
    composite,
    gatePass,
    png: (await readFile(join(dir, "screen.png"))).toString("base64"),
    prompt: await readFile(join(dir, "prompt.txt"), "utf8"),
    parent: (await readOptional(join(dir, "parent.txt")))?.trim() || null,
    open: await readJson<Issue[]>(join(dir, "open-issues.json")),
    critiques: await Promise.all(files.map((f) => readJson<Critique>(join(dir, "critiques", f)))),
    changes: await readOptionalJson<ChangesView>(join(dir, "changes.json")),
  };
}

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#15181d;--muted:#5b6470;--line:#d9dde3;--code:#eef0f3;--accent:#1f5fd6;--good:#0c6b3a;--goodbg:#dff3e7;--bad:#a3271d;--badbg:#fbe4e1;--warn:#7a4b00;--warnbg:#fff0cc}
@media(prefers-color-scheme:dark){:root{--bg:#101318;--card:#181c23;--text:#e8ebef;--muted:#9aa4b1;--line:#2b313b;--code:#242a33;--accent:#7aa7ff;--good:#6fdc9c;--goodbg:#12301f;--bad:#ff9d92;--badbg:#3a1a17;--warn:#ffd27a;--warnbg:#3a2d0c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:1400px;margin:0 auto;padding:16px}
h1{font-size:1.5rem;margin:0 0 .5rem}h2{font-size:1.2rem;margin:0}h3{font-size:.95rem;margin:1rem 0 .25rem}
code,pre{font:.85rem/1.4 ui-monospace,monospace;background:var(--code);border-radius:4px}
code{padding:.05rem .3rem;overflow-wrap:anywhere}pre{padding:.6rem;white-space:pre-wrap;overflow-wrap:anywhere;margin:.5rem 0 0}
.panel{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin-bottom:16px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0}dt{color:var(--muted)}dd{margin:0}
.warn{background:var(--warnbg);color:var(--warn);border:1px solid var(--warn);border-radius:8px;padding:12px 16px;margin-bottom:16px}
.warn ul{margin:.25rem 0 0;padding-left:1.25rem}
.cmd{display:flex;gap:.5rem;align-items:center;margin:.4rem 0}.cmd code{flex:1;padding:.4rem .6rem}
.copy{display:none;font:inherit;font-size:.85rem;padding:.3rem .7rem;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--text);cursor:pointer}
.js .copy{display:inline-block}
.versions{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px;align-items:start}
.version{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;min-width:0}
.version.approved{border:2px solid var(--good)}
.candidate-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px;margin-top:.5rem}
.candidate{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-width:0}
.candidate.winner{border:2px solid var(--good)}
.candidate.approved{border:2px solid var(--accent)}
.head{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin-bottom:.5rem}
img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:6px}
.badge,.tag,.sev,.chip{display:inline-block;font-size:.75rem;font-weight:600;padding:.05rem .5rem;border-radius:999px;border:1px solid var(--line);white-space:nowrap}
.badge.pick{background:var(--accent);color:var(--bg);border-color:var(--accent)}.badge.pass,.badge.approved,.tag.resolved{background:var(--goodbg);color:var(--good);border-color:var(--good)}
.tag.new,.sev.blocker,.sev.major,.tag.gone{background:var(--badbg);color:var(--bad);border-color:var(--bad)}
.tag.persisted{background:var(--warnbg);color:var(--warn);border-color:var(--warn)}
.score{font-size:1.4rem;font-weight:700}.delta{color:var(--muted);margin-left:.4rem}
.chips{display:flex;flex-wrap:wrap;gap:.3rem;margin:.4rem 0}.chip{font-weight:400}
.gate.fail{color:var(--bad)}.gate.ok{color:var(--good)}
ul.issues{list-style:none;margin:0;padding:0}ul.issues li{border-top:1px solid var(--line);padding:.4rem 0;overflow-wrap:anywhere}
.muted{color:var(--muted)}summary{cursor:pointer}
`;

/** The one script: reveals the copy buttons and copies the command beside one. The page reads fine without it. */
const SCRIPT = `document.documentElement.classList.add("js");
document.addEventListener("click", function (e) {
  var b = e.target.closest && e.target.closest("button.copy");
  if (!b) return;
  var code = b.previousElementSibling;
  var done = function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1500); };
  if (navigator.clipboard) { navigator.clipboard.writeText(code.textContent).then(done); return; }
  var r = document.createRange(); r.selectNodeContents(code);
  var s = getSelection(); s.removeAllRanges(); s.addRange(r);
  if (document.execCommand("copy")) done();
});`;

/** No external resource, and only the inline script above may run, even if an untrusted string slipped through. */
const CSP = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${createHash("sha256").update(SCRIPT).digest("base64")}'`;

const command = (cmd: string): string =>
  `<div class="cmd"><code>${esc(cmd)}</code><button type="button" class="copy">Copy</button></div>`;

/** The gate's reasons are not stored, so they are read back from the open issues the gate was computed on. */
function gateReasons(open: Issue[]): string[] {
  const reasons: string[] = [];
  for (const severity of ["blocker", "major"] as const) {
    const ids = open.filter((i) => i.severity === severity).map((i) => i.id);
    if (ids.length > 0) reasons.push(`${ids.length} open ${severity}${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`);
  }
  return reasons.length > 0 ? reasons : ["one or more deterministic measurements failed"];
}

const sevClass = (s: string): string => (s === "blocker" || s === "major" || s === "minor" ? s : "other");

function issueItem(i: Issue, label: string, tag: string): string {
  return `<li><code>${esc(i.id)}</code> <span class="sev ${sevClass(i.severity)}">${esc(i.severity)}</span> `
    + `<span class="tag ${tag}">${esc(label)}</span><br>${esc(i.claim)}<br>`
    + `<span class="muted">element <code>${esc(i.evidence.selector)}</code></span></li>`;
}

/** Measured against the version this one was edited from: after a regression that is not the previous round. */
function lifecycle(v: VersionView, parent: VersionView | null): string {
  if (!parent) return v.open.map((i) => issueItem(i, "open", "persisted")).join("");
  const before = new Set(parent.open.map((i) => i.id));
  const now = new Set(v.open.map((i) => i.id));
  const verified = new Set(v.critiques.flatMap((c) => c.resolved.verified));
  const items = v.open.map((i) => (before.has(i.id) ? issueItem(i, "persisted", "persisted") : issueItem(i, "new", "new")));
  for (const i of parent.open.filter((p) => !now.has(p.id))) {
    if (verified.has(i.id)) items.push(issueItem(i, "resolved (verified)", "resolved"));
    else if (i.id.startsWith("det-")) items.push(issueItem(i, "resolved (re-measured)", "resolved"));
    else items.push(issueItem(i, "gone without verification", "gone"));
  }
  return items.join("");
}

/** What this version's edit was asked to change: the only record of what a round was trying to fix. */
function targeted(c: ChangesView | null): string {
  if (!c || c.applied.length === 0) return "";
  const items = c.applied.map((i) => `<li><code>${esc(i.id)}</code><br>${esc(i.claim)}</li>`).join("");
  const over = c.requested > c.applied.length
    ? `<p class="muted">The chair asked for ${esc(c.requested)} changes; the top ${esc(c.applied.length)} were kept.</p>`
    : "";
  return `<h3>This edit targeted</h3><ul class="issues">${items}</ul>${over}`;
}

function versionSection(v: VersionView, prev: VersionView | null, parent: VersionView | null, m: ManifestView | null, runDir: string): string {
  const approved = m?.humanPick === v.name;
  const badges = [
    m?.committeeRank?.[0] === v.name ? `<span class="badge pick">Committee pick</span>` : "",
    v.gatePass ? `<span class="badge pass">Passed the gate</span>` : "",
    approved ? `<span class="badge approved">Approved by you</span>` : "",
  ].join("");
  const delta = prev ? signed(v.composite - prev.composite) : "—";
  // v00 is a promoted candidate, not a scored round of its own: a critic dropped while it was still
  // c<N> is recorded under that candidate id, not "v00". Only v00 can have come from a candidate, so
  // only it needs the extra name.
  const dropNames = v.name === "v00" && m?.selection?.winner ? [v.name, m.selection.winner] : [v.name];
  const dropped = (m?.degradations ?? []).filter((d) => dropNames.includes(d.version));
  const gate = v.gatePass
    ? `<p class="gate ok">Gate: passed</p>`
    : `<p class="gate fail">Gate: not passed — ${esc(gateReasons(v.open).join("; "))}</p>`;
  const issues = lifecycle(v, parent);
  return `<section class="version${approved ? " approved" : ""}" data-version="${esc(v.name)}">
<div class="head"><h2>${esc(v.name)}</h2>${badges}</div>
<img src="data:image/png;base64,${v.png}" alt="Screenshot of ${esc(v.name)}">
<p><span class="score">${num(v.composite)}</span><span class="delta">${esc(delta)} vs previous version</span></p>
${gate}
<div class="chips">${v.critiques.map((c) => `<span class="chip">${esc(c.critic)} <b>${num(c.score)}</b></span>`).join("")}</div>
${dropped.length > 0 ? `<p class="gate fail">Critic dropped this round: ${dropped.map((d) => esc(d.critic)).join(", ")}</p>` : ""}
${v.parent ? `<p class="muted">built from ${esc(v.parent)}</p>` : ""}
${m?.committeeRank ? command(`design-loop approve ${shellQuote(runDir)} ${v.name}`) : ""}
<details><summary>Prompt that produced this version</summary><pre>${esc(v.prompt)}</pre></details>
${targeted(v.changes)}
<h3>Issues${parent ? ` <span class="muted">against ${esc(parent.name)}</span>` : ""}</h3>
${issues ? `<ul class="issues">${issues}</ul>` : `<p class="muted">None open.</p>`}
</section>`;
}

/** The candidate directory survives its own promotion (`promoteCandidate` copies, never moves), so every row's screenshot is still on disk. */
async function readCandidatePng(runDir: string, id: string): Promise<string | null> {
  try {
    return (await readFile(join(runDir, "candidates", id, "screen.png"))).toString("base64");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

function candidateCell(c: CandidateSummary, isWinner: boolean, isApproved: boolean, png: string | null, runDir: string): string {
  const gate = c.failed
    ? `<p class="gate fail">Committee unavailable: ${esc(c.failed)}</p>`
    : c.gatePass
      ? `<p class="gate ok">Gate: passed</p>`
      : `<p class="gate fail">Gate: not passed</p>`;
  const badges = [
    isWinner ? `<span class="badge pick">Winner</span>` : "",
    isApproved ? `<span class="badge approved">Approved by you</span>` : "",
  ].join("");
  return `<div class="candidate${isWinner ? " winner" : ""}${isApproved ? " approved" : ""}" data-candidate="${esc(c.id)}">
<div class="head"><h3>${esc(c.id)}</h3><span class="chip">family ${esc(c.family)}</span>${badges}</div>
${png ? `<img src="data:image/png;base64,${png}" alt="Screenshot of candidate ${esc(c.id)}">` : `<p class="muted">Screenshot unavailable</p>`}
<p><span class="score">${num(c.composite)}</span><span class="delta">${c.blockers} blocker${c.blockers === 1 ? "" : "s"}</span></p>
${gate}
${command(`design-loop approve ${shellQuote(runDir)} ${c.id}`)}
</div>`;
}

/**
 * One cell per candidate, above the version timeline, so a reader sees the whole fan-out the loop was
 * seeded from — not only the version it produced. Renders nothing for a run with no candidate stage
 * (an older manifest with no `candidates`), so those reports are byte-for-byte what they always were.
 */
async function candidateGallery(m: ManifestView, runDir: string): Promise<string> {
  const candidates = m.candidates ?? [];
  if (candidates.length === 0) return "";
  const winnerId = m.selection?.winner;
  const pngs = await Promise.all(candidates.map((c) => readCandidatePng(runDir, c.id)));
  const cells = candidates
    .map((c, i) => candidateCell(c, c.id === winnerId, m.humanPick === c.id, pngs[i]!, runDir))
    .join("\n");
  // The selection rule (candidates.ts's pickWinner) is: highest composite, except everything within one
  // sigma of the leader ties and the fewest blockers wins. When the winner IS the top composite this is
  // invisible and needs no explanation; only a genuine tie-break needs a sentence naming why.
  const scored = candidates.filter((c) => c.failed === undefined);
  const leader = scored.length > 0 ? Math.max(...scored.map((c) => c.composite)) : null;
  const winner = winnerId !== undefined ? candidates.find((c) => c.id === winnerId) : undefined;
  const leaderRow = leader !== null ? scored.find((c) => c.composite === leader) : undefined;
  const reason =
    winner && leaderRow && winner.id !== leaderRow.id && winner.composite < leader!
      ? `<p class="muted">${esc(winner.id)} was chosen over ${esc(leaderRow.id)}'s higher composite `
        + `(${num(leaderRow.composite)} vs ${num(winner.composite)}) because both are within one sigma`
        + `${m.sigma !== undefined ? ` (σ = ${esc(m.sigma)})` : ""} of the leader, and ${esc(winner.id)} `
        + `has fewer blockers (${winner.blockers} vs ${leaderRow.blockers}).</p>`
      : "";
  return `<section class="panel candidates" data-gallery="candidates">
<h2>${candidates.length} candidate${candidates.length === 1 ? "" : "s"}</h2>
${reason}
<div class="candidate-grid">
${cells}
</div>
</section>`;
}

function header(m: ManifestView | null, names: string[], runDir: string): string {
  const title = `<h1>${esc(m?.screen ?? basename(runDir))}${m?.date ? ` <span class="muted">${esc(m.date)}</span>` : ""}</h1>`;
  if (!m) {
    return `<header class="panel">${title}<p><strong>Not finalised.</strong> This run has no manifest.json, so it was interrupted or is still running. `
      + `Its versions are shown below, but it cannot be approved until it is finalised.</p></header>`;
  }
  const rank = m.committeeRank ?? [];
  const spend = m.spend;
  const rates = Object.entries(m.hallucinationRate ?? {});
  const dropped = m.degradations ?? [];
  const order = [...rank.filter((n) => names.includes(n)), ...names.filter((n) => !rank.includes(n))];
  const approval = m.humanPick
    ? `${esc(m.humanPick)} <span class="muted">(${m.agreedWithTop ? "agrees" : "differs from"} the committee's top pick)</span>`
    : "Not yet approved";
  return `<header class="panel">${title}
<dl>
<dt>Stop reason</dt><dd><strong>${esc(m.stopReason ?? "unknown")}</strong>${m.abortReason ? ` — ${esc(m.abortReason)}` : ""}</dd>
<dt>Noise floor</dt><dd>σ = ${esc(m.sigma ?? "unknown")}</dd>
${spend ? `<dt>Spend</dt><dd>${spend.usd == null ? "not metered (agent mode)" : `$${spend.usd.toFixed(2)}`} · ${spend.stitchGenerations} Stitch generations · ${spend.inputTokens} in / ${spend.outputTokens} out / ${spend.cachedTokens} cached tokens</dd>` : ""}
<dt>Committee pick</dt><dd>${esc(rank[0] ?? "none")}</dd>
<dt>Your approval</dt><dd>${approval}</dd>
${rates.length > 0 ? `<dt>Hallucinated evidence</dt><dd>${rates.map(([c, r]) => `${esc(c)} ${Math.round(r * 100)}%`).join(" · ")}</dd>` : ""}
</dl></header>
${dropped.length > 0 ? `<div class="warn" role="alert"><strong>Critic dropped.</strong> These versions were scored without the critic listed:<ul>${dropped.map((d) => `<li>${esc(d.version)}: <strong>${esc(d.critic)}</strong> — ${esc(d.error)}</li>`).join("")}</ul></div>` : ""}
<div class="panel"><h2>How to approve</h2>
<p class="muted">This page cannot approve for you. Run one command in a terminal; the committee's pick is first.</p>
${order.map((n) => `<div>${esc(n)}${command(`design-loop approve ${shellQuote(runDir)} ${n}`)}</div>`).join("")}</div>`;
}

/** Writes `<runDir>/report.html`, one self-contained page, and returns its path. Works for any run with a version. */
export async function buildReport(runDir: string): Promise<string> {
  const abs = resolve(runDir);
  await openExistingRun(abs); // the same refusals as approving: a missing directory, or one with no version
  const names = (await readdir(abs, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^v\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  // A vNN written only in part (a crash mid-writeVersion, or this run still going) must not cost the
  // operator the report of every other version; it is named instead.
  const skipped: string[] = [];
  const loaded = await Promise.all(names.map(async (n) => {
    try {
      return await readVersion(abs, n);
    } catch (err) {
      if (!isMissing(err)) throw err;
      skipped.push(join(abs, n));
      return null;
    }
  }));
  const versions = loaded.filter((v): v is VersionView => v !== null);
  const manifestFile = join(abs, "manifest.json");
  const manifestRaw = await readOptional(manifestFile);
  const manifest = manifestRaw === null ? null : parseJson<ManifestView>(manifestFile, manifestRaw);

  const incomplete = skipped.length === 0 ? "" : `<div class="warn" role="alert"><strong>Incomplete version skipped.</strong> `
    + `These directories hold no complete version and are not shown:<ul>${skipped.map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul></div>`;
  const gallery = manifest ? await candidateGallery(manifest, abs) : "";
  const sections = versions.map((v, i) => {
    const prev = versions[i - 1] ?? null;
    const parent = v.parent ? (versions.find((p) => p.name === v.parent) ?? null) : prev;
    return versionSection(v, prev, parent, manifest, abs);
  });
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>Design review: ${esc(manifest?.screen ?? basename(abs))}</title>
<style>${CSS}</style></head>
<body><main>
${header(manifest, versions.map((v) => v.name), abs)}
${incomplete}
${gallery}
<div class="versions">
${sections.join("\n")}
</div>
</main>
<script>${SCRIPT}</script>
</body></html>
`;
  const out = join(abs, "report.html");
  await writeAtomic(out, html);
  return out;
}

/** Approval happens in a later process than the run, so it reopens the run from its directory alone. */
export async function captureApproval(runDir: string, version: string): Promise<void> {
  await (await openExistingRun(runDir)).approve(version);
}
