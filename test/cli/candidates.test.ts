import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir as mkdirAsync, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDirections, generateCandidates, pickWinner, selectCandidate, type SelectOptions } from "../../src/cli/candidates.js";
import { noProgress } from "../../src/cli/progress.js";
import type { Config, CriticName } from "../../src/types.js";
import type { Generator, Screen } from "../../src/stitch/adapter.js";
import type { LlmClient } from "../../src/critics/llm.js";

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

function cfg(over: Partial<Config["candidates"]> = {}): Config {
  return {
    sigma: 3, maxRounds: 5, convergenceSigmas: 1, convergenceRounds: 2,
    models: { critic: "claude-sonnet-5", chair: "claude-opus-5" },
    weights: { typography: 0.25, behavioural: 0.2, accessibility: 0.2, tokenConformance: 0.2, feasibility: 0.15 },
    batchMode: false,
    candidates: { families: 1, variantsPerFamily: 0, creativeRange: "EXPLORE", aspects: [], ...over },
  };
}

describe("generateCandidates", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dl-")); });

  const contract = { tokens: { color: { a: "#000000" } }, brief: "B", config: cfg(), screens: { home: "S" } } as any;
  const screenStub = (id: string) => ({ id, edit: async () => screenStub(id), getHtml: async () => "<p/>", getImage: async () => Buffer.from("") });

  it("makes one seed per family and the configured variants of each", async () => {
    const generate = vi.fn(async (p: string) => screenStub(`seed${generate.mock.calls.length}`));
    const variants = vi.fn(async (_s: any, _p: string, o: any) => Array.from({ length: o.variantCount }, (_, i) => screenStub(`v${i}`)));
    const out = await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate, variants } as any,
      cfg: cfg({ families: 2, variantsPerFamily: 2 }), progress: noProgress,
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(variants).toHaveBeenCalledTimes(2);
    expect(out.map((c) => c.id)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
    expect(out.map((c) => c.family)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it("appends each direction to its family's prompt, and leaves extra families bare", async () => {
    await writeFile(join(dir, "directions.md"), "## A\n\nLead with the agent.\n");
    const generate = vi.fn(async (_p: string) => screenStub("s"));
    await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate, variants: async () => [] } as any,
      cfg: cfg({ families: 2, variantsPerFamily: 0 }), progress: noProgress,
    });
    expect(generate.mock.calls[0]![0]).toContain("Art direction: Lead with the agent.");
    expect(generate.mock.calls[1]![0]).not.toContain("Art direction:");
  });

  it("skips the variants call entirely when variantsPerFamily is zero", async () => {
    // The backwards-compatibility guarantee: a design folder that has not opted in must get exactly
    // one generation and no variants calls, proved directly on the generate spy, not just on the
    // output length.
    const generate = vi.fn(async () => screenStub("s"));
    const variants = vi.fn(async () => []);
    const out = await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate, variants } as any,
      cfg: cfg({ families: 1, variantsPerFamily: 0 }), progress: noProgress,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(variants).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
  });

  it("keeps the seed when a family's variants call fails, rather than losing the family", async () => {
    const variants = vi.fn(async () => { throw new Error("503 from Stitch"); });
    const out = await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate: async () => screenStub("s"), variants } as any,
      cfg: cfg({ families: 1, variantsPerFamily: 2 }), progress: noProgress,
    });
    expect(out.map((c) => c.id)).toEqual(["c0"]);
  });

  it("keeps the seed when a family's variants call rejects with a non-Error value", async () => {
    // A rejection that isn't an Error (a thrown string, or an object with no .message) must not
    // throw again from inside the catch itself, which would lose the seed the catch exists to save.
    const variants = vi.fn(async () => { throw "boom"; });
    const out = await generateCandidates({
      contract, screen: "home", designDir: dir, generator: { generate: async () => screenStub("s"), variants } as any,
      cfg: cfg({ families: 1, variantsPerFamily: 2 }), progress: noProgress,
    });
    expect(out.map((c) => c.id)).toEqual(["c0"]);
  });

  it("propagates a failed seed rather than skipping the family, and never attempts its variants", async () => {
    const variants = vi.fn(async () => []);
    await expect(generateCandidates({
      contract, screen: "home", designDir: dir,
      generator: { generate: async () => { throw new Error("503 from Stitch"); }, variants } as any,
      cfg: cfg({ families: 1, variantsPerFamily: 2 }), progress: noProgress,
    })).rejects.toThrow("503 from Stitch");
    expect(variants).not.toHaveBeenCalled();
  });
});

