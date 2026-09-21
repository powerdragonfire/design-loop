import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentChairClient } from "../../src/chair/agent.js";
import { WorkOrderPending } from "../../src/critics/agent.js";
import { versionName, type RoundCursor } from "../../src/store/store.js";
import type { ChairInput } from "../../src/chair/chair.js";
import type { Issue } from "../../src/types.js";

const issue = (id: string): Issue =>
  ({ id, severity: "major", evidence: { selector: "#b1", observed: "o" }, claim: "c", fix: "f", effort: "low" });

const input: ChairInput = {
  critiques: [], openIssues: [issue("typography-001"), issue("behavioural-002")],
  imagePng: Buffer.from("p"), tokens: {}, regression: null,
};

const setup = (body?: unknown, where: "inbox/chair.json" | "chair.json" = "inbox/chair.json") => {
  const dir = mkdtempSync(join(tmpdir(), "dl-chair-agent-"));
  mkdirSync(join(dir, versionName(0), "inbox"), { recursive: true });
  if (body !== undefined) writeFileSync(join(dir, versionName(0), where), JSON.stringify(body));
  return dir;
};

describe("AgentChairClient", () => {
  it("suspends when the chair has not answered", async () => {
    const client = new AgentChairClient({ runDir: setup(), cursor: { index: 0 } });
    await expect(client.synthesise(input, "agent")).rejects.toThrow(WorkOrderPending);
  });

  it("resolves change ids against the open issues and never invents one", async () => {
    const runDir = setup({ prompt: "make the button bigger", changeIds: ["typography-001", "ghost-999"] });
    const client = new AgentChairClient({ runDir, cursor: { index: 0 } });

    const out = await client.synthesise(input, "agent");
    expect(out.prompt).toBe("make the button bigger");
    expect(out.changes.map((c) => c.id)).toEqual(["typography-001"]);
  });

  it("prefers the archived answer over the inbox", async () => {
    const runDir = setup({ prompt: "archived", changeIds: [] }, "chair.json");
    writeFileSync(join(runDir, versionName(0), "inbox", "chair.json"),
      JSON.stringify({ prompt: "newer", changeIds: [] }));
    const client = new AgentChairClient({ runDir, cursor: { index: 0 } });

    expect((await client.synthesise(input, "agent")).prompt).toBe("archived");
  });

  it("refuses an empty prompt", async () => {
    const runDir = setup({ prompt: "   ", changeIds: [] });
    const client = new AgentChairClient({ runDir, cursor: { index: 0 } });
    await expect(client.synthesise(input, "agent")).rejects.toThrow(/empty prompt/);
  });

  it("drops a duplicated change id rather than duplicating the change", async () => {
    const runDir = setup({ prompt: "p", changeIds: ["typography-001", "typography-001"] });
    const client = new AgentChairClient({ runDir, cursor: { index: 0 } });

    const out = await client.synthesise(input, "agent");
    expect(out.changes.map((c) => c.id)).toEqual(["typography-001"]);
  });

  it("has no takeUsage: subagent tokens never reach this process", () => {
    const client = new AgentChairClient({ runDir: setup(), cursor: { index: 0 } });
    expect((client as { takeUsage?: unknown }).takeUsage).toBeUndefined();
  });
});
