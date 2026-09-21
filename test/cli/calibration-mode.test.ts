import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCalibration } from "../../src/cli/calibration.js";
import type { Config } from "../../src/types.js";

const cfg = (over: Partial<Config> = {}): Config => ({
  sigma: 1.8, maxRounds: 5, convergenceSigmas: 1, convergenceRounds: 2,
  models: { critic: "claude-sonnet-5", chair: "claude-opus-5" },
  weights: { typography: 0.2, behavioural: 0.2, accessibility: 0.2, tokenConformance: 0.2, feasibility: 0.2 },
  batchMode: false, criticMode: "api",
  candidates: { families: 1, variantsPerFamily: 0, creativeRange: "EXPLORE", aspects: [] }, ...over,
});

const withCalibration = (body: object): string => {
  const dir = mkdtempSync(join(tmpdir(), "dl-cal-"));
  mkdirSync(join(dir, ".design-loop"));
  writeFileSync(join(dir, ".design-loop", "calibration.json"), JSON.stringify(body));
  return dir;
};

const base = {
  sigma: 1.8, criticModel: "claude-sonnet-5", measuredAt: "2026-09-01T00:00:00.000Z",
  weights: { typography: 0.2, behavioural: 0.2, accessibility: 0.2, tokenConformance: 0.2, feasibility: 0.2 },
};

describe("readCalibration criticMode", () => {
  it("treats a calibration with no criticMode as api", async () => {
    const dir = withCalibration(base);
    const lines: string[] = [];
    const out = await readCalibration(dir, cfg(), 1.8, (l) => lines.push(l));
    expect(out?.criticMode).toBe("api");
    expect(lines).toEqual([]);
  });

  it("warns loudly when the run mode differs from the calibrated mode", async () => {
    const dir = withCalibration(base);
    const lines: string[] = [];
    await readCalibration(dir, cfg({ criticMode: "agent" }), 1.8, (l) => lines.push(l));
    expect(lines.join("\n")).toMatch(/sigma was calibrated in api mode but this run uses agent/);
  });

  it("says nothing when the modes agree", async () => {
    const dir = withCalibration({ ...base, criticMode: "agent" });
    const lines: string[] = [];
    await readCalibration(dir, cfg({ criticMode: "agent" }), 1.8, (l) => lines.push(l));
    expect(lines).toEqual([]);
  });
});
