import { describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAgents } from "../../src/cli/agents.js";
import { check, formatRows, SKILLS, type CheckRow } from "../../src/cli/check.js";
import { main } from "../../src/cli/main.js";

const FIX = new URL("../fixtures/design/", import.meta.url).pathname;

const folder = (config: Record<string, unknown> = {}) => {
  const d = mkdtempSync(join(tmpdir(), "dl-check-"));
  cpSync(FIX, d, { recursive: true, filter: (src) => !src.includes(".design-loop") });
  const file = join(d, "config.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...config }));
  return d;
};

const skills = (names: readonly string[] = SKILLS) => {
  const d = mkdtempSync(join(tmpdir(), "dl-skills-"));
  for (const n of names) {
    mkdirSync(join(d, n));
    writeFileSync(join(d, n, "SKILL.md"), "---\nname: x\n---\n");
  }
  return d;
};

const row = (rows: CheckRow[], name: string) => rows.filter((r) => r.name === name);
const status = (rows: CheckRow[], name: string) => row(rows, name).map((r) => r.status);

const FIGMA = { generator: "figma", criticMode: "agent", figma: { fileKey: "FILE", pageId: "266:2" } };

describe("check", () => {
  it("reports a missing design folder as one failing row", async () => {
    const rows = await check({ designDir: "/no/such/dir", agentsDir: "/tmp" });
    expect(rows).toEqual([expect.objectContaining({ name: "design folder", status: "fail" })]);
  });

  it("passes a sound API-mode folder, warning only about what is optional", async () => {
    const rows = await check({ designDir: folder(), agentsDir: "/tmp", skillsDir: skills(), screen: "home" });
    expect(rows.filter((r) => r.status === "fail")).toEqual([]);
    expect(status(rows, "screen")).toEqual(["ok"]);
    expect(status(rows, "project")).toEqual(["warn"]);
    expect(row(rows, "agents")).toEqual([]); // API mode dispatches no agents
  });

  it("keeps checking after a broken contract, so one run lists every problem", async () => {
    const d = folder();
    rmSync(join(d, "tokens.json"));
    const rows = await check({ designDir: d, agentsDir: "/tmp", skillsDir: skills([]) });
    expect(row(rows, "contract")[0]).toMatchObject({ status: "fail", detail: expect.stringMatching(/tokens\.json/) });
    expect(status(rows, "skills")).toEqual(["warn"]);
    expect(status(rows, "project")).toEqual(["warn"]);
  });

  it("fails a null sigma and an unknown screen, naming the fix and the screens there are", async () => {
    const rows = await check({ designDir: folder({ sigma: null }), agentsDir: "/tmp", skillsDir: skills(), screen: "nope" });
    expect(row(rows, "sigma")[0]).toMatchObject({ status: "fail", fix: "design-loop calibrate" });
    expect(row(rows, "screen")[0]).toMatchObject({ status: "fail", detail: expect.stringContaining("have: home") });
  });

  it("checks Figma: agents, token, file and page, without a real network call", async () => {
    const agentsDir = mkdtempSync(join(tmpdir(), "dl-agents-"));
    await syncAgents({ outDir: agentsDir });
    const probeFigma = vi.fn(async (_key: string, node?: string) =>
      node === undefined ? { name: "Spontai (Copy)", type: "FILE" } : { name: "Form", type: "CANVAS" });
    const rows = await check({
      designDir: folder(FIGMA), agentsDir, skillsDir: skills(), env: { FIGMA_TOKEN: "figd_x" }, probeFigma,
    });
    expect(status(rows, "agents")).toEqual(["ok"]);
    expect(row(rows, "figma file")[0]!.detail).toContain("Spontai (Copy)");
    expect(row(rows, "figma page")[0]!.detail).toBe("Form (266:2)");
    expect(probeFigma).toHaveBeenCalledWith("FILE", "266:2");
  });

  it("fails a missing token and stale agents, and skips the probe offline", async () => {
    const probeFigma = vi.fn();
    const rows = await check({ designDir: folder(FIGMA), agentsDir: mkdtempSync(join(tmpdir(), "dl-empty-")), skillsDir: skills(), env: {}, probeFigma, offline: true });
    expect(row(rows, "figma token")[0]).toMatchObject({ status: "fail" });
    expect(status(rows, "agents")).toEqual(["fail"]);
    expect(probeFigma).not.toHaveBeenCalled();
  });

  it("reports an unreachable page as a failure with the probe's reason", async () => {
    const probeFigma = vi.fn(async (_key: string, node?: string) => {
      if (node) throw new Error("Figma has no node 266:2 in this file");
      return { name: "F", type: "FILE" };
    });
    const rows = await check({ designDir: folder(FIGMA), agentsDir: "/tmp", skillsDir: skills(), env: { FIGMA_TOKEN: "t" }, probeFigma });
    expect(row(rows, "figma page")[0]).toMatchObject({ status: "fail", detail: "Figma has no node 266:2 in this file" });
  });

  it("warns when DESIGN.md exists but brief.md never mentions it", async () => {
    const d = folder();
    writeFileSync(join(d, "DESIGN.md"), "# Spontai design system\n");
    expect(status(await check({ designDir: d, agentsDir: "/tmp", skillsDir: skills() }), "design doc")).toEqual(["warn"]);
    writeFileSync(join(d, "brief.md"), `${readFileSync(join(d, "brief.md"), "utf8")}\nRules from DESIGN.md apply.\n`);
    expect(status(await check({ designDir: d, agentsDir: "/tmp", skillsDir: skills() }), "design doc")).toEqual(["ok"]);
  });

  it("reads project.json, and flags one that points at another Figma file", async () => {
    const d = folder(FIGMA);
    writeFileSync(join(d, "project.json"), JSON.stringify({ app: "Spontai", figma: { fileKey: "OTHER", componentsPageId: "2012:554" } }));
    const rows = await check({ designDir: d, agentsDir: "/tmp", skillsDir: skills(), env: {}, offline: true });
    expect(row(rows, "project").map((r) => r.status)).toEqual(["ok", "warn"]);
    expect(row(rows, "project")[0]!.detail).toBe("Spontai, components page 2012:554");

    writeFileSync(join(d, "project.json"), JSON.stringify({ figma: {} }));
    const broken = await check({ designDir: d, agentsDir: "/tmp", skillsDir: skills(), env: {}, offline: true });
    expect(row(broken, "project")[0]).toMatchObject({ status: "fail", detail: expect.stringMatching(/^invalid project\.json: app/) });
  });

  it("formats failures first and ends with a verdict", () => {
    const lines = formatRows([
      { name: "contract", status: "ok", detail: "fine" },
      { name: "sigma", status: "fail", detail: "not measured yet", fix: "design-loop calibrate" },
    ]);
    expect(lines[0]).toMatch(/^FAIL sigma/);
    expect(lines.at(-1)).toBe("1 failing, 0 warning: fix the failures before `run`.");
  });
});

describe("the check command", () => {
  it("exits 1 on a failure and prints JSON with --json", async () => {
    const out: string[] = [];
    const code = await main(["--design", folder({ sigma: null }), "check", "--json", "--offline"], { out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(1);
    expect(JSON.parse(out.join("\n")).find((r: CheckRow) => r.name === "sigma").status).toBe("fail");
  });

  it("refuses run-only flags on other commands, and --from with --seed", async () => {
    const err: string[] = [];
    const io = { out: () => {}, err: (l: string) => err.push(l) };
    expect(await main(["check", "--direction", "1"], io)).toBe(2);
    expect(await main(["run", "home", "--from", "1:2", "--seed", "1:3"], io)).toBe(2);
    expect(await main(["run", "home", "--from", "not-an-id"], io)).toBe(2);
    expect(await main(["run", "home", "--direction", "-1"], io)).toBe(2);
    expect(err.join("\n")).toMatch(/--direction only applies to `run`/);
  });

  it("refuses --from on a Stitch folder", async () => {
    const err: string[] = [];
    const code = await main(["--design", folder(), "run", "home", "--from", "1:2"], { out: () => {}, err: (l) => err.push(l) }, { preflight: async () => {} });
    expect(code).toBe(2);
    expect(err[0]).toMatch(/need "generator": "figma"/);
  });
});
