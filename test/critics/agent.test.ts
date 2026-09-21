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
