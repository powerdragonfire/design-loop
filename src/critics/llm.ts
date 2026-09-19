import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { Config, Contract, CriticName, Critique, Issue, Usage } from "../types.js";

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

export async function runCommittee(input: CriticInput, cfg: Config, llm: LlmClient): Promise<CommitteeResult> {
  const model = cfg.models.critic;
  // One retry per critic, inline, so a retry does not wait for the slowest sibling.
  const attempt = async (c: LlmCriticName): Promise<Critique> => {
    try {
      return await llm.critique(c, input, model);
    } catch (e) {
      if (!retryable(e)) throw e;
      return await llm.critique(c, input, model);
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

const SEVERITIES = ["blocker", "major", "minor"] as const;
const EFFORTS = ["low", "medium", "high"] as const;
const CRITIC_NAMES = ["typography", "behavioural", "accessibility", "tokenConformance", "feasibility"] as const;

// Pins the Critique shape. Only keywords structured outputs accept: any string or numeric constraint
// (minLength, minimum, ...) is a 400 that would drop all four critics. Non-empty id/selector and the
// score range are enforced by parseCritique; the enums matter because Task 5's gate treats an unknown
// severity or an empty id as "not open", so without them it could pass with a live issue.
const ISSUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "severity", "evidence", "claim", "fix", "effort"],
  properties: {
    id: { type: "string" },
    severity: { type: "string", enum: [...SEVERITIES] },
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["selector", "observed"],
      properties: { selector: { type: "string" }, observed: { type: "string" } },
    },
    claim: { type: "string" },
    fix: { type: "string" },
    effort: { type: "string", enum: [...EFFORTS] },
  },
} as const;

const CRITIQUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["critic", "score", "issues", "resolved"],
  properties: {
    critic: { type: "string", enum: [...CRITIC_NAMES] },
    score: { type: "number" },
    issues: { type: "array", items: ISSUE_SCHEMA },
    resolved: {
      type: "object",
      additionalProperties: false,
      required: ["claimed", "verified"],
      properties: {
        claimed: { type: "array", items: { type: "string" } },
        verified: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

const rubrics = new Map<LlmCriticName, string>();
function rubric(critic: LlmCriticName): string {
  let r = rubrics.get(critic);
  if (r === undefined) {
    r = readFileSync(new URL(`./prompts/${critic}.md`, import.meta.url), "utf8").trimEnd();
    rubrics.set(critic, r);
  }
  return r;
}

/** Structured outputs may not enforce every constraint the schema states, so the shape is checked here too. */
function invalid(critic: CriticName, why: string): never {
  throw new Error(`${critic} returned an invalid critique: ${why}`);
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function parseCritique(critic: CriticName, raw: unknown): Critique {
  if (!isObj(raw)) return invalid(critic, "not an object");
  if (typeof raw.score !== "number" || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > 100) {
    return invalid(critic, "score is not a number in 0..100");
  }
  if (!Array.isArray(raw.issues)) return invalid(critic, "issues is not an array");
  const prefix = `${critic}-`;
  const prefixed = (id: string) => (id.startsWith(prefix) ? id : prefix + id);
  // Every id in the reply, so a renumbered duplicate cannot collide with a later issue.
  const taken = new Set<string>(raw.issues.map((i: any) => (isNonEmpty(i?.id) ? prefixed(i.id) : "")));
  const seen = new Set<string>();
  // The first occurrence keeps its id; later ones get -2, -3, ..., skipping ids used elsewhere in the reply.
  const unique = (id: string): string => {
    let out = id;
    for (let n = 2; seen.has(out) || (out !== id && taken.has(out)); n++) out = `${id}-${n}`;
    seen.add(out);
    return out;
  };
  const issues = raw.issues.map((i: unknown, n: number): Issue => {
    if (!isObj(i)) return invalid(critic, `issue ${n} is not an object`);
    if (!isNonEmpty(i.id)) return invalid(critic, `issue ${n} has no id`);
    if (!SEVERITIES.includes(i.severity)) return invalid(critic, `issue ${n} has unknown severity`);
    if (!EFFORTS.includes(i.effort)) return invalid(critic, `issue ${n} has unknown effort`);
    if (!isObj(i.evidence) || !isNonEmpty(i.evidence.selector)) return invalid(critic, `issue ${n} cites no selector`);
    return {
      // Prefixing keeps ids collision-free across critics and keeps `det-` reserved for the deterministic pass.
      id: unique(prefixed(i.id)),
      severity: i.severity,
      evidence: { selector: i.evidence.selector, observed: String(i.evidence.observed ?? "") },
      claim: String(i.claim ?? ""),
      fix: String(i.fix ?? ""),
      effort: i.effort,
    };
  });
  if (!isObj(raw.resolved) || !Array.isArray(raw.resolved.claimed)) return invalid(critic, "resolved.claimed is missing");
  return {
    critic,
    score: raw.score,
    issues,
    // A model never verifies itself: verification is mechanical (Task 4).
    resolved: { claimed: raw.resolved.claimed.map(String), verified: [] },
  };
}

/** Next free number for this critic's NEW issues: max numeric suffix among its open ids, plus one. */
function nextIssueId(critic: CriticName, open: Issue[]): string {
  const re = new RegExp(`^${critic}-(\\d+)`);
  const max = open.reduce((m, i) => Math.max(m, Number(re.exec(i.id)?.[1] ?? 0)), 0);
  return `${critic}-${String(max + 1).padStart(3, "0")}`;
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
