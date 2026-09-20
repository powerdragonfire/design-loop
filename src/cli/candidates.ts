import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The art directions a run fans out over, one per `## ` heading of `directions.md`. The prose under a
 * heading is appended to the first prompt; the heading itself is only a label for a human reader.
 * A missing file is not an error: a design folder that has not opted in runs one family with no rider.
 */
export async function readDirections(designDir: string): Promise<string[]> {
  const raw = await readFile(join(designDir, "directions.md"), "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (raw === null) return [];
  // Normalize line endings so CRLF files and LF files behave identically, and multi-paragraph
  // directions don't retain internal \r\n.
  const normalized = raw.replace(/\r\n/g, "\n");
  const out: string[] = [];
  for (const section of normalized.split(/^## .*$/m).slice(1)) {
    const prose = section.trim();
    if (prose !== "") out.push(prose);
  }
  return out;
}
