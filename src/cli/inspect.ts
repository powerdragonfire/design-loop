import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MeasuredDoc, MeasuredNode } from "../types.js";

/**
 * Answers a critic's question about one element from the measurements already taken for a version.
 * The digest handed to critics is a lossy text summary of the `MeasuredDoc` (spec: the whole reason
 * `ab-distiller` exists); this reads the `MeasuredDoc` itself back from `digest.json` so a critic can
 * recover a property the digest dropped, for one element, without the raw HTML and without a re-render.
 *
 * `--selector` and `--text` compose with AND, not OR: a critic naming both wants the one node that is
 * both that element and holds that text, not the union of two separate guesses.
 */
export async function inspectVersion(opts: {
  versionDir: string;
  selector?: string;
  text?: string;
}): Promise<MeasuredNode[]> {
  const { versionDir, selector, text } = opts;
  if (selector === undefined && text === undefined) {
    throw new Error("inspect needs --selector or --text");
  }
  const file = join(versionDir, "digest.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`cannot read the measurements: ${file}`);
  }
  const doc = JSON.parse(raw) as MeasuredDoc;
  const needle = text?.toLowerCase();
  return doc.nodes.filter((n) =>
    (selector === undefined || n.selector === selector) &&
    (needle === undefined || n.text.toLowerCase().includes(needle)));
}
