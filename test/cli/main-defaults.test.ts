import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const countTokens = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { countTokens }; } }));
vi.mock("../../src/stitch/adapter.js", () => ({ createStitchGenerator: vi.fn(() => ({})) }));
vi.mock("../../src/contract/load.js", () => ({ loadContract: vi.fn(async () => ({ config: { models: { critic: "claude-sonnet-5" } } })) }));

const { defaultDeps } = await import("../../src/cli/main.js");
const { createStitchGenerator } = await import("../../src/stitch/adapter.js");
const io = { out: () => {}, err: () => {} };

describe("production defaults", () => {
  beforeEach(() => { countTokens.mockReset(); });

  it("preflight counts tokens on the configured critic model", async () => {
    countTokens.mockResolvedValue({ input_tokens: 8 });
    await defaultDeps("design", io).preflight();
    expect(countTokens).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-5" }));
  });

  it.each([401, 403])("preflight turns a %i into a message naming the status, not the key", async (status) => {
    countTokens.mockRejectedValue(Object.assign(new Error(`${status} invalid x-api-key sk-secret`), { status }));
    await expect(defaultDeps("design", io).preflight()).rejects.toThrow(new RegExp(`^Anthropic rejected the API key \\(${status}\\)$`));
  });

  it("preflight passes any other failure through", async () => {
    countTokens.mockRejectedValue(Object.assign(new Error("overloaded"), { status: 529 }));
    await expect(defaultDeps("design", io).preflight()).rejects.toThrow("overloaded");
  });

  it("preflight fails on the Stitch variables before any Anthropic call", async () => {
    vi.mocked(createStitchGenerator).mockImplementationOnce(() => { throw new Error("STITCH_PROJECT_ID is not set"); });
    await expect(defaultDeps("design", io).preflight()).rejects.toThrow("STITCH_PROJECT_ID");
    expect(countTokens).not.toHaveBeenCalled();
  });

  it("committeePick reads committeeRank[0], and refuses a run with none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-main-"));
    const d = defaultDeps("design", io);
    await expect(d.committeePick(dir)).rejects.toThrow(/run not finalised/);
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ committeeRank: [] }));
    await expect(d.committeePick(dir)).rejects.toThrow(/run not finalised/);
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ committeeRank: ["v02", "v00"] }));
    expect(await d.committeePick(dir)).toBe("v02");
  });

  it("makeGenerator turns a Stitch retry into a warning that names what is retried and when", () => {
    const warnings: string[] = [];
    const progress = { warn: (l: string) => warnings.push(l) } as any;
    defaultDeps("design", io, progress).makeGenerator();
    const { onRetry } = vi.mocked(createStitchGenerator).mock.calls.at(-1)![0];
    onRetry!({ what: "generate", attempt: 2, of: 3, waitMs: 1000, error: "503 unavailable\nrequest_id: abc" });
    expect(warnings).toEqual(["stitch generate failed, attempt 2 of 3 in 1s: 503 unavailable"]);
  });
});
