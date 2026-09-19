import { describe, it, expect } from "vitest";
import { buildFirstPrompt } from "../../src/cli/prompt.js";

const contract: any = { brief: "BRIEF-TEXT", tokens: { color: { accent: { $value: "#FF7A1A" } } }, screens: { home: "SCREEN-SPEC" } };

describe("buildFirstPrompt", () => {
  it("carries the brief, the tokens and the screen spec, and the phone frame", () => {
    const p = buildFirstPrompt(contract, "home");
    expect(p).toContain("BRIEF-TEXT");
    expect(p).toContain("#FF7A1A");
    expect(p).toContain("SCREEN-SPEC");
    expect(p).toMatch(/393/);
    expect(p).toMatch(/portrait/i);
  });
  it("is deterministic", () => {
    expect(buildFirstPrompt(contract, "home")).toBe(buildFirstPrompt(contract, "home"));
  });
  it("throws for an unknown screen", () => {
    expect(() => buildFirstPrompt(contract, "nope")).toThrow(/no screen spec: nope/);
  });
});
