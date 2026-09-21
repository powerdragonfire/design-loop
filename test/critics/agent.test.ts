import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLlmClient, WorkOrderPending } from "../../src/critics/agent.js";
import { runCommittee, type LlmClient } from "../../src/critics/llm.js";
import { versionName, type RoundCursor } from "../../src/store/store.js";
import type { Config, Contract, CriticName } from "../../src/types.js";

const cfg = { models: { critic: "agent", chair: "agent" } } as Config;
const contract = { tokens: {}, brief: "", config: cfg, screens: { home: "spec" } } as unknown as Contract;
const input = { contract, screen: "home", digest: "d", imagePng: Buffer.from("p"), openIssues: [], measurements: [] };

const critique = (critic: CriticName, score: number) => ({
  critic, score, issues: [], resolved: { claimed: [], verified: [] },
});

const setup = (files: Partial<Record<CriticName, unknown>>, where: "inbox" | "critiques" = "inbox") => {
  const dir = mkdtempSync(join(tmpdir(), "dl-agent-"));
  const base = join(dir, versionName(0));
  mkdirSync(join(base, where), { recursive: true });
  for (const [critic, body] of Object.entries(files)) {
    writeFileSync(join(base, where, `${critic}.json`), JSON.stringify(body));
  }
  return dir;
};

describe("AgentLlmClient", () => {
  it("names every missing critic in one work order, not just the first", async () => {
    const runDir = setup({ typography: critique("typography", 71) });
    const cursor: RoundCursor = { index: 0 };
    const client = new AgentLlmClient({ runDir, cursor });

    await runCommittee(input, cfg, client);
    expect(() => client.throwIfPending()).toThrow(WorkOrderPending);
    try {
      client.throwIfPending();
    } catch (err) {
      const pending = err as WorkOrderPending;
      expect(pending.version).toBe("v00");
      expect(pending.units.map((u) => u.critic).sort())
        .toEqual(["accessibility", "behavioural", "feasibility"]);
    }
  });

  it("returns every critique once the inbox is complete", async () => {
    const runDir = setup({
      typography: critique("typography", 71), behavioural: critique("behavioural", 64),
      accessibility: critique("accessibility", 80), feasibility: critique("feasibility", 55),
    });
    const client = new AgentLlmClient({ runDir, cursor: { index: 0 } });

    const out = await runCommittee(input, cfg, client);
    expect(client.throwIfPending()).toBeUndefined();
    expect(out.critiques).toHaveLength(4);
    expect(out.dropped).toEqual([]);
  });

  it("prefers an archived critique over the inbox, so a replayed round is stable", async () => {
    const runDir = setup({ typography: critique("typography", 11) }, "critiques");
    mkdirSync(join(runDir, versionName(0), "inbox"), { recursive: true });
    writeFileSync(join(runDir, versionName(0), "inbox", "typography.json"),
      JSON.stringify(critique("typography", 99)));
    const client = new AgentLlmClient({ runDir, cursor: { index: 0 } });

    expect((await client.critique("typography", input, "agent")).score).toBe(11);
  });

  it("treats a critiques file containing literal null as malformed, not as absent", async () => {
    // A naive "absent" sentinel of `null` would make this file look not-found and fall through to
    // inbox/, breaking "archived always wins". It must instead reach parseCritique and be dropped.
    const runDir = setup({ typography: null as unknown }, "critiques");
    mkdirSync(join(runDir, versionName(0), "inbox"), { recursive: true });
    writeFileSync(join(runDir, versionName(0), "inbox", "typography.json"),
      JSON.stringify(critique("typography", 99)));
    const client = new AgentLlmClient({ runDir, cursor: { index: 0 } });

    await expect(client.critique("typography", input, "agent")).rejects.toThrow(/not an object/);
  });

  it("drops a malformed critique as a failed critic rather than crashing", async () => {
    const runDir = setup({
      typography: { critic: "typography", score: 999, issues: [], resolved: { claimed: [], verified: [] } },
      behavioural: critique("behavioural", 64), accessibility: critique("accessibility", 80),
      feasibility: critique("feasibility", 55),
    });
    const client = new AgentLlmClient({ runDir, cursor: { index: 0 } });

    const out = await runCommittee(input, cfg, client);
    expect(client.throwIfPending()).toBeUndefined();
    expect(out.dropped).toEqual(["typography"]);
    expect(out.failures[0]!.error).toMatch(/score is not a number in 0\.\.100/);
    expect(out.critiques).toHaveLength(3);
  });

  /**
   * Three copies of one critic's answer, each with a different score, so whichever the client reads is
   * unambiguous. The raw archive must lead: `critiques/` holds the critique AFTER `validateEvidence` stripped
   * the issues whose selectors were absent from the document, so a round replayed from it re-validates an
   * answer with nothing left to drop and records a hallucination rate of 0 — the manifest's own measure of
   * whether the critics are inventing evidence, quietly scaled down by how often the run was resumed.
   */
  const threeCopies = (scores: Partial<Record<"critiques-raw" | "critiques" | "inbox", number>>) => {
    const runDir = mkdtempSync(join(tmpdir(), "dl-agent-raw-"));
    const base = join(runDir, versionName(0));
    for (const [where, score] of Object.entries(scores)) {
      mkdirSync(join(base, where), { recursive: true });
      writeFileSync(join(base, where, "typography.json"), JSON.stringify(critique("typography", score)));
    }
    return runDir;
  };

  it("prefers the raw archive over the validated archive and over the inbox", async () => {
    const runDir = threeCopies({ "critiques-raw": 11, critiques: 22, inbox: 33 });
    const client = new AgentLlmClient({ runDir, cursor: { index: 0 } });
    expect((await client.critique("typography", input, "agent")).score).toBe(11);
  });

  // A version written by the one-shot `writeVersion` path keeps no raw copy, and the critiques it was handed
  // never went through `validateEvidence` — so they already ARE the raw answers, and must still beat the inbox.
  it("falls back to the validated archive when no raw copy was kept", async () => {
    const runDir = threeCopies({ critiques: 22, inbox: 33 });
    const client = new AgentLlmClient({ runDir, cursor: { index: 0 } });
    expect((await client.critique("typography", input, "agent")).score).toBe(22);
  });

  it("does not retry a pending critic", async () => {
    const runDir = setup({});
    const client = new AgentLlmClient({ runDir, cursor: { index: 0 } });
    let calls = 0;
    // A class instance's prototype methods (critique, throwIfPending) are not own properties, so spreading
    // the instance would drop them. Delegate explicitly instead, to keep the real client's behaviour intact
    // while still counting calls to `critique`.
    const counted: LlmClient = {
      critique: (...a: Parameters<LlmClient["critique"]>) => {
        calls++;
        return client.critique(...a);
      },
    };

    await runCommittee(input, cfg, counted);
    expect(calls).toBe(4); // one per critic, never a second attempt
  });
});
