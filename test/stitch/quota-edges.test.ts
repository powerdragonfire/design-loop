import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQuota, reserve, MONTHLY_LIMIT } from "../../src/stitch/quota.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dl-")); });

describe("quota edges", () => {
  it("names the reset date, the first day of next month, when exhausted", async () => {
    await reserve(dir, MONTHLY_LIMIT);
    const now = new Date();
    const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    await expect(reserve(dir, 1)).rejects.toThrow(new RegExp(`${MONTHLY_LIMIT} of ${MONTHLY_LIMIT} used.*resets ${reset}`));
  });

  it("loses no update when reservations race", async () => {
    await Promise.all(Array.from({ length: 20 }, () => reserve(dir, 1)));
    expect((await readQuota(dir)).used).toBe(20);
  });

  it("leaves no temp file behind", async () => {
    await reserve(dir, 1);
    expect(readdirSync(join(dir, ".design-loop"))).toEqual(["quota.json"]);
  });

  it("refuses a corrupt counter rather than reading it as zero used", async () => {
    mkdirSync(join(dir, ".design-loop"));
    writeFileSync(join(dir, ".design-loop", "quota.json"), "{not json");
    await expect(readQuota(dir)).rejects.toThrow(/corrupt/);
    await expect(reserve(dir, 1)).rejects.toThrow(/corrupt/);
  });
});
