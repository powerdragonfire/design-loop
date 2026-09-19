import { describe, it, expect } from "vitest";
import { costUsd } from "../../src/cli/pricing.js";

const u = (inputTokens: number, outputTokens: number, cachedTokens: number) => ({ inputTokens, outputTokens, cachedTokens });

describe("costUsd", () => {
  it("prices Sonnet 5 at $2 in, $10 out, $0.20 cached per MTok", () => {
    expect(costUsd("claude-sonnet-5", u(1_000_000, 0, 0))).toBeCloseTo(2, 9);
    expect(costUsd("claude-sonnet-5", u(0, 1_000_000, 0))).toBeCloseTo(10, 9);
    expect(costUsd("claude-sonnet-5", u(0, 0, 1_000_000))).toBeCloseTo(0.2, 9);
  });
  it("prices Opus 5 at $5 in, $25 out, $0.50 cached per MTok", () => {
    expect(costUsd("claude-opus-5", u(1_000_000, 1_000_000, 1_000_000))).toBeCloseTo(30.5, 9);
  });
  it("prices Haiku 4.5 at $1 in, $5 out, $0.10 cached per MTok", () => {
    expect(costUsd("claude-haiku-4-5", u(1_000_000, 0, 0))).toBeCloseTo(1, 9);
    expect(costUsd("claude-haiku-4-5", u(0, 1_000_000, 0))).toBeCloseTo(5, 9);
    expect(costUsd("claude-haiku-4-5", u(0, 0, 1_000_000))).toBeCloseTo(0.1, 9);
  });
  it("throws for a model with no price rather than guessing", () => {
    expect(() => costUsd("claude-nope", u(1, 1, 1))).toThrow(/no price for model claude-nope/);
  });
});
