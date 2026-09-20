import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { Config, Contract, CriticName, Critique, Issue, Usage } from "../types.js";
import { CRITIQUE_SCHEMA, nextIssueId, parseCritique } from "./schema.js";

export interface CriticInput {
  contract: Contract;
  screen: string;
  digest: string;
  imagePng: Buffer;
  openIssues: Issue[];
  /** Deterministic findings; shown to the accessibility critic only (spec §7). */
  measurements: Issue[];
}

export interface LlmClient {
  critique(critic: CriticName, input: CriticInput, model: string): Promise<Critique>;
  takeUsage?(): Usage;
}

/** The fifth dimension, tokenConformance, is the deterministic critic and is not in this list. */
const LLM_CRITICS = ["typography", "behavioural", "accessibility", "feasibility"] as const satisfies readonly CriticName[];
type LlmCriticName = (typeof LLM_CRITICS)[number];

const isLlmCritic = (c: CriticName): c is LlmCriticName => (LLM_CRITICS as readonly string[]).includes(c);

export interface CommitteeResult {
  critiques: Critique[];
  dropped: CriticName[];
  /** The last error message per dropped critic: a 400, a missing rubric and bad JSON must not look alike. */
  failures: { critic: CriticName; error: string }[];
}

// Retrying cannot fix a request the API has rejected outright. 429, 5xx, timeouts, parse errors
// and errors with no status are transient or model-side, so they get one more attempt.
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 422]);
const retryable = (e: unknown): boolean => !NON_RETRYABLE_STATUS.has((e as { status?: number } | null)?.status as number);

/** What a person watching the run sees of the committee; every hook is optional and none can change the result. */
export interface CommitteeHooks {
  /** A critic finished, after its retry if it needed one. */
  onCritic?(critic: CriticName, outcome: { ok: true; score: number; ms: number } | { ok: false; error: string; ms: number }): void;
  /** A critic's first attempt failed in a way worth a second. */
  onRetry?(critic: CriticName, error: string): void;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runCommittee(input: CriticInput, cfg: Config, llm: LlmClient, hooks?: CommitteeHooks): Promise<CommitteeResult> {
  const model = cfg.models.critic;
  // One retry per critic, inline, so a retry does not wait for the slowest sibling.
  const attempt = async (c: LlmCriticName): Promise<Critique> => {
    const started = Date.now();
    try {
      let critique: Critique;
      try {
        critique = await llm.critique(c, input, model);
      } catch (e) {
        if (!retryable(e)) throw e;
        hooks?.onRetry?.(c, messageOf(e));
        critique = await llm.critique(c, input, model);
      }
      hooks?.onCritic?.(c, { ok: true, score: critique.score, ms: Date.now() - started });
      return critique;
    } catch (e) {
      hooks?.onCritic?.(c, { ok: false, error: messageOf(e), ms: Date.now() - started });
      throw e;
    }
  };
  const settled = await Promise.allSettled(LLM_CRITICS.map(attempt));
  const result: CommitteeResult = { critiques: [], dropped: [], failures: [] };
  settled.forEach((r, i) => {
    const critic = LLM_CRITICS[i]!;
    if (r.status === "fulfilled") {
      result.critiques.push(r.value);
      return;
    }
    // Named, never silent: Task 12 renormalises the weights over the survivors (spec §14).
    result.dropped.push(critic);
    result.failures.push({ critic, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  return result;
}

// ---- the Anthropic client ----------------------------------------------------

const LEGEND =
  "A style property absent from a digest line has its initial value (0px, normal, none, static, auto, transparent). " +
  "`d=N` is nesting depth from `<body>` (0 = direct child). " +
  "Colours are `rgb()`/`rgba()` only; `effectiveBackground` is the painted background behind the node.";

const rubrics = new Map<LlmCriticName, string>();
function rubric(critic: LlmCriticName): string {
  let r = rubrics.get(critic);
  if (r === undefined) {
    r = readFileSync(new URL(`./prompts/${critic}.md`, import.meta.url), "utf8").trimEnd();
    rubrics.set(critic, r);
  }
  return r;
}

type Sdk = { messages: { create(params: any): Promise<any> } };

export class AnthropicLlmClient implements LlmClient {
  private readonly sdk: Sdk;
  private usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  constructor(sdk?: Sdk) {
    this.sdk = sdk ?? new Anthropic();
  }

  async critique(critic: CriticName, input: CriticInput, model: string): Promise<Critique> {
    if (!isLlmCritic(critic)) throw new Error(`${critic} is not an LLM critic`);
    const { contract } = input;

    // Stable prefix: identical bytes for this critic across every round and screen, so it caches.
    const system = [
      { type: "text", text: `${rubric(critic)}\n\n${LEGEND}` },
      { type: "text", text: `Design tokens (JSON):\n${JSON.stringify(contract.tokens, null, 2)}` },
      { type: "text", text: `Design brief:\n${contract.brief}`, cache_control: { type: "ephemeral" } },
    ];

    // Volatile part, after the cache breakpoint.
    const parts = [
      `Critique screen "${input.screen}" as the ${critic} critic.`,
      `Digest:\n${input.digest}`,
      `Screen spec:\n${contract.screens[input.screen] ?? "(none)"}`,
      input.openIssues.length
        ? `Open issues from earlier rounds. List the id under resolved.claimed only if now fixed:\n${JSON.stringify(input.openIssues, null, 2)}`
        : "No issues are open from earlier rounds.",
      // Volatile, so it lives here and not in the cached prefix.
      `Number any NEW issue starting at \`${nextIssueId(critic, input.openIssues)}\`; re-list a persisting issue under its existing id.`,
    ];
    if (critic === "accessibility") {
      parts.push(`Deterministic measurements (facts, do not contradict):\n${JSON.stringify(input.measurements, null, 2)}`);
    }
    const content = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: input.imagePng.toString("base64") } },
      { type: "text", text: parts.join("\n\n") },
    ];

    const res = await this.sdk.messages.create({
      model,
      // Adaptive thinking tokens count toward this; a truncation is retried identically, then dropped.
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: CRITIQUE_SCHEMA } },
      system,
      messages: [{ role: "user", content }],
    });

    // Counted before any throw: a refused or truncated call still spent tokens.
    const u = res.usage ?? {};
    this.usage.inputTokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    this.usage.outputTokens += u.output_tokens ?? 0;
    this.usage.cachedTokens += u.cache_read_input_tokens ?? 0;

    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
      throw new Error(`${critic} critic stopped with ${res.stop_reason}`);
    }
    const block = (res.content ?? []).find((b: any) => b.type === "text");
    if (!block) throw new Error(`${critic} critic returned no text block`);
    let raw: unknown;
    try {
      raw = JSON.parse(block.text);
    } catch {
      throw new Error(`${critic} critic returned invalid JSON`);
    }
    return parseCritique(critic, raw);
  }

  takeUsage(): Usage {
    const taken = this.usage;
    this.usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    return taken;
  }
}
