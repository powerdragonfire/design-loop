import type { Config } from "../types.js";

export interface RoundRecord { version: string; composite: number; gatePass: boolean }
export type StopReason = "pass" | "converged" | "budget";

type Cfg = Pick<Config, "sigma" | "maxRounds" | "convergenceSigmas" | "convergenceRounds">;

export function decide(rounds: RoundRecord[], cfg: Cfg): { stop: StopReason | null; best: string } {
  if (cfg.sigma == null) throw new Error("sigma is null — run `design-loop calibrate` first");
  // Invalid numbers must throw: NaN makes every `>` false (so nothing is ever
  // progress and it converges instantly), and convergenceRounds <= 0 makes
  // `streak >= convergenceRounds` true with zero edits.
  if (!Number.isFinite(cfg.sigma) || cfg.sigma < 0)
    throw new Error(`invalid stop config: sigma must be a finite number >= 0, got ${cfg.sigma}`);
  if (!Number.isFinite(cfg.convergenceSigmas) || cfg.convergenceSigmas < 0)
    throw new Error(`invalid stop config: convergenceSigmas must be a finite number >= 0, got ${cfg.convergenceSigmas}`);
  if (!Number.isInteger(cfg.convergenceRounds) || cfg.convergenceRounds < 1)
    throw new Error(`invalid stop config: convergenceRounds must be an integer >= 1, got ${cfg.convergenceRounds}`);
  if (!Number.isInteger(cfg.maxRounds) || cfg.maxRounds < 1)
    throw new Error(`invalid stop config: maxRounds must be an integer >= 1, got ${cfg.maxRounds}`);
  if (rounds.length === 0) throw new Error("decide() needs at least one round");

  // best = highest composite; ties keep the earliest, so a later noisy
  // equal does not silently become the revert target.
  let best = rounds[0];
  for (const r of rounds.slice(1)) if (r.composite > best.composite) best = r;

  const last = rounds[rounds.length - 1];
  if (last.gatePass) return { stop: "pass", best: last.version };

  // A round is progress only if it beats the best BEFORE it by > 1 sigma.
  // Comparing to best-so-far rather than the previous round is what lets
  // 70 -> 75 -> 74 -> 88 survive the dip at 74.
  const margin = cfg.convergenceSigmas * cfg.sigma;
  let streak = 0;
  for (let i = 1; i < rounds.length; i++) {
    const priorBest = Math.max(...rounds.slice(0, i).map(r => r.composite));
    streak = rounds[i].composite > priorBest + margin ? 0 : streak + 1;
  }
  if (streak >= cfg.convergenceRounds) return { stop: "converged", best: best.version };

  // rounds.length counts v00..vN, so N edits have happened.
  if (rounds.length - 1 >= cfg.maxRounds) return { stop: "budget", best: best.version };

  return { stop: null, best: best.version };
}
