import { describe, it, expect, vi } from "vitest";
import { chair, rank, AnthropicChairClient, type ChairClient } from "../../src/chair/chair.js";
import type { Issue, Severity, Effort } from "../../src/types.js";

const iss = (id: string, severity: Severity, effort: Effort): Issue =>
  ({ id, severity, effort, evidence: { selector: `#${id}`, observed: "o" }, claim: id, fix: "f" });
const CFG = { models: { critic: "claude-sonnet-5", chair: "claude-opus-5" } } as any;
const base = { critiques: [], imagePng: Buffer.from(""), tokens: {}, regression: null };

describe("rank", () => {
  it("puts blockers above majors above minors", () => {
    const out = rank([iss("c", "minor", "low"), iss("a", "blocker", "low"), iss("b", "major", "low")]);
    expect(out.map(i => i.id)).toEqual(["a", "b", "c"]);
  });
  it("ranks the cheaper of two equal-severity issues first", () => {
    const out = rank([iss("hi", "major", "high"), iss("lo", "major", "low")]);
    expect(out.map(i => i.id)).toEqual(["lo", "hi"]);
  });
  it("ranks by severity divided by effort: a cheap major outranks an expensive blocker (spec §8)", () => {
    const out = rank([iss("blk", "blocker", "high"), iss("maj", "major", "low")]);
    expect(out.map(i => i.id)).toEqual(["maj", "blk"]);
  });
  it("breaks equal scores by higher severity, then id", () => {
    // minor/low = 1/1 and blocker/high = 3/3 are both 1
    expect(rank([iss("min", "minor", "low"), iss("blk", "blocker", "high")]).map(i => i.id)).toEqual(["blk", "min"]);
    expect(rank([iss("b", "major", "low"), iss("a", "major", "low")]).map(i => i.id)).toEqual(["a", "b"]);
  });
  it("does not mutate its input", () => {
    const input = [iss("b", "minor", "low"), iss("a", "blocker", "low")];
    const copy = [...input];
    rank(input);
    expect(input).toEqual(copy);
  });
});

describe("chair", () => {
  const client = (changes: Issue[]): ChairClient =>
    ({ synthesise: async () => ({ prompt: "do it", changes }) });

  it("truncates to the top three changes", async () => {
    const five = ["a", "b", "c", "d", "e"].map(id => iss(id, "blocker", "low"));
    const out = await chair({ ...base, openIssues: five }, CFG, client(five));
    expect(out.changes).toHaveLength(3);
  });

  it("truncates by rank, keeping the blockers", async () => {
    const mixed = [iss("m", "minor", "low"), iss("b1", "blocker", "low"),
                   iss("b2", "blocker", "low"), iss("b3", "blocker", "low")];
    const out = await chair({ ...base, openIssues: mixed }, CFG, client(mixed));
    expect(out.changes.map(i => i.id)).toEqual(["b1", "b2", "b3"]);
  });

  it("builds from the current version when there was no regression", async () => {
    const out = await chair({ ...base, openIssues: [] }, CFG, client([]));
    expect(out.buildFrom).toBeNull();
  });

  it("builds from best when the last round regressed", async () => {
    const regression = { bestVersion: "v01", delta: -6, introduced: [], failedPrompt: "p" };
    const out = await chair({ ...base, openIssues: [], regression }, CFG, client([]));
    expect(out.buildFrom).toBe("v01");
  });

  it("reports how many changes the model asked for, before the cap", async () => {
    const five = ["a", "b", "c", "d", "e"].map(id => iss(id, "blocker", "low"));
    const over = await chair({ ...base, openIssues: five }, CFG, client(five));
    expect(over.requested).toBe(5);
    const two = five.slice(0, 2);
    const under = await chair({ ...base, openIssues: two }, CFG, client(two));
    expect(under.requested).toBe(2);
  });

  it("rebuilds the prompt from the top three when the model asked for more, so the cap reaches Stitch", async () => {
    const fixes = ["a", "b", "c", "d", "e"].map((id, n) =>
      ({ ...iss(id, n === 4 ? "blocker" : "minor", "low"), fix: `FIX-${id}` }));
    const out = await chair({ ...base, openIssues: fixes }, CFG, client(fixes));
    expect(out.prompt).toBe(
      "Make exactly these 3 changes and nothing else:\n"
      + "1. FIX-e (element: #e)\n2. FIX-a (element: #a)\n3. FIX-b (element: #b)\n"
      + "Keep everything else on the screen exactly as it is.",
    );
    expect(out.changes.map(i => i.id)).toEqual(["e", "a", "b"]);
    expect(out.prompt).not.toContain("do it");
  });

  it("keeps the model's own prompt when it asked for three or fewer", async () => {
    const three = ["a", "b", "c"].map(id => iss(id, "blocker", "low"));
    const out = await chair({ ...base, openIssues: three }, CFG, client(three));
    expect(out.prompt).toBe("do it");
  });
});

