import { describe, it, expect, vi } from "vitest";
import { runCommittee, AnthropicLlmClient, type LlmClient, type CriticInput } from "../../src/critics/llm.js";
import type { CriticName, Critique } from "../../src/types.js";

const CFG = {
  sigma: 3, maxRounds: 5, convergenceSigmas: 1, convergenceRounds: 2,
  models: { critic: "claude-sonnet-5", chair: "claude-opus-5" },
  weights: { typography: 0.25, behavioural: 0.2, accessibility: 0.2, tokenConformance: 0.2, feasibility: 0.15 },
  batchMode: false,
};
const stub = (critic: CriticName): Critique =>
  ({ critic, score: 70, issues: [], resolved: { claimed: [], verified: [] } });
const input = { contract: {} as any, screen: "home", digest: "d", imagePng: Buffer.from(""), openIssues: [], measurements: [] };

describe("runCommittee", () => {
  it("calls exactly the four LLM critics, never tokenConformance", async () => {
    const seen: CriticName[] = [];
    const llm: LlmClient = { critique: async (c) => { seen.push(c); return stub(c); } };
    await runCommittee(input, CFG, llm);
    expect(seen.sort()).toEqual(["accessibility", "behavioural", "feasibility", "typography"]);
  });

  it("runs them in parallel, not in series", async () => {
    let live = 0, peak = 0;
    const llm: LlmClient = { critique: async (c) => {
      peak = Math.max(peak, ++live);
      await new Promise(r => setTimeout(r, 10));
      live--; return stub(c);
    }};
    await runCommittee(input, CFG, llm);
    expect(peak).toBe(4);
  });

  it("passes the configured critic model through", async () => {
    const critique = vi.fn(async (c: CriticName) => stub(c));
    await runCommittee(input, CFG, { critique });
    expect(critique).toHaveBeenCalledWith("typography", input, "claude-sonnet-5");
  });

  it("retries a failing critic once before giving up on it", async () => {
    let attempts = 0;
    const llm: LlmClient = { critique: async (c) => {
      if (c === "feasibility") { attempts++; throw new Error("bad json"); }
      return stub(c);
    }};
    await runCommittee(input, CFG, llm);
    expect(attempts).toBe(2);
  });

  it("drops a critic that fails twice, and names it", async () => {
    const llm: LlmClient = { critique: async (c) => {
      if (c === "feasibility") throw new Error("bad json");
      return stub(c);
    }};
    const { critiques, dropped } = await runCommittee(input, CFG, llm);
    expect(critiques.map(c => c.critic)).not.toContain("feasibility");
    expect(dropped).toEqual(["feasibility"]);
  });

  it("never silently scores four dimensions as though they were five", async () => {
    const llm: LlmClient = { critique: async (c) => {
      if (c === "feasibility") throw new Error("bad json");
      return stub(c);
    }};
    const { critiques } = await runCommittee(input, CFG, llm);
    expect(critiques).toHaveLength(3);
  });
});

describe("runCommittee failure handling", () => {
  const httpError = (status: number) => Object.assign(new Error(`${status} upstream said no`), { status });
  const failing = (err: unknown) => {
    const calls = { n: 0 };
    const llm: LlmClient = { critique: async (c) => {
      if (c === "feasibility") { calls.n++; throw err; }
      return stub(c);
    }};
    return { calls, llm };
  };

  it.each([400, 401, 403, 404, 422])("does not retry an HTTP %i, and reports the cause", async (status) => {
    const { calls, llm } = failing(httpError(status));
    const { dropped, failures } = await runCommittee(input, CFG, llm);
    expect(calls.n).toBe(1);
    expect(dropped).toEqual(["feasibility"]);
    expect(failures).toEqual([{ critic: "feasibility", error: `${status} upstream said no` }]);
  });

  it.each([429, 500, 503])("retries an HTTP %i once", async (status) => {
    const { calls, llm } = failing(httpError(status));
    const { dropped, failures } = await runCommittee(input, CFG, llm);
    expect(calls.n).toBe(2);
    expect(dropped).toEqual(["feasibility"]);
    expect(failures).toHaveLength(1);
  });

  it("retries an error with no status once, and reports the last message", async () => {
    let n = 0;
    const llm: LlmClient = { critique: async (c) => {
      if (c === "feasibility") throw new Error(`bad json #${++n}`);
      return stub(c);
    }};
    const { failures } = await runCommittee(input, CFG, llm);
    expect(n).toBe(2);
    expect(failures).toEqual([{ critic: "feasibility", error: "bad json #2" }]);
  });

  it("keeps a critic that fails once and then succeeds, with no trace in dropped or failures", async () => {
    let n = 0;
    const llm: LlmClient = { critique: async (c) => {
      if (c === "feasibility" && ++n === 1) throw new Error("flaky");
      return stub(c);
    }};
    const { critiques, dropped, failures } = await runCommittee(input, CFG, llm);
    expect(critiques.map(c => c.critic)).toContain("feasibility");
    expect(dropped).toEqual([]);
    expect(failures).toEqual([]);
  });
});

