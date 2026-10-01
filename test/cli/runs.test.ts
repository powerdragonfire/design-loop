import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { figmaFrameUrl, formatRuns, listRuns } from "../../src/cli/runs.js";
import { main } from "../../src/cli/main.js";

const put = (file: string, body: unknown) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
};
const issue = (severity: string) => ({ id: `x-${severity}`, severity, evidence: { selector: "A" }, claim: "c", fix: "f" });

const folder = () => {
  const d = mkdtempSync(join(tmpdir(), "dl-runs-"));
  put(join(d, "screens", "join-trip.md"), "# Join trip\n\nBody.\n");

  const done = join(d, "runs", "2026-09-30-join-trip");
  put(join(done, "v00", "composite.json"), { composite: 81.65, gatePass: false });
  put(join(done, "v00", "open-issues.json"), [issue("blocker"), issue("major"), issue("major"), issue("minor")]);
  put(join(done, "v00", "screen-id.txt"), "2110-3800\n");
  put(join(done, "v01", "composite.json"), { composite: 87.7, gatePass: true });
  put(join(done, "v01", "open-issues.json"), [issue("minor")]);
  put(join(done, "v01", "screen-id.txt"), "2110:3873\n");
  put(join(done, "manifest.json"), {
    screen: "join-trip", date: "2026-09-30", stopReason: "pass", best: "v01", committeeRank: ["v01", "v00"],
    humanPick: "v01", agreedWithTop: true,
  });
  put(join(done, "report.html"), "<html></html>");
  put(join(done, "start.json"), { direction: 1 });

  const waiting = join(d, "runs", "2026-10-01-join-trip--expired-2");
  put(join(waiting, "v00", "work-order.json"), { kind: "design" });
  put(join(d, "runs", "notes.txt"), "not a run");
  return d;
};

describe("listRuns", () => {
  it("summarises a finished run and a waiting one from their directories", async () => {
    const [done, waiting] = await listRuns(folder());
    expect(done).toMatchObject({
      key: "2026-09-30-join-trip", screen: "join-trip", state: "done", stopReason: "pass", best: "v01",
      title: "Join trip", approved: { version: "v01", agreedWithTop: true }, start: { direction: 1 },
    });
    expect(done!.versions).toEqual([
      { version: "v00", composite: 81.65, gatePass: false, blockers: 1, majors: 2, frameId: "2110:3800" },
      { version: "v01", composite: 87.7, gatePass: true, blockers: 0, majors: 0, frameId: "2110:3873" },
    ]);
    expect(done!.report).toMatch(/report\.html$/);
    expect(waiting).toMatchObject({
      key: "2026-10-01-join-trip--expired-2", screen: "join-trip--expired", state: "waiting", waitingOn: "design", waitingVersion: "v00",
      versions: [{ version: "v00" }], start: {},
    });
  });

  it("returns nothing for a folder with no runs, and survives a corrupt manifest", async () => {
    expect(await listRuns(mkdtempSync(join(tmpdir(), "dl-none-")))).toEqual([]);
    const d = folder();
    writeFileSync(join(d, "runs", "2026-09-30-join-trip", "manifest.json"), "{ not json");
    const [run] = await listRuns(d);
    expect(run!.state).toBe("waiting");
  });

  it("formats one line per run and builds Figma frame links", async () => {
    expect(formatRuns(await listRuns(folder()))).toEqual([
      "2026-09-30-join-trip  pass · best v01 87.7 · approved v01",
      "2026-10-01-join-trip--expired-2  waiting on design (v00)",
    ]);
    expect(figmaFrameUrl("Hd1q", "2110:3873")).toBe("https://www.figma.com/design/Hd1q/?node-id=2110-3873");
  });

  it("prints JSON with frame links when the config names a Figma file", async () => {
    const d = folder();
    const fixture = new URL("../fixtures/design/", import.meta.url).pathname;
    for (const f of ["tokens.json", "brief.md"]) put(join(d, f), (await import("node:fs")).readFileSync(join(fixture, f), "utf8"));
    const cfg = JSON.parse((await import("node:fs")).readFileSync(join(fixture, "config.json"), "utf8"));
    put(join(d, "config.json"), { ...cfg, criticMode: "agent", generator: "figma", figma: { fileKey: "FILE" } });
    const out: string[] = [];
    expect(await main(["--design", d, "runs", "--json"], { out: (l) => out.push(l), err: () => {} })).toBe(0);
    const runs = JSON.parse(out.join("\n"));
    expect(runs[0].versions[1].frameUrl).toBe("https://www.figma.com/design/FILE/?node-id=2110-3873");
  });
});