describe("pickWinner", () => {
  const row = (id: string, composite: number, blockers: number): any => ({ id, composite, blockers });

  it("takes the highest composite when nothing is close", () => {
    expect(pickWinner([row("c0", 70, 0), row("c1", 85, 9)], 4).id).toBe("c1");
  });

  it("prefers fewer blockers among candidates within one sigma of the leader", () => {
    expect(pickWinner([row("c0", 85, 9), row("c1", 83, 1)], 4).id).toBe("c1");
  });

  it("ignores a candidate more than one sigma behind, however clean it is", () => {
    expect(pickWinner([row("c0", 85, 9), row("c1", 78, 0)], 4).id).toBe("c0");
  });

  it("breaks a blocker tie on composite, then on id, so selection is deterministic", () => {
    expect(pickWinner([row("c1", 83, 2), row("c0", 84, 2)], 4).id).toBe("c0");
    expect(pickWinner([row("c1", 84, 2), row("c0", 84, 2)], 4).id).toBe("c0");
  });

  it("never returns a candidate whose committee failed", () => {
    const dead = { ...row("c0", 99, 0), failed: "committee unavailable" };
    expect(pickWinner([dead, row("c1", 60, 3)], 4).id).toBe("c1");
  });

  it("throws when every candidate failed, because there is nothing to iterate", () => {
    const dead = { ...row("c0", 0, 0), failed: "committee unavailable" };
    expect(() => pickWinner([dead], 4)).toThrow(/no candidate could be scored/);
  });
});

// Distinct, real HTML per candidate index: measure() drives a real headless Chromium, so this
// needs small-but-real markup (an element with inline styles), not an empty stub. Embedding the
// index in the text is what lets the fake LlmClient below tell candidates apart, since candidates
// in a family share the same prompt and would otherwise produce an identical digest.
function candidateHtml(i: number): string {
  return `<div style="width:200px;height:60px;background:#ffffff">` +
    `<span style="color:#111111;font-size:16px">Cand ${i}</span></div>`;
}

function screenStub(i: number): Screen {
  return {
    id: `seed${i}`,
    edit: async () => screenStub(i),
    getHtml: async () => candidateHtml(i),
    getImage: async () => Buffer.from(""),
  };
}

interface MakeOptsExtra {
  /** Candidate id whose entire committee (all four LLM critics) fails. */
  failFor?: string;
  /** A single critic that fails, but only for the named candidate. */
  failCritic?: { id: string; critic: CriticName };
  /** Collects every onDegraded call, for assertions. */
  degraded?: { critic: CriticName; error: string; id: string }[];
}

function makeOpts(candOver: Partial<Config["candidates"]> = {}, extra: MakeOptsExtra = {}): SelectOptions {
  const dir = mkdtempSync(join(tmpdir(), "dl-select-"));
  let n = 0;
  const generate = vi.fn(async () => screenStub(n++));
  const generator: Generator = { generate, variants: async () => [] } as any;
  const llm: LlmClient = {
    async critique(critic, input) {
      const m = /Cand (\d+)/.exec(input.digest);
      const id = `c${m ? m[1] : "?"}`;
      if (id === extra.failFor) throw new Error(`committee unavailable for ${id}`);
      if (extra.failCritic && extra.failCritic.id === id && extra.failCritic.critic === critic) {
        throw new Error(`${critic} unavailable for ${id}`);
      }
      return { critic, score: 90, issues: [], resolved: { claimed: [], verified: [] } };
    },
  };
  return {
    contract: { tokens: {}, brief: "B", config: cfg(candOver), screens: { home: "S" } } as any,
    screen: "home",
    designDir: dir,
    generator,
    cfg: cfg(candOver),
    progress: noProgress,
    llm,
    sigma: 4,
    onDegraded: (critic, error, id) => extra.degraded?.push({ critic, error, id }),
  };
}

describe("selectCandidate", () => {
  it("scores every candidate and returns the winner alongside all the rows", async () => {
    const sel = await selectCandidate(makeOpts({ families: 2, variantsPerFamily: 0 }));
    expect(sel.rows).toHaveLength(2);
    // 4 LLM critiques plus the deterministic tokenConformance critique.
    expect(sel.rows.every((r) => r.critiques.length === 5)).toBe(true);
    expect(sel.winner).toBe(sel.rows.find((r) => r.id === sel.winner.id));
  });

  it("marks a candidate whose committee failed and reports it, without failing the stage", async () => {
    const sel = await selectCandidate(makeOpts({ families: 2, variantsPerFamily: 0 }, { failFor: "c1" }));
    expect(sel.rows.find((r) => r.id === "c1")!.failed).toMatch(/committee/);
    expect(sel.winner.id).toBe("c0");
  });

  it("keeps scoring a candidate when only one of its LLM critics fails, renormalising instead of throwing", async () => {
    const degraded: { critic: CriticName; error: string; id: string }[] = [];
    const sel = await selectCandidate(
      makeOpts({ families: 2, variantsPerFamily: 0 }, { failCritic: { id: "c1", critic: "feasibility" }, degraded }),
    );
    expect(sel.rows).toHaveLength(2);
    const c1 = sel.rows.find((r) => r.id === "c1")!;
    expect(c1.failed).toBeUndefined();
    // The failed critic plus the deterministic one are absent/short one: 3 survivors + tokenConformance.
    expect(c1.critiques.length).toBe(4);
    expect(Number.isFinite(c1.composite)).toBe(true);
    expect(degraded).toEqual([{ critic: "feasibility", error: expect.any(String), id: "c1" }]);
    // The unaffected candidate still gets its full committee.
    expect(sel.rows.find((r) => r.id === "c0")!.critiques.length).toBe(5);
  });
});
