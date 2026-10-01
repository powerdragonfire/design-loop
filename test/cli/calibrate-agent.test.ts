import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCalibrationDir, calibrateAgent } from "../../src/cli/calibrate.js";
import type { MeasuredDoc } from "../../src/types.js";

const FIX = new URL("../fixtures/design/", import.meta.url).pathname;
let dir: string;

// No browser: every reference screen measures to the same small doc.
const measure = async (): Promise<MeasuredDoc> => ({
  viewport: { w: 393, h: 852 },
  nodes: [{ selector: "#t", tag: "p", role: null, text: "Hi", bbox: { x: 0, y: 0, w: 100, h: 20 }, style: {} }],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dl-cal-agent-"));
  cpSync(FIX, dir, { recursive: true, filter: (src) => !src.includes(".design-loop") });
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ ...config, criticMode: "agent", sigma: null }));
});

type Order = { kind: string; runDir: string; units: { critic: string; agent: string; output: string; inputs: Record<string, string | null> }[] };

const answer = (order: Order, score: (output: string) => number): void => {
  for (const u of order.units) {
    writeFileSync(join(order.runDir, u.output), JSON.stringify({
      critic: u.critic, score: score(u.output), issues: [], resolved: { claimed: [], verified: [] },
    }));
  }
};

describe("calibrateAgent", () => {
  it("names every critic of every repeat of every screen in one work order", async () => {
    const out = await calibrateAgent({ designDir: dir, repeats: 2, measure });
    expect(out.done).toBe(false);
    if (out.done) return;
    const order = JSON.parse(readFileSync(out.workOrder, "utf8")) as Order;
    expect(order.kind).toBe("critics");
    expect(order.runDir).toBe(agentCalibrationDir(dir));
    expect(order.units).toHaveLength(3 * 2 * 4);
    expect(order.units[0]).toMatchObject({ critic: "typography", agent: "design-loop-typography", output: "a/v00/inbox/typography.json" });
    const a11y = order.units.find((u) => u.critic === "accessibility")!;
    expect(a11y.inputs.measurements).toBe("a/v00/measurements.json");
    expect(order.units.find((u) => u.critic === "typography")!.inputs.measurements).toBeNull();
  });

  it("measures sigma from the subagents' answers once they are all in, and records agent mode", async () => {
    const first = await calibrateAgent({ designDir: dir, repeats: 3, measure });
    if (first.done) throw new Error("expected a work order");
    const order = JSON.parse(readFileSync(first.workOrder, "utf8")) as Order;
    // Every critic scores 70, 80, 90 across the three repeats: sample std 10, composite std 8 (weights 0.8).
    answer(order, (output) => ({ v00: 70, v01: 80, v02: 90 })[output.split("/")[1] as "v00"]);

    const out = await calibrateAgent({ designDir: dir, repeats: 3, measure });
    expect(out.done).toBe(true);
    if (!out.done) return;
    expect(out.sigma).toBeCloseTo(8, 6);
    expect(out.usd).toBeNull();
    const cal = JSON.parse(readFileSync(join(dir, ".design-loop", "calibration.json"), "utf8"));
    expect(cal.criticMode).toBe("agent");
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).sigma).toBeCloseTo(8, 6);
  });

  it("keeps waiting on the critics that have not answered", async () => {
    const first = await calibrateAgent({ designDir: dir, repeats: 2, measure });
    if (first.done) throw new Error("expected a work order");
    const order = JSON.parse(readFileSync(first.workOrder, "utf8")) as Order;
    answer({ ...order, units: order.units.slice(1) }, () => 80);

    const again = await calibrateAgent({ designDir: dir, repeats: 2, measure });
    expect(again.done).toBe(false);
    if (again.done) return;
    const left = (JSON.parse(readFileSync(again.workOrder, "utf8")) as Order).units.map((u) => u.output);
    expect(left).toEqual([order.units[0]!.output]);
  });

  it("refuses a folder that is not in agent mode", async () => {
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ...config, criticMode: "api" }));
    await expect(calibrateAgent({ designDir: dir, repeats: 2, measure })).rejects.toThrow(/agent/);
  });
});
