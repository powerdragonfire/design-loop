import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { loadContract } from "../contract/load.js";
import { readProject, type Project } from "../contract/project.js";
import { createFigmaClient } from "../figma/client.js";
import type { Contract } from "../types.js";
import { staleAgents } from "./agents.js";
import { readCalibration } from "./calibration.js";

export type CheckStatus = "ok" | "warn" | "fail";

/** One line of `check`: what was looked at, how it stands, and — for anything not ok — the command that fixes it. */
export interface CheckRow {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface CheckOptions {
  designDir: string;
  /** The screen about to be run, when there is one; its spec must exist. */
  screen?: string;
  agentsDir: string;
  /** Where the skills are installed; defaults to ~/.claude/skills. */
  skillsDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Skip the one network call (the Figma probe). */
  offline?: boolean;
  /** Replaced in tests; production asks Figma whether the token can read the file and page. */
  probeFigma?: (fileKey: string, nodeId?: string) => Promise<{ name: string; type: string }>;
}

export const SKILLS = ["design-loop", "design-setup", "start-design", "notion-design-sync"] as const;

/** Where a design-system document usually sits; `project.json` may name another. */
const DESIGN_DOCS = ["DESIGN.md", "design.md"];

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Every precondition a run has, checked at once and reported row by row instead of failing at the first.
 *
 * `loadContract` stops at the first problem by design — a run must not start on a broken contract — but a
 * person setting a folder up wants the whole list. So the contract is one row, and every check that does not
 * depend on it (credentials, agents, the skills, the project profile) still runs when it fails.
 *
 * Never throws for a problem in the folder: that is a `fail` row. Only a bug throws.
 */
export async function check(opts: CheckOptions): Promise<CheckRow[]> {
  const { designDir, screen, agentsDir } = opts;
  const env = opts.env ?? process.env;
  const rows: CheckRow[] = [];
  const add = (row: CheckRow): void => { rows.push(row); };

  if (!existsSync(designDir)) {
    add({ name: "design folder", status: "fail", detail: `${designDir} does not exist`, fix: "run /design-setup" });
    return rows;
  }

  // Contract. allowNullSigma so a missing calibration is its own row with its own fix, not a contract failure.
  let contract: Contract | null = null;
  try {
    contract = await loadContract(designDir, {}, undefined, { allowNullSigma: true });
    add({ name: "contract", status: "ok", detail: "config.json, tokens.json and brief.md load" });
  } catch (err) {
    add({ name: "contract", status: "fail", detail: message(err), fix: "fix the file it names, or run /design-setup" });
  }

  if (contract) {
    const names = Object.keys(contract.screens);
    if (screen !== undefined) {
      add(
        Object.hasOwn(contract.screens, screen)
          ? { name: "screen", status: "ok", detail: `screens/${screen}.md` }
          : {
              name: "screen", status: "fail", detail: `no screens/${screen}.md (have: ${names.join(", ") || "none"})`,
              fix: "write it with /start-design",
            },
      );
    } else {
      add({ name: "screens", status: names.length > 0 ? "ok" : "warn", detail: `${names.length} spec${names.length === 1 ? "" : "s"}${names.length ? `: ${names.join(", ")}` : ""}`, ...(names.length ? {} : { fix: "write one with /start-design" }) });
    }

    const cfg = contract.config;
    if (cfg.sigma === null) {
      add({ name: "sigma", status: "fail", detail: "not measured yet", fix: "design-loop calibrate" });
    } else {
      const warnings: string[] = [];
      const cal = await readCalibration(designDir, cfg, cfg.sigma, (line) => warnings.push(line.replace(/^WARNING: /, "")));
      add({ name: "sigma", status: "ok", detail: `${cfg.sigma.toFixed(2)}${cal ? `, measured ${cal.measuredAt.slice(0, 10)} (${cal.criticMode})` : ""}` });
      for (const w of warnings) add({ name: "calibration", status: "warn", detail: w, fix: "design-loop calibrate" });
    }

    if (cfg.criticMode === "agent") {
      const stale = await staleAgents({ outDir: agentsDir });
      add(
        stale.length === 0
          ? { name: "agents", status: "ok", detail: `critic and chair agents current in ${agentsDir}` }
          : { name: "agents", status: "fail", detail: `missing or out of date: ${stale.join(", ")}`, fix: "design-loop sync-agents" },
      );
    }

    if (cfg.generator === "figma" && cfg.figma) await figmaRows(cfg.figma, env, opts, add);
  }

  let project: Project | null = null;
  try {
    project = await readProject(designDir);
    add(
      project
        ? { name: "project", status: "ok", detail: `${project.app}${project.figma?.componentsPageId ? `, components page ${project.figma.componentsPageId}` : ""}` }
        : { name: "project", status: "warn", detail: "no project.json: briefs will ask for the app, pages and component sources", fix: "run /design-setup" },
    );
  } catch (err) {
    add({ name: "project", status: "fail", detail: message(err), fix: "run /design-setup --section project" });
  }
  if (project?.figma && contract?.config.figma && project.figma.fileKey !== contract.config.figma.fileKey) {
    add({
      name: "project", status: "warn",
      detail: `project.json names Figma file ${project.figma.fileKey} but config.json runs against ${contract.config.figma.fileKey}`,
      fix: "run /design-setup --section figma",
    });
  }

  add(await designDocRow(designDir, project, contract?.brief ?? null));

  const skillsDir = opts.skillsDir ?? join(homedir(), ".claude", "skills");
  const missingSkills = SKILLS.filter((s) => !existsSync(join(skillsDir, s, "SKILL.md")));
  add(
    missingSkills.length === 0
      ? { name: "skills", status: "ok", detail: `${SKILLS.join(", ")} installed` }
      : {
          name: "skills", status: "warn", detail: `not installed in ${skillsDir}: ${missingSkills.join(", ")}`,
          fix: `ln -s "$DESIGN_LOOP_HOME/skills/<name>" ${skillsDir}/<name> (see README, "Install the skills")`,
        },
  );
  return rows;
}

async function figmaRows(
  figma: { fileKey: string; pageId?: string }, env: NodeJS.ProcessEnv, opts: CheckOptions, add: (row: CheckRow) => void,
): Promise<void> {
  const token = env["FIGMA_TOKEN"] ?? env["FIGMA_ACCESS_TOKEN"];
  if (!token) {
    add({ name: "figma token", status: "fail", detail: "FIGMA_TOKEN is not set", fix: "export FIGMA_TOKEN=figd_… (scope: file_content:read)" });
    return;
  }
  add({ name: "figma token", status: "ok", detail: "FIGMA_TOKEN is set" });
  if (opts.offline) return;
  const probe = opts.probeFigma ?? ((fileKey: string, nodeId?: string) => createFigmaClient({ fileKey }).probe(nodeId));
  try {
    const file = await probe(figma.fileKey);
    add({ name: "figma file", status: "ok", detail: `${file.name || figma.fileKey} is readable` });
  } catch (err) {
    add({ name: "figma file", status: "fail", detail: message(err), fix: "check the fileKey in config.json and the token's file_content:read scope" });
    return;
  }
  if (!figma.pageId) {
    add({ name: "figma page", status: "warn", detail: "no pageId: design orders will not say where to build", fix: 'add "pageId" to config.json\'s figma block' });
    return;
  }
  try {
    const page = await probe(figma.fileKey, figma.pageId);
    add(
      page.type === "CANVAS"
        ? { name: "figma page", status: "ok", detail: `${page.name} (${figma.pageId})` }
        : { name: "figma page", status: "warn", detail: `${figma.pageId} is a ${page.type}, not a page`, fix: "set pageId to the page's id" },
    );
  } catch (err) {
    add({ name: "figma page", status: "fail", detail: message(err), fix: "set config.json figma.pageId to an existing page" });
  }
}

/**
 * The loop reads `brief.md`, never a design-system document. A folder that keeps its rules in `DESIGN.md`
 * and not in the brief is designing without them, so a document the brief never mentions is a warning.
 */
async function designDocRow(designDir: string, project: Project | null, brief: string | null): Promise<CheckRow> {
  const candidates = project?.designDoc ? [project.designDoc] : DESIGN_DOCS;
  const found = candidates.find((f) => existsSync(join(designDir, f)));
  if (!found) return { name: "design doc", status: "ok", detail: "none (optional)" };
  const named = brief !== null && brief.includes(basename(found));
  if (named) return { name: "design doc", status: "ok", detail: `${found}, referenced by brief.md` };
  // A brief can carry the rules without naming the file; the warning says what to check, not that it is wrong.
  const text = await readFile(join(designDir, found), "utf8").catch(() => "");
  return {
    name: "design doc", status: "warn",
    detail: `${found} (${text.split("\n").length} lines) is never read by the loop and brief.md does not mention it`,
    fix: "run /design-setup --section design-doc to fold its rules into brief.md",
  };
}

/** The table a person reads: one row per check, failures first so they are not scrolled past. */
export function formatRows(rows: CheckRow[]): string[] {
  const order: Record<CheckStatus, number> = { fail: 0, warn: 1, ok: 2 };
  const sorted = [...rows].sort((a, b) => order[a.status] - order[b.status]);
  const width = Math.max(...rows.map((r) => r.name.length));
  const lines = sorted.map((r) => {
    const head = `${r.status.toUpperCase().padEnd(4)} ${r.name.padEnd(width)}  ${r.detail}`;
    return r.fix ? `${head}\n${" ".repeat(width + 7)}fix: ${r.fix}` : head;
  });
  const fails = rows.filter((r) => r.status === "fail").length;
  const warns = rows.filter((r) => r.status === "warn").length;
  lines.push(fails ? `${fails} failing, ${warns} warning: fix the failures before \`run\`.` : `Ready${warns ? ` (${warns} warning${warns === 1 ? "" : "s"})` : ""}.`);
  return lines;
}