describe("AnthropicLlmClient", () => {
  const good = (over: Record<string, unknown> = {}) => ({
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 },
    content: [{ type: "text", text: JSON.stringify({
      critic: "typography", score: 70, issues: [], resolved: { claimed: [], verified: [] }, ...over }) }],
  });
  const make = (reply: unknown) => {
    const create = vi.fn(async (_p: any) => reply);
    return { create, client: new AnthropicLlmClient({ messages: { create } }) };
  };
  const inp: CriticInput = {
    contract: { tokens: { color: { accent: "#FF7A1A" } }, brief: "BRIEF-TEXT", config: CFG as any, screens: { home: "SCREEN-TEXT" } },
    screen: "home", digest: "DIGEST-LINE", imagePng: Buffer.from("png-bytes"), openIssues: [],
    measurements: [{ id: "det-tap-#b1", severity: "blocker", evidence: { selector: "#b1", observed: "30x30" },
      claim: "MEASURED-CLAIM", fix: "f", effort: "low" }],
  };
  const sent = (create: any) => create.mock.calls[0][0];
  const text = (blocks: any[]) => blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

  it("sends the critic model, adaptive thinking, and a base64 screenshot", async () => {
    const { create, client } = make(good());
    await client.critique("typography", inp, "claude-sonnet-5");
    const p = sent(create);
    expect(p.model).toBe("claude-sonnet-5");
    expect(p.thinking).toEqual({ type: "adaptive" });
    const img = p.messages[0].content.find((b: any) => b.type === "image");
    expect(img.source).toEqual({ type: "base64", media_type: "image/png", data: Buffer.from("png-bytes").toString("base64") });
  });

  it("caches the stable prefix and keeps volatile content after it", async () => {
    const { create, client } = make(good());
    await client.critique("typography", inp, "m");
    const p = sent(create);
    expect(p.system[p.system.length - 1].cache_control).toEqual({ type: "ephemeral" });
    const sys = text(p.system);
    expect(sys).toContain("BRIEF-TEXT");
    expect(sys).toContain('"#FF7A1A"');
    expect(sys).not.toContain("DIGEST-LINE");
    expect(text(p.messages[0].content)).toContain("DIGEST-LINE");
  });

  it("pins severity to three levels and requires a non-empty id (the gate fails open otherwise)", async () => {
    const { create, client } = make(good());
    await client.critique("typography", inp, "m");
    const fmt = sent(create).output_config.format;
    expect(fmt.type).toBe("json_schema");
    const item = fmt.schema.properties.issues.items;
    expect(item.properties.severity.enum).toEqual(["blocker", "major", "minor"]);
    expect(item.properties.effort.enum).toEqual(["low", "medium", "high"]);
    expect(item.required).toContain("id");
    expect(item.properties.evidence.required).toContain("selector");
  });

  // Structured outputs 400 on unsupported constraint keywords, which would drop all four critics
  // every round; non-empty id/selector and the score range are enforced by parseCritique instead.
  it("uses only JSON-schema keywords structured outputs accept", async () => {
    const { create, client } = make(good());
    await client.critique("typography", inp, "m");
    const ALLOWED = new Set(["type", "properties", "required", "items", "enum", "additionalProperties", "description"]);
    const walk = (node: any, path: string) => {
      for (const key of Object.keys(node)) expect(ALLOWED.has(key), `${path}.${key}`).toBe(true);
      if (node.type === "object") expect(node.additionalProperties, path).toBe(false);
      for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`);
      if (node.items) walk(node.items, `${path}[]`);
    };
    walk(sent(create).output_config.format.schema, "$");
  });

  it("leaves room for adaptive thinking in max_tokens", async () => {
    const { create, client } = make(good());
    await client.critique("typography", inp, "m");
    expect(sent(create).max_tokens).toBe(16000);
  });

  it("zeroes resolved.verified from model output: a model never verifies itself", async () => {
    const { client } = make(good({ resolved: { claimed: ["typography-001"], verified: ["typography-001"] } }));
    const c = await client.critique("typography", inp, "m");
    expect(c.resolved).toEqual({ claimed: ["typography-001"], verified: [] });
  });

  it("stamps the requested critic name over whatever the model returned", async () => {
    const { client } = make(good({ critic: "typography" }));
    expect((await client.critique("accessibility", inp, "m")).critic).toBe("accessibility");
  });

  it("prefixes an issue id lacking the critic prefix, and leaves a prefixed one alone", async () => {
    const issue = (id: string) => ({ id, severity: "major", evidence: { selector: "#b1", observed: "o" }, claim: "c", fix: "f", effort: "low" });
    const { client } = make(good({ issues: [issue("001"), issue("typography-002")] }));
    const c = await client.critique("typography", inp, "m");
    expect(c.issues.map(i => i.id)).toEqual(["typography-001", "typography-002"]);
  });

  it("throws on a refusal so runCommittee can retry and then drop the critic", async () => {
    const { client } = make({ ...good(), stop_reason: "refusal" });
    await expect(client.critique("typography", inp, "m")).rejects.toThrow(/refusal/);
  });

  it("throws when the reply was cut off at max_tokens", async () => {
    const { client } = make({ ...good(), stop_reason: "max_tokens" });
    await expect(client.critique("typography", inp, "m")).rejects.toThrow(/max_tokens/);
  });

  it("throws on a non-JSON reply", async () => {
    const { client } = make({ ...good(), content: [{ type: "text", text: "not json" }] });
    await expect(client.critique("typography", inp, "m")).rejects.toThrow(/JSON/i);
  });

  it("gives the deterministic measurements to the accessibility critic only", async () => {
    const a = make(good({ critic: "accessibility" }));
    await a.client.critique("accessibility", inp, "m");
    const t = make(good());
    await t.client.critique("typography", inp, "m");
    expect(text(sent(a.create).messages[0].content)).toContain("MEASURED-CLAIM");
    expect(text(sent(t.create).messages[0].content)).not.toContain("MEASURED-CLAIM");
  });

  it("puts the digest legend in every critic's stable prefix", async () => {
    for (const critic of ["typography", "behavioural", "accessibility", "feasibility"] as const) {
      const { create, client } = make(good({ critic }));
      await client.critique(critic, inp, "m");
      const sys = text(sent(create).system);
      expect(sys).toMatch(/initial value/i);
      expect(sys).toContain("d=N");
    }
  });

  it("uses a different rubric per critic", async () => {
    const a = make(good());
    await a.client.critique("typography", inp, "m");
    const b = make(good({ critic: "feasibility" }));
    await b.client.critique("feasibility", inp, "m");
    expect(text(sent(a.create).system)).not.toBe(text(sent(b.create).system));
  });

  it("accumulates token usage and resets it when taken", async () => {
    const { client } = make(good());
    await client.critique("typography", inp, "m");
    await client.critique("typography", inp, "m");
    expect(client.takeUsage()).toEqual({ inputTokens: 200, outputTokens: 40, cachedTokens: 120 });
    expect(client.takeUsage()).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
  });
  // Beyond the brief: the schema states these constraints but the model is not trusted to honour all of them.
  it("rejects a reply whose issue has an empty id, an unknown severity, or no selector", async () => {
    const issue = (over: Record<string, unknown>) =>
      ({ id: "001", severity: "major", evidence: { selector: "#b1", observed: "o" }, claim: "c", fix: "f", effort: "low", ...over });
    for (const bad of [{ id: "" }, { severity: "critical" }, { effort: "huge" }, { evidence: { selector: "", observed: "o" } }]) {
      const { client } = make(good({ issues: [issue(bad)] }));
      await expect(client.critique("typography", inp, "m")).rejects.toThrow(/invalid critique/);
    }
  });

  it("rejects a score outside 0..100", async () => {
    const { client } = make(good({ score: 140 }));
    await expect(client.critique("typography", inp, "m")).rejects.toThrow(/invalid critique/);
  });

  it("counts tokens spent on a call that then throws", async () => {
    const { client } = make({ ...good(), stop_reason: "refusal" });
    await expect(client.critique("typography", inp, "m")).rejects.toThrow();
    expect(client.takeUsage()).toEqual({ inputTokens: 100, outputTokens: 20, cachedTokens: 60 });
  });

  it("keeps the cached prefix byte-identical across screens and rounds", async () => {
    const a = make(good());
    await a.client.critique("typography", inp, "m");
    const b = make(good());
    await b.client.critique("typography", { ...inp, screen: "other", digest: "OTHER-DIGEST", openIssues: [inp.measurements[0]!] }, "m");
    expect(sent(b.create).system).toEqual(sent(a.create).system);
  });

  it("refuses to run tokenConformance, which is the deterministic critic", async () => {
    const { create, client } = make(good());
    await expect(client.critique("tokenConformance", inp, "m")).rejects.toThrow(/not an LLM critic/);
    expect(create).not.toHaveBeenCalled();
  });
  it("renumbers an id that duplicates an earlier one in the same reply", async () => {
    const issue = (id: string) => ({ id, severity: "major", evidence: { selector: "#b1", observed: "o" }, claim: "c", fix: "f", effort: "low" });
    const { client } = make(good({ issues: [issue("001"), issue("typography-001"), issue("typography-001"), issue("typography-001-2")] }));
    const c = await client.critique("typography", inp, "m");
    expect(c.issues.map(i => i.id)).toEqual(["typography-001", "typography-001-3", "typography-001-4", "typography-001-2"]);
  });

  it("tells the model where its numbering resumes, in the volatile message and not the cached prefix", async () => {
    const open = (id: string) => ({ id, severity: "major", evidence: { selector: "#b1", observed: "o" }, claim: "c", fix: "f", effort: "low" }) as const;
    const withOpen = { ...inp, openIssues: [open("typography-003"), open("accessibility-009"), open("det-tap-#b1")] };
    const t = make(good());
    await t.client.critique("typography", withOpen, "m");
    expect(text(sent(t.create).messages[0].content)).toContain("`typography-004`");
    expect(text(sent(t.create).messages[0].content)).toContain("existing id");
    expect(text(sent(t.create).system)).not.toContain("typography-004");
    const a = make(good({ critic: "accessibility" }));
    await a.client.critique("accessibility", withOpen, "m");
    expect(text(sent(a.create).messages[0].content)).toContain("`accessibility-010`");
  });

  it("starts numbering at 001 when the critic has no open issues", async () => {
    const { create, client } = make(good());
    await client.critique("typography", inp, "m");
    expect(text(sent(create).messages[0].content)).toContain("`typography-001`");
  });
});

describe("runCommittee hooks", () => {
  it("reports each critic as it finishes, with its score", async () => {
    const done: { critic: CriticName; ok: boolean; score?: number }[] = [];
    const llm: LlmClient = { critique: async (c) => stub(c) };
    await runCommittee(input, CFG, llm, { onCritic: (critic, o) => done.push({ critic, ok: o.ok, score: o.ok ? o.score : undefined }) });
    expect(done.map((d) => d.critic).sort()).toEqual(["accessibility", "behavioural", "feasibility", "typography"]);
    expect(done.every((d) => d.ok && d.score === 70)).toBe(true);
  });

  it("says when a critic is being retried, and reports it once, after the retry", async () => {
    const retries: string[] = [];
    const finished: boolean[] = [];
    let calls = 0;
    const llm: LlmClient = {
      critique: async (c) => {
        if (c === "typography" && calls++ === 0) throw Object.assign(new Error("529 overloaded"), { status: 529 });
        return stub(c);
      },
    };
    await runCommittee(input, CFG, llm, {
      onRetry: (c, e) => retries.push(`${c}: ${e}`),
      onCritic: (c, o) => { if (c === "typography") finished.push(o.ok); },
    });
    expect(retries).toEqual(["typography: 529 overloaded"]);
    expect(finished).toEqual([true]);
  });

  it("does not announce a retry for an error retrying cannot fix, and reports the critic as dropped", async () => {
    const retries: string[] = [];
    const dropped: string[] = [];
    const llm: LlmClient = {
      critique: async (c) => {
        if (c === "feasibility") throw Object.assign(new Error("400 bad request"), { status: 400 });
        return stub(c);
      },
    };
    const r = await runCommittee(input, CFG, llm, {
      onRetry: (c) => retries.push(c),
      onCritic: (c, o) => { if (!o.ok) dropped.push(`${c}: ${o.error}`); },
    });
    expect(retries).toEqual([]);
    expect(dropped).toEqual(["feasibility: 400 bad request"]);
    expect(r.dropped).toEqual(["feasibility"]);
  });
});