describe("AnthropicChairClient", () => {
  const reply = (over: Record<string, unknown> = {}) => ({
    stop_reason: "end_turn",
    usage: { input_tokens: 500, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: [{ type: "text", text: JSON.stringify({ prompt: "Make the CTA 48px tall.", changeIds: ["a"], ...over }) }],
  });
  const make = (r: unknown, opts: { fallbacks?: boolean } = {}) => {
    const create = vi.fn(async (_p: any) => r);
    return { create, client: new AnthropicChairClient({ beta: { messages: { create } } }, opts) };
  };
  const open = [{ ...iss("a", "blocker", "low"), claim: "UNIQUE-CLAIM-A" }, iss("b", "major", "low")];
  const input = { ...base, openIssues: open, imagePng: Buffer.from("png"), tokens: { color: { accent: "#FF7A1A" } } };
  const sent = (create: any) => create.mock.calls[0][0];
  const sysText = (p: any) => (Array.isArray(p.system) ? p.system.map((b: any) => b.text).join("\n") : p.system);
  const userText = (p: any) => p.messages[0].content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

  it("sends the chair model, adaptive thinking, high effort, 16000 max_tokens, no sampling params, and a base64 screenshot", async () => {
    const { create, client } = make(reply());
    await client.synthesise(input, "claude-opus-5");
    const p = sent(create);
    expect(p.model).toBe("claude-opus-5");
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config.effort).toBe("high");
    expect(p.max_tokens).toBe(16000);
    expect(p.temperature).toBeUndefined();
    expect(p.top_p).toBeUndefined();
    const img = p.messages[0].content.find((b: any) => b.type === "image");
    expect(img.source).toEqual({ type: "base64", media_type: "image/png", data: Buffer.from("png").toString("base64") });
  });

  it("opts into server-side fallbacks by default and can be switched off", async () => {
    const on = make(reply());
    await on.client.synthesise(input, "claude-opus-5");
    expect(sent(on.create).betas).toContain("server-side-fallback-2026-07-01");
    expect(sent(on.create).fallbacks).toBe("default");
    const off = make(reply(), { fallbacks: false });
    await off.client.synthesise(input, "claude-opus-5");
    expect(sent(off.create).fallbacks).toBeUndefined();
    expect(sent(off.create).betas ?? []).not.toContain("server-side-fallback-2026-07-01");
  });

  it("states the conflict precedence verbatim and the three-change cap", async () => {
    const { create, client } = make(reply());
    await client.synthesise(input, "claude-opus-5");
    const sys = sysText(sent(create));
    expect(sys).toContain("accessibility beats behavioural beats typography beats feasibility");
    expect(sys).toMatch(/at most (3|three)/i);
  });

  it("keeps stable instructions in system and open issues in the user message", async () => {
    const { create, client } = make(reply());
    await client.synthesise(input, "claude-opus-5");
    const p = sent(create);
    expect(sysText(p)).not.toContain("UNIQUE-CLAIM-A");
    expect(userText(p)).toContain("UNIQUE-CLAIM-A");
  });

  it("gives no regression context when the last round did not regress", async () => {
    const { create, client } = make(reply());
    await client.synthesise(input, "claude-opus-5");
    expect(userText(sent(create))).not.toMatch(/regress/i);
  });

  it("gives the best version, the delta and the introduced issues when it did, and says to build from best", async () => {
    const regression = { bestVersion: "v01", delta: -6, failedPrompt: "FAILED-PROMPT-TEXT", introduced: [{ ...iss("z", "major", "low"), claim: "INTRODUCED-Z" }] };
    const { create, client } = make(reply());
    await client.synthesise({ ...input, regression }, "claude-opus-5");
    const u = userText(sent(create));
    expect(u).toContain("v01");
    expect(u).toContain("-6");
    expect(u).toContain("INTRODUCED-Z");
    expect(u).toContain("FAILED-PROMPT-TEXT");
    expect(u).toMatch(/build from/i);
    expect(u).toMatch(/screenshot[^.]*best version/i);
  });

  it("resolves changeIds to open issues and drops unknown ids", async () => {
    const { client } = make(reply({ changeIds: ["a", "zzz", "b"] }));
    const out = await client.synthesise(input, "claude-opus-5");
    expect(out.changes.map(i => i.id)).toEqual(["a", "b"]);
  });

  it("pins the reply schema without constraint keywords", async () => {
    const { create, client } = make(reply());
    await client.synthesise(input, "claude-opus-5");
    const fmt = sent(create).output_config.format;
    expect(fmt.type).toBe("json_schema");
    expect(fmt.schema.required).toEqual(expect.arrayContaining(["prompt", "changeIds"]));
    expect(fmt.schema.additionalProperties).toBe(false);
    expect(JSON.stringify(fmt.schema)).not.toMatch(/minLength|maxLength|pattern|minimum|maximum|minItems|maxItems/);
  });

  it("throws on a refusal, on max_tokens, on non-JSON and on an empty prompt", async () => {
    await expect(make({ ...reply(), stop_reason: "refusal" }).client.synthesise(input, "m")).rejects.toThrow(/refusal/);
    await expect(make({ ...reply(), stop_reason: "max_tokens" }).client.synthesise(input, "m")).rejects.toThrow(/max_tokens/);
    await expect(make({ ...reply(), content: [{ type: "text", text: "nope" }] }).client.synthesise(input, "m")).rejects.toThrow(/JSON/i);
    await expect(make(reply({ prompt: "  " })).client.synthesise(input, "m")).rejects.toThrow(/prompt/i);
  });

  it("reads the LAST text block, so a fallback's partial text before it is not mistaken for the reply", async () => {
    const answer = JSON.stringify({ prompt: "Make the CTA 48px tall.", changeIds: ["a"] });
    const { client } = make({
      ...reply(),
      content: [
        { type: "text", text: "I cannot hel" },
        { type: "fallback", model: "claude-sonnet-5" },
        { type: "text", text: answer },
      ],
    });
    const out = await client.synthesise(input, "claude-opus-5");
    expect(out.prompt).toBe("Make the CTA 48px tall.");
  });

  it("accumulates token usage and resets it when taken", async () => {
    const { client } = make(reply());
    await client.synthesise(input, "m");
    await client.synthesise(input, "m");
    expect(client.takeUsage()).toEqual({ inputTokens: 1000, outputTokens: 240, cachedTokens: 0 });
    expect(client.takeUsage()).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
  });
});
