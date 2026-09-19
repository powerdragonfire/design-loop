import type { Contract } from "../types.js";

export function buildFirstPrompt(contract: Contract, screen: string): string {
  if (!Object.hasOwn(contract.screens, screen)) throw new Error(`no screen spec: ${screen}`);
  return [
    contract.brief.trim(),
    `Design tokens (use these exact values, invent no others):\n${JSON.stringify(contract.tokens, null, 2)}`,
    `Screen to design:\n${contract.screens[screen]!.trim()}`,
    "Design for a phone, 393 x 852 points, portrait only.",
  ].join("\n\n");
}
