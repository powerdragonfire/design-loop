import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGenerator, StitchGenerator } from "../../src/stitch/adapter.js";
import { StitchProjectionError } from "../../src/stitch/sdk.js";
import { readQuota, reserve, MONTHLY_LIMIT } from "../../src/stitch/quota.js";

describe("FakeGenerator", () => {
  it("returns scripted screens in order", async () => {
    const g = new FakeGenerator([
      { html: "<p>a</p>", png: Buffer.from("a") },
      { html: "<p>b</p>", png: Buffer.from("b") },
    ]);
    const s0 = await g.generate("go");
    expect(await s0.getHtml()).toBe("<p>a</p>");
    const s1 = await s0.edit("fix");
    expect(await s1.getHtml()).toBe("<p>b</p>");
  });

  it("records every prompt it was given", async () => {
    const g = new FakeGenerator([{ html: "x", png: Buffer.from("") }, { html: "y", png: Buffer.from("") }]);
    await (await g.generate("first")).edit("second");
    expect(g.prompts).toEqual(["first", "second"]);
  });

  it("throws when the script runs out, rather than repeating silently", async () => {
    const g = new FakeGenerator([{ html: "x", png: Buffer.from("") }]);
    await expect((await g.generate("a")).edit("b")).rejects.toThrow(/script exhausted/);
  });
});

