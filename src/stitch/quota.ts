import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Stitch's free tier: 550 generations a month. Edits count as generations. */
export const MONTHLY_LIMIT = 550;
const WARN_AT = 0.8 * MONTHLY_LIMIT;

interface QuotaState {
  month: string;
  used: number;
}

export interface QuotaStatus extends QuotaState {
  remaining: number;
  warn: boolean;
}

const currentMonth = (): string => new Date().toISOString().slice(0, 7);

/** First day of the month after `month` ("YYYY-MM"), which is when the free tier refills. */
function resetDate(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);
}

const quotaFile = (dir: string): string => join(dir, ".design-loop", "quota.json");

async function load(dir: string, month: string): Promise<QuotaState> {
  let raw: string;
  try {
    raw = await readFile(quotaFile(dir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { month, used: 0 };
    throw err;
  }
  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    state = null;
  }
  const s = state as Partial<QuotaState> | null;
  // A corrupt counter must not read as "nothing used": that would let a run overspend the quota unnoticed.
  if (!s || typeof s.month !== "string" || !Number.isInteger(s.used) || (s.used as number) < 0) {
    throw new Error(`Stitch quota file ${quotaFile(dir)} is corrupt; fix or delete it`);
  }
  return s.month === month ? { month, used: s.used as number } : { month, used: 0 };
}

function status({ month, used }: QuotaState): QuotaStatus {
  return { month, used, remaining: Math.max(0, MONTHLY_LIMIT - used), warn: used >= WARN_AT };
}

export async function readQuota(dir: string, month: string = currentMonth()): Promise<QuotaStatus> {
  return status(await load(dir, month));
}

// Serialises read-modify-write per file, so two concurrent reservations in one process cannot lose an update.
const queues = new Map<string, Promise<unknown>>();

/**
 * Counts `n` generations against this month's quota. Throws, and writes nothing, when that would pass the limit,
 * so callers reserve BEFORE spending the generation.
 */
export function reserve(dir: string, n: number): Promise<void> {
  const file = quotaFile(dir);
  const run = async (): Promise<void> => {
    if (!Number.isInteger(n) || n < 0) throw new Error(`Cannot reserve ${n} generations`);
    const { month, used } = await load(dir, currentMonth());
    if (used + n > MONTHLY_LIMIT) {
      throw new Error(
        `Stitch quota exhausted: ${used} of ${MONTHLY_LIMIT} used this month, resets ${resetDate(month)}`,
      );
    }
    await mkdir(join(dir, ".design-loop"), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ month, used: used + n }));
    await rename(tmp, file);
  };
  const next = (queues.get(file) ?? Promise.resolve()).then(run, run);
  queues.set(file, next.catch(() => {}));
  return next;
}
