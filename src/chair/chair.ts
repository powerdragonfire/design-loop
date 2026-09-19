import Anthropic from "@anthropic-ai/sdk";
import type { Config, Critique, Effort, Issue, Severity, Usage } from "../types.js";

export interface ChairInput {
  critiques: Critique[];
  openIssues: Issue[];
  imagePng: Buffer;
  tokens: unknown;
  /**
   * Set when the last round scored below the best one. The chair builds from `bestVersion` (so `imagePng` is that
   * version's screenshot), and is told how far the last edit fell, what it introduced and the prompt that caused it.
   */
  regression: { bestVersion: string; delta: number; introduced: Issue[]; failedPrompt: string } | null;
}

export interface ChairClient {
  synthesise(input: ChairInput, model: string): Promise<{ prompt: string; changes: Issue[] }>;
  takeUsage?(): Usage;
}

/**
 * Stitch, given many simultaneous instructions, rewrites the layout wholesale and regresses.
 * The cap lives in code because the model cannot be trusted to keep to it.
 */
const MAX_CHANGES = 3;

const SEVERITY_WEIGHT: Record<Severity, number> = { blocker: 3, major: 2, minor: 1 };
const EFFORT_WEIGHT: Record<Effort, number> = { low: 1, medium: 2, high: 3 };

/**
 * Highest severity / effort first (spec §8: severity x 1/effort), so a cheap major outranks an expensive blocker.
 * Scores are compared by cross-multiplication so equal scores are exactly equal. Ties: higher severity, then id.
 */
export function rank(issues: Issue[]): Issue[] {
  return [...issues].sort(
    (a, b) =>
      SEVERITY_WEIGHT[b.severity] * EFFORT_WEIGHT[a.effort] - SEVERITY_WEIGHT[a.severity] * EFFORT_WEIGHT[b.effort] ||
      SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * The cap has to reach Stitch, not just our own bookkeeping: the model writes prose for every change it
 * chose, so truncating the list while forwarding its prompt verbatim would still ask for all of them
 * (spec §8, §14). When it overran, the prompt is rebuilt from the kept issues' own `fix` texts.
 */
function capPrompt(changes: Issue[]): string {
  const lines = changes.map((c, n) => `${n + 1}. ${c.fix} (element: ${c.evidence.selector})`);
  return [
    `Make exactly these ${changes.length} changes and nothing else:`,
    ...lines,
    "Keep everything else on the screen exactly as it is.",
  ].join("\n");
}

export async function chair(
  input: ChairInput,
  cfg: Config,
  client: ChairClient,
): Promise<{ prompt: string; changes: Issue[]; buildFrom: string | null; requested: number }> {
  const { prompt, changes } = await client.synthesise(input, cfg.models.chair);
  const kept = rank(changes).slice(0, MAX_CHANGES);
  return {
    // Under the cap the model's own prompt is richer than any template, so it is kept untouched.
    prompt: changes.length > MAX_CHANGES ? capPrompt(kept) : prompt,
    changes: kept,
    buildFrom: input.regression?.bestVersion ?? null,
    requested: changes.length,
  };
}

// ---- the Anthropic client ----------------------------------------------------

// Only keywords structured outputs accept: any string or numeric constraint (minLength, minItems, ...)
// is a 400 (found in Task 8). A blank prompt is rejected by the client instead.
const CHAIR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "changeIds"],
  properties: {
    prompt: { type: "string" },
    changeIds: { type: "array", items: { type: "string" } },
  },
} as const;

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const INSTRUCTIONS = [
  "You are the chair of a design committee. Critics have listed the open issues on a mobile screen that Google Stitch generated. " +
    "Write the single edit prompt that Stitch's `screen.edit()` will receive to improve the screen.",
  `Change at most three things. Stitch, given many simultaneous instructions, rewrites the layout wholesale and regresses, so choose the ${MAX_CHANGES} most valuable open issues and leave the rest for a later round. ` +
    "List the id of each issue you chose in `changeIds`, exactly as given; never invent an id.",
  "Choose and order the changes by severity divided by effort, highest first: severity blocker 3, major 2, minor 1; effort low 1, medium 2, high 3.",
  "When issues conflict, the precedence is: accessibility beats behavioural beats typography beats feasibility.",
  "Write ONE self-contained natural-language prompt. Name each element you want changed, say precisely what should change, " +
    "and cite the design token values below (hex codes, sizes) rather than describing them loosely. " +
    "Tell Stitch to keep everything else on the screen as it is. Do not refer to issue ids or to the committee in the prompt: Stitch has not seen them.",
].join("\n\n");

