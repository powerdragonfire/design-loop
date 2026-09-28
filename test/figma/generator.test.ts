import { describe, expect, it } from "vitest";
import { FigmaClient, type FetchLike, type FetchResponse } from "../../src/figma/client.js";
import { DesignPending, FigmaGenerator, figmaMeasure, versionName } from "../../src/figma/generator.js";
import type { FigmaNode } from "../../src/figma/serialise.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

const NODE: FigmaNode = {
  id: "1:1",
  name: "Settings",
  type: "FRAME",
  absoluteBoundingBox: { x: 100, y: 0, width: 390, height: 800 },
  fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
  children: [
    {
      id: "1:2",
      name: "Sign out Button",
      type: "FRAME",
      absoluteBoundingBox: { x: 100, y: 10, width: 40, height: 20 },
    },
  ],
};

function stubFetch(handlers: Record<string, () => Partial<FetchResponse>>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    const r = handlers[key]!();
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: r.json ?? (async () => ({})),
      arrayBuffer: r.arrayBuffer ?? (async () => new ArrayBuffer(0)),
    };
  };
  return { fetch, calls };
}

const client = (fetch: FetchLike) => new FigmaClient("FILEKEY", "figd_secret", { fetch });

describe("FigmaClient", () => {
  it("reads a node's document subtree", async () => {
    const { fetch } = stubFetch({ "/files/": () => ({ json: async () => ({ nodes: { "1:1": { document: NODE } } }) }) });
    await expect(client(fetch).getNode("1:1")).resolves.toMatchObject({ id: "1:1", name: "Settings" });
  });

  it("treats an empty nodes map as a missing node, not a transport failure", async () => {
    // Figma answers 200 with {} for an id that is not in the file.
    const { fetch } = stubFetch({ "/files/": () => ({ json: async () => ({ nodes: {} }) }) });
    await expect(client(fetch).getNode("9:9")).rejects.toThrow("has no node 9:9");
  });

  it("never puts the token in the URL", async () => {
    const { fetch, calls } = stubFetch({ "/files/": () => ({ json: async () => ({ nodes: { "1:1": { document: NODE } } }) }) });
    await client(fetch).getNode("1:1");
    expect(calls.every((u) => !u.includes("figd_secret"))).toBe(true);
  });

  it("downloads the image in two hops and validates the PNG signature", async () => {
    const { fetch, calls } = stubFetch({
      "/images/": () => ({ json: async () => ({ images: { "1:1": "https://signed.example/a.png" } }) }),
      "signed.example": () => ({ arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) }),
    });
    await expect(client(fetch).getImage("1:1")).resolves.toBeInstanceOf(Buffer);
    expect(calls).toHaveLength(2);
  });

  it("rejects a body that is not a PNG", async () => {
    const notPng = Buffer.from("<html>error</html>");
    const { fetch } = stubFetch({
      "/images/": () => ({ json: async () => ({ images: { "1:1": "https://signed.example/a.png" } }) }),
      "signed.example": () => ({ arrayBuffer: async () => notPng.buffer.slice(notPng.byteOffset, notPng.byteOffset + notPng.length) }),
    });
    await expect(client(fetch).getImage("1:1")).rejects.toThrow("is not a PNG");
  });

  it("names the missing variable rather than failing obscurely", () => {
    expect(() => new FigmaClient("", "t")).toThrow("file key");
    expect(() => new FigmaClient("k", "")).toThrow("token");
  });
});

describe("FigmaGenerator", () => {
  const gen = (fetch: FetchLike) => new FigmaGenerator({ client: client(fetch) });

  it("suspends on generate rather than pretending to create a frame", async () => {
    const { fetch } = stubFetch({});
    const err = await gen(fetch).generate("Design a settings screen").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesignPending);
    const d = err as DesignPending;
    expect(d.version).toBe("v00");
    expect(d.parentNodeId).toBeNull();
    expect(d.prompt).toBe("Design a settings screen");
  });

  it("suspends on edit, naming the node to edit and the next version", async () => {
    const { fetch } = stubFetch({});
    const screen = gen(fetch).fromId("1:1");
    const err = await screen.edit("Make the toggle 44pt").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesignPending);
    const d = err as DesignPending;
    expect(d.version).toBe("v01");
    expect(d.parentNodeId).toBe("1:1");
  });

  it("refuses multiple candidates, the same way agent mode does", async () => {
    const { fetch } = stubFetch({});
    const g = gen(fetch);
    await expect(
      g.variants(g.fromId("1:1"), "p", { variantCount: 2, creativeRange: "EXPLORE", aspects: [] }),
    ).rejects.toThrow(/does not support multiple candidates/);
  });

  it("reads an existing frame back through fromId without asking for design work", async () => {
    const { fetch } = stubFetch({ "/files/": () => ({ json: async () => ({ nodes: { "1:1": { document: NODE } } }) }) });
    const html = await gen(fetch).fromId("1:1").getHtml();
    expect(JSON.parse(html)).toMatchObject({ id: "1:1" });
  });

  it("returns a distinct getHtml per frame, so the resume layer's hash index stays keyed", async () => {
    const other: FigmaNode = { ...NODE, id: "2:2", name: "Other" };
    const { fetch } = stubFetch({
      "/files/": () => ({
        json: async () => ({ nodes: { "1:1": { document: NODE }, "2:2": { document: other } } }),
      }),
    });
    const g = gen(fetch);
    const a = await g.fromId("1:1").getHtml();
    const b = await g.fromId("2:2").getHtml();
    expect(a).not.toBe(b);
  });
});

describe("figmaMeasure", () => {
  it("satisfies the measure seam and never touches Chromium", async () => {
    const doc = await figmaMeasure()(JSON.stringify(NODE));
    expect(doc.viewport).toEqual({ w: 390, h: 800 });
    expect(doc.nodes.map((n) => n.selector)).toEqual(["1:2"]);
    // frame-relative, not the canvas x=100
    expect(doc.nodes[0]!.bbox.x).toBe(0);
  });

  it("honours an explicit viewport so a 390pt frame is not measured against 393", async () => {
    const doc = await figmaMeasure({ viewport: { w: 393, h: 852 } })(JSON.stringify(NODE));
    expect(doc.viewport).toEqual({ w: 393, h: 852 });
  });

  it("says so plainly when handed HTML instead of a node tree", async () => {
    await expect(figmaMeasure()("<html><body></body></html>")).rejects.toThrow(/expected a serialised Figma node tree/);
  });
});

describe("versionName", () => {
  it("pads to the store's vNN convention", () => {
    expect([0, 1, 10].map(versionName)).toEqual(["v00", "v01", "v10"]);
  });
});
