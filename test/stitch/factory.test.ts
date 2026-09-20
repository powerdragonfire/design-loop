import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The adapter talks to the MCP tools directly (src/stitch/sdk.ts), so the seam to mock is callTool.
const callTool = vi.fn(async (_name: string, args: Record<string, any>) => ({
  outputComponents: [{ design: { screens: [{ id: `${args.projectId}-s1` }] } }],
}));
vi.mock("@google/stitch-sdk", () => ({
  stitch: { callTool: (name: string, args: Record<string, any>) => callTool(name, args) },
}));

const { createStitchGenerator } = await import("../../src/stitch/adapter.js");

const AUTH_VARS = ["STITCH_API_KEY", "STITCH_ACCESS_TOKEN", "GOOGLE_CLOUD_PROJECT", "STITCH_PROJECT_ID"];
const setEnv = (env: Record<string, string>) => {
  for (const name of AUTH_VARS) vi.stubEnv(name, env[name] ?? "");
};

afterEach(() => { vi.unstubAllEnvs(); callTool.mockClear(); });

describe("createStitchGenerator", () => {
  const quotaDir = () => mkdtempSync(join(tmpdir(), "dl-"));

  it("names STITCH_PROJECT_ID when it is missing", () => {
    setEnv({ STITCH_API_KEY: "k" });
    expect(() => createStitchGenerator({ quotaDir: quotaDir() })).toThrow(/STITCH_PROJECT_ID/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("names both accepted auth routes when there is no auth at all, and never prints a secret", () => {
    setEnv({ STITCH_PROJECT_ID: "p1" });
    const err = (() => { try { createStitchGenerator({ quotaDir: quotaDir() }); } catch (e) { return e as Error; } })();
    expect(err?.message).toMatch(/STITCH_API_KEY/);
    expect(err?.message).toMatch(/STITCH_ACCESS_TOKEN/);
    expect(err?.message).toMatch(/GOOGLE_CLOUD_PROJECT/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("names the missing half of the OAuth route without echoing the token", () => {
    setEnv({ STITCH_PROJECT_ID: "p1", STITCH_ACCESS_TOKEN: "ya29.secret-token" });
    const err = (() => { try { createStitchGenerator({ quotaDir: quotaDir() }); } catch (e) { return e as Error; } })();
    expect(err?.message).toMatch(/GOOGLE_CLOUD_PROJECT/);
    expect(err?.message).not.toContain("ya29.secret-token");
  });

  it("wires the project named by STITCH_PROJECT_ID on the API-key route", async () => {
    setEnv({ STITCH_PROJECT_ID: "p1", STITCH_API_KEY: "k" });
    const gen = createStitchGenerator({ quotaDir: quotaDir() });
    expect((await gen.generate("go")).id).toBe("p1-s1");
    expect(callTool).toHaveBeenCalledWith(
      "generate_screen_from_text",
      expect.objectContaining({ projectId: "p1", prompt: "go", deviceType: "MOBILE" }),
    );
  });

  it("accepts the OAuth route: access token plus GCP project, no API key", async () => {
    setEnv({ STITCH_PROJECT_ID: "p1", STITCH_ACCESS_TOKEN: "t", GOOGLE_CLOUD_PROJECT: "gcp" });
    const gen = createStitchGenerator({ quotaDir: quotaDir() });
    expect((await gen.generate("go")).id).toBe("p1-s1");
    expect(callTool).toHaveBeenCalledWith("generate_screen_from_text", expect.objectContaining({ projectId: "p1" }));
  });
});
