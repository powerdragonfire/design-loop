import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQuota, reserve, MONTHLY_LIMIT } from "../../src/stitch/quota.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dl-")); });

describe("quota", () => {
  it("starts at zero used", async () => {
    expect((await readQuota(dir)).used).toBe(0);
  });
  it("accumulates reservations", async () => {
    await reserve(dir, 4); await reserve(dir, 2);
    expect((await readQuota(dir)).used).toBe(6);
  });
  it("throws before generating when a reservation would exceed the limit", async () => {
    await reserve(dir, MONTHLY_LIMIT - 2);
    await expect(reserve(dir, 6)).rejects.toThrow(/quota/i);
  });
  it("does not consume quota on a rejected reservation", async () => {
    await reserve(dir, MONTHLY_LIMIT - 2);
    await reserve(dir, 6).catch(() => {});
    expect((await readQuota(dir)).used).toBe(MONTHLY_LIMIT - 2);
  });
  it("resets when the month changes", async () => {
    await reserve(dir, 10);
    const q = await readQuota(dir, "2099-01");
    expect(q.used).toBe(0);
  });
  it("warns at 80 percent", async () => {
    await reserve(dir, Math.ceil(MONTHLY_LIMIT * 0.8));
    expect((await readQuota(dir)).warn).toBe(true);
  });
});