// The installed @google/stitch-sdk (0.3.5) returns DOWNLOAD URLs, not content:
// Screen.getHtml() and Screen.getImage() both resolve to a URL string (or "" when
// the response lacks one). StitchGenerator must therefore fetch both.
describe("StitchGenerator", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dl-")); });

  const sdkScreen = (over: Record<string, any> = {}): any => ({
    id: "s1",
    getHtml: async () => "https://x/html",
    getImage: async () => "https://x/img",
    edit: vi.fn(async () => sdkScreen({ id: "s2" })),
    ...over,
  });
  const res = (body: Buffer | string, status = 200) => {
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    return { ok: status >= 200 && status < 300, status, text: async () => buf.toString("utf8"),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  const okFetch = () => vi.fn(async (url: string) => (url.endsWith("html") ? res("<p>hi</p>") : res(PNG)));
  const make = (project: any, extra: Record<string, any> = {}) => {
    const sleeps: number[] = [];
    const fetch = extra.fetch ?? okFetch();
    const projectStub = { variants: async () => [], ...project };
    const gen = new StitchGenerator({ project: projectStub, quotaDir: dir, fetch, sleep: async (ms: number) => { sleeps.push(ms); }, ...extra });
    return { gen, sleeps, fetch };
  };

  it("downloads the HTML and image URLs the SDK returns", async () => {
    const { gen } = make({ generate: vi.fn(async () => sdkScreen()) });
    const s = await gen.generate("go");
    expect(await s.getHtml()).toBe("<p>hi</p>");
    expect((await s.getImage()).equals(PNG)).toBe(true);
  });

  it("asks for a MOBILE screen, and passes the model id when configured", async () => {
    const generate = vi.fn(async () => sdkScreen());
    const a = make({ generate });
    const s = await a.gen.generate("go");
    expect(generate).toHaveBeenCalledWith("go", "MOBILE", undefined);
    await s.edit("fix");
    const b = make({ generate }, { modelId: "GEMINI_3_PRO" });
    await b.gen.generate("go");
    expect(generate).toHaveBeenLastCalledWith("go", "MOBILE", "GEMINI_3_PRO");
  });

  it("wraps the edited screen and reserves quota for it as well", async () => {
    const inner = sdkScreen();
    const { gen } = make({ generate: vi.fn(async () => inner) });
    const s = await gen.generate("go");
    const edited = await s.edit("fix");
    expect(inner.edit).toHaveBeenCalledWith(expect.stringContaining("fix"), "MOBILE", undefined);
    expect(await edited.getHtml()).toBe("<p>hi</p>");
    expect((await readQuota(dir)).used).toBe(2);
  });

  // A small edit otherwise comes back as a dom_operations patch with no screen to download, and
  // `get_screen` cannot recover it; asking for the whole screen is what keeps a round fetchable.
  it("asks Stitch for the whole screen, so a small edit is not answered with a DOM patch", async () => {
    const inner = sdkScreen();
    const { gen } = make({ generate: vi.fn(async () => inner) });
    await (await gen.generate("go")).edit("Make exactly these 1 changes and nothing else: raise the caption to 14px.");
    const sent = inner.edit.mock.calls[0]![0] as string;
    expect(sent).toContain("Make exactly these 1 changes and nothing else: raise the caption to 14px.");
    expect(sent).toMatch(/complete updated screen, not a partial edit/);
  });

  it("reserves one generation per variant returned, and wraps each", async () => {
    const inner = sdkScreen();
    const variants = vi.fn(async () => [sdkScreen({ id: "v1" }), sdkScreen({ id: "v2" })]);
    const { gen } = make({ generate: vi.fn(async () => inner), variants });
    const seed = await gen.generate("go");
    const out = await gen.variants(seed, "vary it", { variantCount: 2, creativeRange: "EXPLORE", aspects: ["LAYOUT"] });
    expect(variants).toHaveBeenCalledWith("s1", "vary it", { variantCount: 2, creativeRange: "EXPLORE", aspects: ["LAYOUT"] }, "MOBILE", undefined);
    expect(out.map((s) => s.id)).toEqual(["v1", "v2"]);
    expect((await readQuota(dir)).used).toBe(3); // 1 seed + 2 variants
  });

  it("never calls the SDK's variants when the quota is exhausted", async () => {
    const variants = vi.fn(async () => [sdkScreen({ id: "v1" })]);
    await reserve(dir, MONTHLY_LIMIT);
    const { gen } = make({ generate: vi.fn(async () => sdkScreen()), variants });
    const seed: any = { id: "s1" };
    await expect(gen.variants(seed, "vary it", { variantCount: 1, creativeRange: "EXPLORE", aspects: [] })).rejects.toThrow(/quota/i);
    expect(variants).not.toHaveBeenCalled();
  });

  it("reserves only what was actually returned when Stitch answers with fewer variants than asked", async () => {
    const variants = vi.fn(async () => [sdkScreen({ id: "v1" })]);
    const { gen } = make({ generate: vi.fn(async () => sdkScreen()), variants });
    const seed = await gen.generate("go");
    const out = await gen.variants(seed, "vary it", { variantCount: 3, creativeRange: "EXPLORE", aspects: [] });
    expect(out.map((s) => s.id)).toEqual(["v1"]);
    expect((await readQuota(dir)).used).toBe(2); // 1 seed + 1 variant actually made, not 3
  });

  it("does not retry a variants projection failure, and reserves only the one unit spent up front", async () => {
    const variants = vi.fn(async () => { throw new StitchProjectionError("generate_variants", "0 screens across them"); });
    const { gen } = make({ generate: vi.fn(async () => sdkScreen()), variants });
    const seed = await gen.generate("go");
    await expect(gen.variants(seed, "vary it", { variantCount: 2, creativeRange: "EXPLORE", aspects: [] })).rejects.toThrow(
      StitchProjectionError,
    );
    expect(variants).toHaveBeenCalledTimes(1);
    expect((await readQuota(dir)).used).toBe(2); // 1 seed + 1 unit reserved before the failed call
  });

  it("reserves one generation before calling the SDK", async () => {
    const { gen } = make({ generate: vi.fn(async () => sdkScreen()) });
    await gen.generate("go");
    expect((await readQuota(dir)).used).toBe(1);
  });

  it("never calls the SDK when the quota is exhausted", async () => {
    const generate = vi.fn(async () => sdkScreen());
    await reserve(dir, MONTHLY_LIMIT);
    const { gen } = make({ generate });
    await expect(gen.generate("go")).rejects.toThrow(/quota/i);
    expect(generate).not.toHaveBeenCalled();
  });

  it("retries a failing call twice with 1s then 4s backoff, rethrows the last error, and reserves once", async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(new Error("e1")).mockRejectedValueOnce(new Error("e2")).mockRejectedValueOnce(new Error("e3"));
    const { gen, sleeps } = make({ generate });
    await expect(gen.generate("go")).rejects.toThrow("e3");
    expect(generate).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 4000]);
    expect((await readQuota(dir)).used).toBe(1);
  });

  it("tells onRetry what is being retried, which attempt is next, and how long it waits", async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(new Error("e1")).mockRejectedValueOnce(new Error("e2")).mockRejectedValueOnce(new Error("e3"));
    const seen: unknown[] = [];
    const { gen } = make({ generate }, { onRetry: (r: unknown) => seen.push(r) });
    await expect(gen.generate("go")).rejects.toThrow("e3");
    expect(seen).toEqual([
      { what: "generate", attempt: 2, of: 3, waitMs: 1000, error: "e1" },
      { what: "generate", attempt: 3, of: 3, waitMs: 4000, error: "e2" },
    ]);
  });

  it("succeeds after one transient failure", async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce(sdkScreen());
    const { gen, sleeps } = make({ generate });
    const s = await gen.generate("go");
    expect(sleeps).toEqual([1000]);
    expect(await s.getHtml()).toBe("<p>hi</p>");
  });

  it("throws when the SDK returns an empty download URL", async () => {
    const { gen } = make({ generate: vi.fn(async () => sdkScreen({ getHtml: async () => "" })) });
    const s = await gen.generate("go");
    await expect(s.getHtml()).rejects.toThrow(/empty/i);
  });

  it("throws when the downloaded image is not a PNG (the critics send image/png)", async () => {
    const fetch = vi.fn(async (url: string) => (url.endsWith("html") ? res("<p/>") : res(JPEG)));
    const { gen } = make({ generate: vi.fn(async () => sdkScreen()) }, { fetch });
    const s = await gen.generate("go");
    await expect(s.getImage()).rejects.toThrow(/PNG/);
  });

  it("labels a download retry with what is being downloaded", async () => {
    let n = 0;
    const flaky = vi.fn(async (_url: string) => (++n === 1 ? res("slow down", 429) : res("<p>ok</p>")));
    const seen: string[] = [];
    const { gen } = make({ generate: vi.fn(async () => sdkScreen()) }, { fetch: flaky, onRetry: (r: { what: string }) => seen.push(r.what) });
    const s = await gen.generate("go");
    await s.getHtml();
    expect(seen).toEqual(["HTML download"]);
  });

  it("does not retry a 4xx download", async () => {
    const fetch = vi.fn(async () => res("denied", 403));
    const { gen, sleeps } = make({ generate: vi.fn(async () => sdkScreen()) }, { fetch });
    const s = await gen.generate("go");
    await expect(s.getHtml()).rejects.toThrow(/403/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("retries a 429 download and a body read that fails mid-stream", async () => {
    let n = 0;
    const flaky = vi.fn(async (_url: string) => {
      n++;
      if (n === 1) return res("slow down", 429);
      if (n === 2) return { ok: true, status: 200,
        text: async () => { throw new Error("socket hang up"); },
        arrayBuffer: async () => { throw new Error("socket hang up"); } };
      return res("<p>ok</p>");
    });
    const { gen, sleeps } = make({ generate: vi.fn(async () => sdkScreen()) }, { fetch: flaky });
    const s = await gen.generate("go");
    expect(await s.getHtml()).toBe("<p>ok</p>");
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 4000]);
  });

  it("names the screen and never the signed URL when a download rejects outright", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("Failed to parse URL from https://x/img?token=SECRET"); });
    const { gen } = make({ generate: vi.fn(async () => sdkScreen()) }, { fetch });
    const s = await gen.generate("go");
    const err = await s.getHtml().then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("screen s1");
    expect(err!.message).toContain("TypeError");
    expect(err!.message).not.toContain("SECRET");
    expect(err!.message).not.toContain("https://");
  });

  it("gives every download a timeout signal, so a hung transfer cannot hang the run", async () => {
    const inits: ({ signal?: AbortSignal } | undefined)[] = [];
    const fetch = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      inits.push(init);
      return url.endsWith("html") ? res("<p>hi</p>") : res(PNG);
    });
    const { gen } = make({ generate: vi.fn(async () => sdkScreen()) }, { fetch });
    await (await gen.generate("go")).getHtml();
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(inits[0]!.signal!.aborted).toBe(false);
  });

  it("cancels the body of a refused download instead of leaving the socket open", async () => {
    const cancel = vi.fn(async () => {});
    const fetch = vi.fn(async () => ({ ...res("denied", 403), body: { cancel } }));
    const { gen } = make({ generate: vi.fn(async () => sdkScreen()) }, { fetch });
    const s = await gen.generate("go");
    await expect(s.getHtml()).rejects.toThrow(/403/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("reads the body away when a refused response exposes no stream to cancel", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const fetch = vi.fn(async () => ({ ok: false, status: 403, text: async () => "denied", arrayBuffer }));
    const { gen } = make({ generate: vi.fn(async () => sdkScreen()) }, { fetch });
    const s = await gen.generate("go");
    await expect(s.getHtml()).rejects.toThrow(/403/);
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx download twice with backoff", async () => {
    const fetch = vi.fn(async () => res("down", 503));
    const { gen, sleeps } = make({ generate: vi.fn(async () => sdkScreen()) }, { fetch });
    const s = await gen.generate("go");
    await expect(s.getHtml()).rejects.toThrow(/503/);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 4000]);
  });
  // edit_screens documents "DO NOT RETRY", and a projection miss usually means the edit did happen
  // server-side: retrying spends quota making screens nobody asked for. The live smoke run burned 2:54
  // and two extra generations this way before failing anyway.
  it("does not retry a projection failure, and never says it is retrying one", async () => {
    const generate = vi.fn(async () => { throw new StitchProjectionError("edit_screens", "0 screens across them"); });
    const seen: unknown[] = [];
    const { gen, sleeps } = make({ generate }, { onRetry: (r: unknown) => seen.push(r) });
    await expect(gen.generate("go")).rejects.toThrow("edit_screens returned no screen: 0 screens across them");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(seen).toEqual([]);
  });

  describe("onPrompt", () => {
    it("reports what is about to be sent, for a generate and for an edit", async () => {
      const seen: unknown[] = [];
      const { gen } = make({ generate: vi.fn(async () => sdkScreen()) }, { onPrompt: (p: unknown) => seen.push(p) });
      await (await gen.generate("a simple mobile login screen")).edit("make the button larger");
      expect(seen).toEqual([
        { what: "generate", prompt: "a simple mobile login screen" },
        { what: "edit", prompt: "make the button larger" },
      ]);
    });

    // Fires before the reservation, so an exhausted quota still says what it refused to send.
    it("reports the prompt even when the quota refuses the call", async () => {
      await reserve(dir, MONTHLY_LIMIT);
      const seen: unknown[] = [];
      const { gen } = make({ generate: vi.fn() }, { onPrompt: (p: unknown) => seen.push(p) });
      await expect(gen.generate("go")).rejects.toThrow(/quota/i);
      expect(seen).toEqual([{ what: "generate", prompt: "go" }]);
    });

    it("announces the variant prompt before it is sent", async () => {
      const seen: unknown[] = [];
      const { gen } = make(
        { generate: vi.fn(async () => sdkScreen()), variants: vi.fn(async () => [sdkScreen({ id: "v1" })]) },
        { onPrompt: (p: unknown) => seen.push(p) },
      );
      const seed = await gen.generate("go");
      await gen.variants(seed, "vary it", { variantCount: 1, creativeRange: "REFINE", aspects: [] });
      expect(seen).toEqual([{ what: "generate", prompt: "go" }, { what: "variants", prompt: "vary it" }]);
    });
  });
});
