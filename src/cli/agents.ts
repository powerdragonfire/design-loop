import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHAIR_SCHEMA } from "../chair/chair.js";
import { LEGEND, LLM_CRITICS } from "../critics/llm.js";
import { CRITIQUE_SCHEMA } from "../critics/schema.js";
import type { CriticName } from "../types.js";

/**
 * Where `sync-agents` writes and `step` checks, unless told otherwise. User-level, because Claude Code
 * discovers `~/.claude/agents/` from any project: the CLI runs from the tool's own directory
 * (`pnpm --dir <tool home> design-loop ...`), so a cwd-relative default would land in the tool's repo, where a
 * dispatcher working in the user's project never looks.
 */
export const defaultAgentsDir = (): string => join(homedir(), ".claude", "agents");

/**
 * One agent definition's origin: the rubric it is generated from, and the words that describe its job to
 * whoever reads `.claude/agents/` without following the source link.
 */
interface Source {
  name: string;
  /** The critic this agent is, or null for the chair: it picks the "How you are called" section. */
  critic: CriticName | null;
  rubric: URL;
  source: string;
  purpose: string;
}

// Reuses `LLM_CRITICS`'s order (Task 9): the same four critics, named the same way, so a work order's
// `agent` field and a `.claude/agents/` filename are never a rename apart.
const sources = (): Source[] => [
  ...LLM_CRITICS.map((critic) => ({
    name: `design-loop-${critic}`,
    critic,
    rubric: new URL(`../critics/prompts/${critic}.md`, import.meta.url),
    source: `src/critics/prompts/${critic}.md`,
    purpose: `the ${critic} critic of the design-loop committee`,
  })),
  {
    name: "design-loop-chair",
    critic: null,
    rubric: new URL("../chair/prompts/chair.md", import.meta.url),
    source: "src/chair/prompts/chair.md",
    purpose: "the chair of the design-loop committee",
  },
];

// Read, Grep and Glob to read the inputs and look a selector up in `digest.json`; Write for the one output
// file. No Bash, so no shell and no network, and no WebFetch or WebSearch.
//
// What is NOT enforced: agent frontmatter cannot scope a tool to a path. Nothing but the brief stops an agent
// reading files beyond its inputs, or writing a file other than its own output, including another critic's
// inbox or the chair's. README "Known limits" records this.
const TOOLS = "Read, Grep, Glob, Write";

interface Schema {
  type: string;
  enum?: readonly string[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  items?: Schema;
}

/**
 * The shape a schema describes, in the notation a brief can show. Rendered from the same schema the API path
 * enforces, so the agent brief cannot drift from the validator's tuples (`SEVERITIES`, `EFFORTS`).
 */
function shape(s: Schema, indent = ""): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.type === "array") return `${shape(s.items!, indent)}[]`;
  if (s.type === "object") {
    const inner = `${indent}  `;
    const keys = s.required ?? Object.keys(s.properties ?? {});
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${shape(s.properties![k]!, inner)}`).join(",\n")}\n${indent}}`;
  }
  return s.type;
}

/** A critic answers for itself, so its envelope names it rather than listing every critic. */
const critiqueShape = (critic: CriticName): string =>
  shape({ ...CRITIQUE_SCHEMA, properties: { ...CRITIQUE_SCHEMA.properties, critic: { type: "string", enum: [critic] } } });

