import type { FigmaNode, FigmaNodeResponse } from "./serialise.js";

/** Minimal shape of the fetch we need, so tests inject one and the module has no global dependency. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponse>;

const API = "https://api.figma.com/v1";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Figma's REST API is READ-ONLY for designs: it serves a file's node tree and rendered images, and has
 * no endpoint that creates or edits a node. Writing happens through the Plugin API, which runs inside
 * Figma. That asymmetry is why the generator suspends for design work instead of calling out to it —
 * see FigmaGenerator.
 */
export class FigmaClient {
  private readonly fetchUrl: FetchLike;

  constructor(
    private readonly fileKey: string,
    private readonly token: string,
    opts: { fetch?: FetchLike } = {},
  ) {
    if (!fileKey) throw new Error("FigmaClient needs a file key");
    if (!token) throw new Error("FigmaClient needs a token");
    this.fetchUrl = opts.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponse>);
  }

  private headers(): Record<string, string> {
    // A personal access token goes in X-Figma-Token; an OAuth token goes in Authorization. Tokens are
    // never interpolated into a URL or an error message.
    return this.token.startsWith("figd_") || !this.token.includes(".")
      ? { "X-Figma-Token": this.token }
      : { Authorization: `Bearer ${this.token}` };
  }

  private async getJson(path: string, what: string): Promise<Record<string, unknown>> {
    const res = await this.fetchUrl(`${API}${path}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Figma ${what} failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * The node's subtree plus the component and component-set names its instances point at, as
   * `GET /v1/files/:key/nodes` returns them under `nodes[id]`. The names are what tells a tappable instance
   * from a decorative one (see `isInteractive`).
   *
   * No `geometry=paths`: nothing reads vector geometry, and this JSON is stored as `screen.html` and handed to
   * every critic — an icon-heavy frame's path strings could run to megabytes of context for no signal.
   */
  async getNode(nodeId: string): Promise<FigmaNodeResponse> {
    const body = await this.getJson(
      `/files/${encodeURIComponent(this.fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`,
      `node ${nodeId}`,
    );
    const nodes = body["nodes"] as Record<string, Partial<FigmaNodeResponse> | undefined> | undefined;
    const entry = nodes?.[nodeId];
    // Figma answers 200 with an empty `nodes` map for an id that does not exist in the file, so the
    // absent case has to be caught here rather than read as a transport failure.
    if (!entry?.document) throw new Error(`Figma has no node ${nodeId} in this file`);
    return {
      document: entry.document as FigmaNode,
      components: entry.components ?? {},
      componentSets: entry.componentSets ?? {},
    };
  }

  /** A rendered PNG of the node. Two hops: ask for a signed URL, then download it. */
  async getImage(nodeId: string, scale = 2): Promise<Buffer> {
    const body = await this.getJson(
      `/images/${encodeURIComponent(this.fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`,
      `image for ${nodeId}`,
    );
    const err = body["err"];
    if (err) throw new Error(`Figma image for ${nodeId} failed: ${String(err)}`);
    const images = body["images"] as Record<string, string | null> | undefined;
    const url = images?.[nodeId];
    if (!url) throw new Error(`Figma returned no image URL for ${nodeId}`);

    const res = await this.fetchUrl(url);
    if (!res.ok) throw new Error(`Figma image download for ${nodeId} failed: HTTP ${res.status}`);
    const png = Buffer.from(await res.arrayBuffer());
    // The critics send this to the model as image/png; a truncated or HTML error body would be
    // rejected there with a far less obvious message.
    if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error(`Figma image for ${nodeId} is not a PNG`);
    }
    return png;
  }
}

/**
 * Production wiring. Mirrors createStitchGenerator's contract: errors name the missing variable, never
 * its value.
 */
export function createFigmaClient(opts: { fileKey?: string; fetch?: FetchLike } = {}): FigmaClient {
  const fileKey = opts.fileKey ?? process.env["FIGMA_FILE_KEY"];
  const token = process.env["FIGMA_TOKEN"] ?? process.env["FIGMA_ACCESS_TOKEN"];
  if (!fileKey) throw new Error("FIGMA_FILE_KEY is not set; the Figma generator needs the file to read");
  if (!token) throw new Error("FIGMA_TOKEN is not set; the Figma generator needs a personal access token");
  return new FigmaClient(fileKey, token, { fetch: opts.fetch });
}
