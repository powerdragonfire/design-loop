import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChair, writeChair } from "../../src/store/store.js";

const runDir = () => {
  const d = mkdtempSync(join(tmpdir(), "dl-chair-"));
  mkdirSync(join(d, "v01"));
  mkdirSync(join(d, "v01", "inbox"));
  return d;
};

describe("chair.json", () => {
  it("round-trips the raw synthesise answer", async () => {
    const dir = runDir();
    await writeChair(dir, "v01", { prompt: "make the button bigger", changeIds: ["typography-001"] });
    expect(await readChair(dir, "v01")).toEqual({ prompt: "make the button bigger", changeIds: ["typography-001"] });
  });

  it("returns null when the chair has not answered yet", async () => {
    expect(await readChair(runDir(), "v01")).toBeNull();
  });

  it("rejects a stored answer with no prompt", async () => {
    const dir = runDir();
    await writeChair(dir, "v01", { prompt: "", changeIds: [] });
    await expect(readChair(dir, "v01")).rejects.toThrow(/empty prompt/);
  });

  it("reads the inbox copy separately from the archived version copy", async () => {
    // The inbox file is dropped by an external writer (the subagent), not by writeChair; readChair only
    // needs to find it. The version and inbox copies can legitimately disagree until one is accepted.
    const dir = runDir();
    await writeChair(dir, "v01", { prompt: "archived answer", changeIds: ["a-1"] });
    writeFileSync(join(dir, "v01", "inbox", "chair.json"), JSON.stringify({ prompt: "inbox answer", changeIds: ["b-2"] }));
    expect(await readChair(dir, "v01", "version")).toEqual({ prompt: "archived answer", changeIds: ["a-1"] });
    expect(await readChair(dir, "v01", "inbox")).toEqual({ prompt: "inbox answer", changeIds: ["b-2"] });
  });
});
