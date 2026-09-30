import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../types.js";

/** The slice of `.design-loop/calibration.json` a run records and checks itself against (spec §18 step 3). */
export interface Calibration {
  sigma: number;
  criticModel: string;
  weights: Record<string, number>;
  measuredAt: string;
  criticMode: "api" | "agent";
}

const WEIGHT_EPSILON = 1e-9;

const sameWeights = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) <= WEIGHT_EPSILON);
};

const isCalibration = (v: unknown): v is Calibration => {
  const c = v as Partial<Calibration> | null;
  return (
    typeof c === "object" && c !== null &&
    typeof c.sigma === "number" && Number.isFinite(c.sigma) &&
    typeof c.criticModel === "string" &&
    typeof c.weights === "object" && c.weights !== null &&
    typeof c.measuredAt === "string" &&
    (c.criticMode === undefined || c.criticMode === "api" || c.criticMode === "agent")
  );
};

/**
 * Reads the calibration this design folder was last measured with, and says so when the run is about to be
 * judged against a noise floor that no longer describes it: another critic model, other weights, or a sigma
 * someone edited into config.json by hand. Never throws — a missing or corrupt file is a line in the log,
 * not a failed run, and `null` is what the manifest then records.
 */
export async function readCalibration(
  designDir: string,
  cfg: Config,
  sigma: number,
  log?: (line: string) => void,
): Promise<Calibration | null> {
  const file = join(designDir, ".design-loop", "calibration.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.(`WARNING: ${file} could not be read (${(err as Error).message}); this run's sigma is unverified`);
      return null;
    }
    log?.(`No calibration.json: sigma ${sigma} was set by hand; run \`design-loop calibrate\``);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isCalibration(parsed)) {
    log?.(`WARNING: ${file} is not a readable calibration; this run's sigma is unverified`);
    return null;
  }

  const cal: Calibration = {
    sigma: parsed.sigma,
    criticModel: parsed.criticModel,
    weights: parsed.weights,
    measuredAt: parsed.measuredAt,
    // An old calibration predates the field; it can only have been measured through the API.
    criticMode: parsed.criticMode ?? "api",
  };
  if (cfg.criticMode !== cal.criticMode) {
    log?.(
      `WARNING: sigma was calibrated in ${cal.criticMode} mode but this run uses ${cfg.criticMode} mode. ` +
        "Tool-using critics score differently, so this run's stopping rule rests on a noise floor that does " +
        "not describe it. Re-run `design-loop calibrate` in this mode; until then treat the stop reason with suspicion.",
    );
  }
  if (cfg.models.critic !== cal.criticModel) {
    log?.(
      `WARNING: sigma was calibrated with critic ${cal.criticModel} but this run uses ${cfg.models.critic}; ` +
        "re-run `design-loop calibrate`",
    );
  }
  if (!sameWeights(cfg.weights as unknown as Record<string, number>, cal.weights)) {
    log?.("WARNING: the weights have changed since sigma was calibrated; re-run `design-loop calibrate`");
  }
  if (Math.abs(sigma - cal.sigma) > WEIGHT_EPSILON) {
    log?.(
      `WARNING: config.json sigma ${sigma} differs from the calibrated ${cal.sigma}; ` +
        "re-run `design-loop calibrate` or restore the measured value",
    );
  }
  return cal;
}
