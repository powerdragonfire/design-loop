// Builds docs/example-report.html: a real `buildReport` page over a made-up run, so the README can show
// what a report looks like without shipping anyone's design. Run: pnpm tsx scripts/example-report.ts
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { openRun } from "../src/store/store.js";
import { buildReport } from "../src/report/report.js";
import type { Critique, CriticName, Issue } from "../src/types.js";

type Rgb = [number, number, number];
type Rect = { x: number; y: number; w: number; h: number; c: Rgb };

/** A 197x426 PNG (half of a 393x852 phone) drawn from filled rectangles; enough to tell the versions apart. */
function png(rects: Rect[]): Buffer {
  const W = 197, H = 426;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      let c: Rgb = [250, 247, 242];
      for (const r of rects) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) c = r.c;
      raw.set(c, y * (W * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const ink: Rgb = [38, 32, 28], sand: Rgb = [232, 224, 212], saffron: Rgb = [232, 150, 36], pale: Rgb = [214, 206, 196];
const bar = (x: number, y: number, w: number, c: Rgb = ink, h = 6): Rect => ({ x, y, w, h, c });
const card = (y: number, h = 70): Rect[] => [{ x: 12, y, w: 173, h, c: sand }, bar(22, y + 12, 100), bar(22, y + 28, 140, pale, 5), bar(22, y + 40, 120, pale, 5)];

const frame = (button: Rect, extra: Rect[] = []): Buffer =>
  png([bar(12, 28, 90, ink, 10), bar(12, 46, 150, pale, 5), ...card(70), ...card(150), ...card(230), ...extra, button]);

const issue = (id: string, severity: Issue["severity"], selector: string, observed: string, claim: string, fix: string, effort: Issue["effort"] = "low"): Issue =>
  ({ id, severity, evidence: { selector, observed }, claim, fix, effort });

const tap = issue("accessibility-001", "blocker", "button.respond", "height 36px", "The Respond button is 36px tall, under the 44px touch minimum.", "Raise the button to 48px tall.");
const contrast = issue("accessibility-002", "major", "p.meta", "color #9a9188 on #e8e0d4, 2.4:1", "Card meta text has a 2.4:1 contrast ratio, under the 4.5:1 minimum.", "Use the ink-muted token (#5c554e) for meta text.");
const fold = issue("behavioural-001", "major", "button.respond", "y = 790px of 852px", "The primary action sits below the fold on a 393x852 screen.", "Tighten card spacing so Respond ends above y = 753px.", "medium");
const type = issue("typography-001", "minor", "h2.title", "font-size 19px", "Card titles use 19px, off the type scale (18px or 20px).", "Set card titles to the 18px title-md token.");
const token = issue("tokenConformance-001", "minor", "div.card", "radius 10px", "Card radius is 10px, the radius-md token is 12px.", "Bind card radius to radius-md.");

const crit = (critic: CriticName, score: number, issues: Issue[] = [], verified: string[] = []): Critique =>
  ({ critic, score, issues, resolved: { claimed: verified, verified } });
const doc = { viewport: { w: 393, h: 852 }, nodes: [] };

const designDir = mkdtempSync(join(tmpdir(), "dl-example-"));
const run = await openRun(designDir, "trip-overview", "2026-10-03");

const v0Open = [tap, contrast, fold, type, token];
const v1Open = [contrast, type];
const cand = (id: string, family: number, composite: number, button: Rect, open: Issue[], gatePass: boolean) => ({
  id, family, png: frame(button), html: "<p>sample</p>", doc, composite, gatePass, openIssues: open,
  prompt: `First generation, art direction ${family + 1}`,
  critiques: [crit("typography", composite + 2), crit("behavioural", composite - 4), crit("accessibility", composite - 8), crit("tokenConformance", composite + 5), crit("feasibility", composite + 6)],
});
const c0 = cand("c0", 0, 61.2, bar(12, 330, 173, saffron, 16), v0Open, false);
const c1 = cand("c1", 1, 54.8, bar(12, 360, 173, saffron, 16), [...v0Open, issue("behavioural-002", "blocker", "div.hero", "height 310px", "The hero takes 310px, pushing the plan list off screen.", "Cap the hero at 160px.", "medium")], false);
await run.writeCandidate(c0);
await run.writeCandidate(c1);
const rows = [c0, c1].map((c) => ({ id: c.id, family: c.family, composite: c.composite, blockers: c.openIssues.filter((i) => i.severity === "blocker").length, gatePass: c.gatePass }));
await run.writeSelection({ winner: "c0", rows });
await run.promoteCandidate("c0");

await run.writeVersion({
  index: 1, png: frame(bar(12, 318, 173, saffron, 24)), html: "<p>sample</p>", doc, composite: 74.6, gatePass: false, parent: "v00",
  prompt: "Raise the Respond button to 48px. Switch card meta text to ink-muted. Move Respond above y = 753px.",
  changes: { requested: 4, applied: [tap, contrast, fold] },
  critiques: [crit("typography", 76, [type]), crit("behavioural", 78), crit("accessibility", 70, [contrast], ["accessibility-001"]), crit("tokenConformance", 80, [], ["tokenConformance-001"]), crit("feasibility", 82)],
  openIssues: v1Open,
});
await run.writeVersion({
  index: 2, png: frame(bar(12, 318, 173, saffron, 24), [bar(12, 300, 173, pale, 1)]), html: "<p>sample</p>", doc, composite: 88.1, gatePass: true, parent: "v01",
  prompt: "Switch card meta text to ink-muted. Set card titles to the 18px title-md token.",
  changes: { requested: 2, applied: v1Open },
  critiques: [crit("typography", 90, [], ["typography-001"]), crit("behavioural", 86), crit("accessibility", 87, [], ["accessibility-002"]), crit("tokenConformance", 90), crit("feasibility", 88)],
  openIssues: [],
});
await run.finalise({
  stopReason: "pass", committeeRank: ["v02", "v01", "v00"], sigma: 3.1,
  spend: { stitchGenerations: 4, inputTokens: 182000, outputTokens: 21000, cachedTokens: 96000, usd: 1.42, criticMode: "api" },
  hallucinationRate: { typography: 0.05, behavioural: 0, accessibility: 0.1 }, degradations: [],
  candidates: rows, selection: { winner: "c0", rows },
});

const html = readFileSync(await buildReport(run.dir), "utf8")
  .replaceAll(run.dir, "design/runs/2026-10-03-trip-overview")
  .replace("<main>", `<main>\n<div class="warn" role="note"><strong>Sample report.</strong> Made-up data from <code>scripts/example-report.ts</code>, not a real run. The screenshots are wireframes.</div>`);
const out = join(import.meta.dirname, "..", "docs", "example-report.html");
writeFileSync(out, html);
console.log(out, `${Math.round(html.length / 1024)} KB`);
