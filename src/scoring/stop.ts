import type { Config } from "../types.js";

/**
 * One scored round. `blockers` and `majors` count the issues still open after it; they are optional so a record
 * built without them ranks and stops exactly as it did before issue counts were known (on composite alone).
 */
export interface RoundRecord { version: string; composite: number; gatePass: boolean; blockers?: number; majors?: number }
export type StopReason = "pass" | "converged" | "budget";

type Cfg = Pick<Config, "sigma" | "maxRounds" | "convergenceSigmas" | "convergenceRounds">;

/**
 * Open blockers, then open majors: fewer is better, compared in that order. The composite is a weighted mean of
 * four opinions and moves by ±sigma on an unchanged screen; a closed blocker is a fact the gate counts. So a
 * version that closed six blockers must outrank one that scored 0.3 higher with all six still open.
 */
function compareIssues(a: RoundRecord, b: RoundRecord): number {
  return (a.blockers ?? 0) - (b.blockers ?? 0) || (a.majors ?? 0) - (b.majors ?? 0);
}

/**
 * Negative when `a` ranks above `b`: a gate-passing version first, then fewer open blockers, then fewer open
 * majors, then the higher composite. The one ordering both the run's `best` and the manifest's `committeeRank`
 * use, so the report's "committee pick" and the version a regression rebuilds from cannot disagree.
 */
export function compareRounds(a: RoundRecord, b: RoundRecord): number {
  return Number(b.gatePass) - Number(a.gatePass) || compareIssues(a, b) || b.composite - a.composite;
}

/**
 * Whether `last` fell back from `best` far enough that the next edit should start from `best` instead: it left
 * more blockers or majors open, or the same issues with a composite more than `margin` lower.
 */
export function regressed(last: RoundRecord, best: RoundRecord, margin: number): boolean {
  if (last.version === best.version) return false;
  const issues = compareIssues(last, best);
  if (issues !== 0) return issues > 0;
  return last.composite < best.composite - margin;
}

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

  // best = the top of `compareRounds`; ties keep the earliest, so a later noisy
  // equal does not silently become the revert target.
  let best = rounds[0];
  for (const r of rounds.slice(1)) if (compareRounds(r, best) < 0) best = r;

  const last = rounds[rounds.length - 1];
  if (last.gatePass) return { stop: "pass", best: last.version };

  // A round is progress if it beats the best composite BEFORE it by > 1 sigma, or
  // leaves fewer blockers/majors open than any round before it. Comparing to
  // best-so-far rather than the previous round is what lets 70 -> 75 -> 74 -> 88
  // survive the dip at 74. The issue half is what keeps a run from "converging"
  // while the chair is still closing a blocker or a major every round: three
  // changes a round rarely move the composite past the noise floor.
  const margin = cfg.convergenceSigmas * cfg.sigma;
  let streak = 0;
  for (let i = 1; i < rounds.length; i++) {
    const prior = rounds.slice(0, i);
    const priorBest = Math.max(...prior.map(r => r.composite));
    const fewerIssues = prior.every(p => compareIssues(rounds[i], p) < 0);
    streak = rounds[i].composite > priorBest + margin || fewerIssues ? 0 : streak + 1;
  }
  if (streak >= cfg.convergenceRounds) return { stop: "converged", best: best.version };

  // rounds.length counts v00..vN, so N edits have happened.
  if (rounds.length - 1 >= cfg.maxRounds) return { stop: "budget", best: best.version };

  return { stop: null, best: best.version };
}
