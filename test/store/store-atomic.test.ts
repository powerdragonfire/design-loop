import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fails the Nth rename (1-based) once; every other rename is the real one.
const failing = vi.hoisted(() => ({ on: 0, calls: 0 }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    rename: (a: string, b: string) => {
      failing.calls += 1;
      if (failing.calls === failing.on) return Promise.reject(new Error("EXDEV"));
      return real.rename(a, b);
    },
  };
});

import { openRun } from "../../src/store/store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dl-"));
  failing.on = 0;
  failing.calls = 0;
});

const v = {
  index: 0, png: Buffer.from("png"), html: "<p>h</p>",
  doc: { viewport: { w: 393, h: 852 }, nodes: [] },
  critiques: [], composite: 70, gatePass: false, prompt: "P0", openIssues: [],
};
const fin = {
  stopReason: "converged" as const, committeeRank: ["v00"],
  spend: { stitchGenerations: 3, inputTokens: 1, outputTokens: 1, cachedTokens: 0, usd: 0.58 },
  hallucinationRate: {}, degradations: [], sigma: 3,
};
const leftovers = (d: string): string[] => readdirSync(d).filter((f) => f.endsWith(".tmp"));

describe("store atomic writes", () => {
  it("leaves no manifest and no temp file when the finalise rename fails", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v);
    failing.on = failing.calls + 1;
    await expect(run.finalise(fin)).rejects.toThrow(/EXDEV/);
    expect(readdirSync(run.dir)).toEqual(["v00"]);
    // The failed finalise did not count: the run can still be finalised.
    await run.finalise(fin);
    expect(readdirSync(run.dir).sort()).toEqual(["manifest.json", "v00"]);
  });

  it("keeps the previous manifest and removes the temp file when the approval's manifest rename fails", async () => {
    const run = await openRun(dir, "home", "2026-09-18");
    await run.writeVersion(v);
    await run.finalise(fin);
    // approve renames approved.json first, then the manifest.
    failing.on = failing.calls + 2;
    await expect(run.approve("v00")).rejects.toThrow(/EXDEV/);
    expect(JSON.parse(readFileSync(join(run.dir, "manifest.json"), "utf8")).humanPick).toBeUndefined();
    expect(leftovers(run.dir)).toEqual([]);
    expect(leftovers(join(run.dir, "v00"))).toEqual([]);
  });
});
