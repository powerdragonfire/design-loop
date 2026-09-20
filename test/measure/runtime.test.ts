import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const script = fileURLToPath(new URL("../fixtures/measure-under-tsx.ts", import.meta.url));

describe("measure under the CLI's own loader", () => {
  // The body of page.evaluate() is serialised and re-parsed by the browser, so it may not reference
  // anything the transpiler left behind in the Node module scope. tsx compiles with esbuild's
  // keepNames, which rewrites every named function to `__name(fn, "fn")`; vitest does not, so this
  // whole class of failure is invisible to the other tests in this directory.
  it("measures a page without reaching for a Node-side helper", async () => {
    const { stdout } = await run(tsx, [script], { encoding: "utf8" });
    expect(JSON.parse(stdout.trim())).toEqual({ nodes: 1, effectiveBackground: "rgb(11, 11, 15)" });
  }, 60_000);
});
