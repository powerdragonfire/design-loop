import { describe, it, expect } from "vitest";
import { buildReport } from "../../src/report/report.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runDir = (spend: object) => {
  const d = mkdtempSync(join(tmpdir(), "dl-spend-"));
  mkdirSync(join(d, "v00"));
  writeFileSync(join(d, "v00", "composite.json"), JSON.stringify({ composite: 70, gatePass: true }));
  writeFileSync(join(d, "v00", "screen.png"), Buffer.from("p"));
  writeFileSync(join(d, "v00", "open-issues.json"), "[]");
  writeFileSync(join(d, "v00", "prompt.txt"), "make it");
  mkdirSync(join(d, "v00", "critiques"));
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    screen: "home", date: "2026-09-20", stopReason: "pass", committeeRank: ["v00"], best: "v00",
    versions: [{ version: "v00", composite: 70, gatePass: true }],
    spend, hallucinationRate: {}, degradations: [], sigma: 1.8, calibration: null,
  }));
  return d;
};

describe("report spend", () => {
  it("says the spend was not metered in agent mode", async () => {
    const dir = runDir({ stitchGenerations: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: null, criticMode: "agent" });
    const html = readFileSync(await buildReport(dir), "utf8");
    expect(html).toMatch(/not metered \(agent mode\)/);
    expect(html).not.toMatch(/\$0\.00/);
  });

  it("still prints a dollar figure in api mode", async () => {
    const dir = runDir({ stitchGenerations: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, usd: 1.06, criticMode: "api" });
    expect(readFileSync(await buildReport(dir), "utf8")).toMatch(/\$1\.06/);
  });
});
