import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectVersion } from "../../src/cli/inspect.js";
import type { MeasuredDoc } from "../../src/types.js";

const node = (selector: string, text: string, style: Record<string, string>) =>
  ({ selector, tag: "button", role: null, text, bbox: { x: 0, y: 0, w: 48, h: 48 }, style, depth: 1 });

const doc: MeasuredDoc = {
  viewport: { w: 390, h: 844 },
  nodes: [
    node("#b1", "Go", { fontSize: "14px", color: "rgb(11, 11, 15)" }),
    node("#b2", "Cancel", { fontSize: "16px", color: "rgb(255, 122, 26)" }),
  ],
};

const versionDir = () => {
  const d = mkdtempSync(join(tmpdir(), "dl-inspect-"));
  writeFileSync(join(d, "digest.json"), JSON.stringify(doc));
  return d;
};

describe("inspectVersion", () => {
  it("returns the node matching a selector, with every style property", async () => {
    const out = await inspectVersion({ versionDir: versionDir(), selector: "#b1" });
    expect(out).toHaveLength(1);
    expect(out[0]!.style.fontSize).toBe("14px");
  });

  it("finds nodes by a text substring, case-insensitively", async () => {
    const out = await inspectVersion({ versionDir: versionDir(), text: "cancel" });
    expect(out.map((n) => n.selector)).toEqual(["#b2"]);
  });

  it("returns an empty list rather than throwing when nothing matches", async () => {
    expect(await inspectVersion({ versionDir: versionDir(), selector: "#nope" })).toEqual([]);
  });

  it("requires both to match when selector and text are both given", async () => {
    const out = await inspectVersion({ versionDir: versionDir(), selector: "#b1", text: "cancel" });
    expect(out).toEqual([]);
  });

  it("refuses a call with neither a selector nor text", async () => {
    await expect(inspectVersion({ versionDir: versionDir() })).rejects.toThrow(/--selector or --text/);
  });

  it("names the file when digest.json cannot be read", async () => {
    const d = mkdtempSync(join(tmpdir(), "dl-inspect-missing-"));
    await expect(inspectVersion({ versionDir: d, selector: "#b1" })).rejects.toThrow(/digest\.json/);
  });
});
