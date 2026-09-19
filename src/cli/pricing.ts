import type { Usage } from "../types.js";

interface Price { in: number; out: number; cacheRead: number }

// USD per million tokens, from the Claude API pricing table as cached 2026-06-24. Verify against the
// pricing page before trusting the manifest's `usd`. Cached tokens bill at 0.1x the input rate.
export const PRICES: Record<string, Price> = {
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2 },
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5 },
  // Available as a critic but not recommended (spec §13); priced so choosing it is not a crash.
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1 },
};

export function costUsd(model: string, usage: Usage): number {
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (!price) throw new Error(`no price for model ${model} — add it to PRICES`);
  return (usage.inputTokens * price.in + usage.outputTokens * price.out + usage.cachedTokens * price.cacheRead) / 1e6;
}