const criticCall = (critic: CriticName): string => `## How you are called

A work order gives you input paths, a \`nextIssueId\` and exactly one output path. \`vNN/...\` paths are relative
to the work order's \`runDir\`; \`brief.md\`, \`tokens.json\` and \`screens/...\` are relative to its \`designDir\`.
An input whose value is \`null\` is one you are deliberately not shown. Read the inputs, write your answer as
JSON to the output path, and write nothing else anywhere.

- \`digest\`: one line per rendered element. ${LEGEND}
- \`screenshot\`, \`html\`, \`screenSpec\`, \`brief\`, \`tokens\`: the screen and the contract it is judged against.
- \`carriedIssues\`: the issues open from earlier rounds. List an id under \`resolved.claimed\` only if it is now
  fixed; re-list a persisting issue under its existing id.
- \`measurements\`, when you are given it: deterministic measurements. They are facts; do not contradict them.

Number any NEW issue starting at the \`nextIssueId\` you are given, never at 001: a new issue that reuses an id
from \`carriedIssues\` replaces that issue without it ever being checked.

To check a selector before you cite it, look it up in \`vNN/digest.json\`, in the same version directory as
your inputs. It holds every measured node: its \`selector\`, \`tag\`, \`text\`, \`bbox\` and every computed
\`style\` property, including the ones the digest drops. \`Grep\` it for the exact selector string, or \`Read\`
it. An issue whose selector is absent from that file is discarded and counts against your hallucination rate.

## What you write

Exactly one JSON object, and nothing else, of this shape:

\`\`\`
${critiqueShape(critic)}
\`\`\`

\`score\` is a number from 0 to 100. Leave \`resolved.verified\` empty: verification is mechanical and happens
after you answer. A file that does not parse, or does not have this shape, is not a critique: this critic is
dropped from the round.
`;

const chairCall = `## How you are called

A work order gives you two input paths and exactly one output path, all relative to its \`runDir\`. Read the
inputs, write your answer as JSON to the output path, and write nothing else anywhere.

- \`chairInput\`: a JSON file holding \`openIssues\` (the only issues you may choose; name each in
  \`changeIds\` exactly as it appears there), \`tokens\` (the design token values to cite), \`regression\` and
  \`screenshot\`.
- \`screenshot\`: the screen your edit will be applied to.

When \`regression\` is not null, the last edit made the design worse: its score moved by \`regression.delta\`
against \`regression.bestVersion\`, the best version so far. The screenshot shows that best version, the one
your new edit will be applied to. Build from it and try a different approach from the last edit.
\`regression.failedPrompt\` is the edit prompt that caused the regression, so do not repeat it, and
\`regression.introduced\` lists the issues the failed edit introduced.

## What you write

Exactly one JSON object, and nothing else, of this shape:

\`\`\`
${shape(CHAIR_SCHEMA)}
\`\`\`

\`prompt\` must not be blank. An id in \`changeIds\` that is not in \`openIssues\` is ignored. A file that does
not parse, or does not have this shape, aborts the whole run, and an aborted run cannot be resumed.
`;

const body = (s: Source, rubric: string): string =>
  `---
name: ${s.name}
description: ${s.purpose}. Dispatched by the design-loop CLI from a work-order.json; not for general use.
tools: ${TOOLS}
---

<!-- generated by \`dl sync-agents\` from ${s.source}; edit that file, never this one -->

${rubric}

${s.critic === null ? chairCall : criticCall(s.critic)}`;

/** Writes `design-loop-<critic>.md` and `design-loop-chair.md` into `outDir` from the current rubrics. */
export async function syncAgents(opts: { outDir: string }): Promise<string[]> {
  await mkdir(opts.outDir, { recursive: true });
  const written: string[] = [];
  for (const s of sources()) {
    const rubric = (await readFile(s.rubric, "utf8")).trimEnd();
    const file = join(opts.outDir, `${s.name}.md`);
    await writeFile(file, body(s, rubric));
    written.push(file);
  }
  return written.sort();
}

/**
 * Agent files that are missing, hand-edited, or generated from an older rubric — anything `dl step` must not
 * trust, because the critic it dispatches would be scoring against a standard nobody chose on purpose.
 *
 * Compares the whole rendered file byte-for-byte against what `syncAgents` would write right now, rather than
 * a hash or marker derived from the rubric alone: a marker that ignores the rest of the file is blind to an
 * edit that leaves the marker's own line untouched — for example a `tools:` line with `WebFetch` added to it,
 * which is exactly the edit this check exists to catch. There is nothing here to keep in sync with the
 * template `body()` renders, because it *is* `body()`, run again.
 */
export async function staleAgents(opts: { outDir: string }): Promise<string[]> {
  const stale: string[] = [];
  for (const s of sources()) {
    const rubric = (await readFile(s.rubric, "utf8")).trimEnd();
    const expected = body(s, rubric);
    const current = await readFile(join(opts.outDir, `${s.name}.md`), "utf8").catch(() => null);
    if (current !== expected) stale.push(s.name);
  }
  return stale;
}