type Sdk = { beta: { messages: { create(params: any): Promise<any> } } };

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

const describeIssue = (i: Issue): string =>
  `- ${i.id} [${i.severity}, effort ${i.effort}] ${i.evidence.selector}: ${i.claim} Fix: ${i.fix}`;

export class AnthropicChairClient implements ChairClient {
  private readonly sdk: Sdk;
  private readonly fallbacks: boolean;
  private usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  constructor(sdk?: Sdk, opts: { fallbacks?: boolean } = {}) {
    this.sdk = sdk ?? new Anthropic();
    this.fallbacks = opts.fallbacks ?? true;
  }

  async synthesise(input: ChairInput, model: string): Promise<{ prompt: string; changes: Issue[] }> {
    // Stable prefix: identical bytes every round, so it caches.
    const system = [
      { type: "text", text: INSTRUCTIONS },
      {
        type: "text",
        text: `Design tokens (JSON):\n${JSON.stringify(input.tokens, null, 2)}`,
        cache_control: { type: "ephemeral" },
      },
    ];

    // Volatile part, after the cache breakpoint.
    const parts = [
      input.openIssues.length
        ? `Open issues:\n${input.openIssues.map(describeIssue).join("\n")}`
        : "No issues are open.",
    ];
    if (input.regression) {
      const { bestVersion, delta, introduced, failedPrompt } = input.regression;
      parts.push(
        `The last edit made the design worse: its score moved by ${delta} against ${bestVersion}, the best version so far. ` +
          `The attached screenshot shows ${bestVersion}, the BEST version so far, the one your new edit will be applied to. ` +
          `Build from ${bestVersion} and try a different approach from the last edit.\n` +
          `The edit prompt that caused this regression was:\n${failedPrompt}\nDo not repeat it.` +
          (introduced.length ? `\nIssues the failed edit introduced:\n${introduced.map(describeIssue).join("\n")}` : ""),
      );
    }
    const content = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: input.imagePng.toString("base64") } },
      { type: "text", text: parts.join("\n\n") },
    ];

    const res = await this.sdk.beta.messages.create({
      model,
      // Adaptive thinking tokens count toward this.
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: CHAIR_SCHEMA } },
      system,
      messages: [{ role: "user", content }],
      // Re-runs a safety-classifier refusal server-side rather than failing the round.
      ...(this.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" } : {}),
    });

    // Counted before any throw: a refused or truncated call still spent tokens.
    const u = res.usage ?? {};
    this.usage.inputTokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    this.usage.outputTokens += u.output_tokens ?? 0;
    this.usage.cachedTokens += u.cache_read_input_tokens ?? 0;

    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
      throw new Error(`chair stopped with ${res.stop_reason}`);
    }
    // A fallback response carries `fallback` blocks, and a mid-stream decline can leave partial text
    // BEFORE them, so the reply is the last text block, never the first.
    const block = (res.content ?? []).filter((b: any) => b.type === "text").at(-1);
    if (!block) throw new Error("chair returned no text block");
    let raw: unknown;
    try {
      raw = JSON.parse(block.text);
    } catch {
      throw new Error("chair returned invalid JSON");
    }
    if (!isObj(raw) || typeof raw.prompt !== "string" || raw.prompt.trim() === "") {
      throw new Error("chair returned an empty prompt");
    }
    if (!Array.isArray(raw.changeIds)) throw new Error("chair returned no changeIds");

    // The model names issues by id and never writes one, so it cannot fabricate an issue.
    const byId = new Map(input.openIssues.map(i => [i.id, i] as const));
    const changes: Issue[] = [];
    for (const id of new Set(raw.changeIds.map(String))) {
      const issue = byId.get(id);
      if (issue) changes.push(issue);
    }
    return { prompt: raw.prompt.trim(), changes };
  }

  takeUsage(): Usage {
    const taken = this.usage;
    this.usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    return taken;
  }
}
