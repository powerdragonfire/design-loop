import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir as mkdirAsync, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDirections } from "../../src/cli/candidates.js";

describe("readDirections", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dl-")); });

  it("returns the prose under each heading, in file order", async () => {
    await writeFile(join(dir, "directions.md"), "# Directions\n\n## Agent first\n\nLead with the agent.\n\n## Form first\n\nLead with the form.\n");
    expect(await readDirections(dir)).toEqual(["Lead with the agent.", "Lead with the form."]);
  });

  it("joins a multi-paragraph direction into one block", async () => {
    await writeFile(join(dir, "directions.md"), "## One\n\nFirst line.\n\nSecond line.\n");
    expect(await readDirections(dir)).toEqual(["First line.\n\nSecond line."]);
  });

  it("returns nothing when the file is absent, so an existing design folder is unchanged", async () => {
    expect(await readDirections(dir)).toEqual([]);
  });

  it("returns nothing when the file has no level-two headings", async () => {
    await writeFile(join(dir, "directions.md"), "Just prose, no headings.\n");
    expect(await readDirections(dir)).toEqual([]);
  });

  it("skips a heading with no prose under it rather than yielding an empty direction", async () => {
    await writeFile(join(dir, "directions.md"), "## Empty\n\n## Real\n\nSomething.\n");
    expect(await readDirections(dir)).toEqual(["Something."]);
  });

  it("rejects rather than silencing when directions.md exists but cannot be read", async () => {
    // Create a directory named directions.md to provoke EISDIR or equivalent.
    await mkdirAsync(join(dir, "directions.md"));
    await expect(readDirections(dir)).rejects.toBeDefined();
  });

  it("normalises CRLF to LF in multi-paragraph directions", async () => {
    // Write with CRLF line endings; expect internal \r\n to become \n.
    await writeFile(join(dir, "directions.md"), "## One\r\n\r\nFirst line.\r\n\r\nSecond line.\r\n", "utf8");
    const result = await readDirections(dir);
    expect(result).toEqual(["First line.\n\nSecond line."]);
    expect(result[0]).not.toContain("\r");
  });
});
