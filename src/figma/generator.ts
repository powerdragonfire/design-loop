import type { MeasuredDoc } from "../types.js";
import type { Generator, Screen, VariantOptions } from "../stitch/adapter.js";
import type { FigmaClient } from "./client.js";
import { serialise, type FigmaNode, type SerialiseOptions } from "./serialise.js";

/**
 * Not a failure: the run cannot continue until a frame exists in Figma. Figma's REST API cannot create
 * or edit nodes — that is the Plugin API, which runs inside Figma — so design work is handed back to
 * the driving session exactly as agent-mode critiques are handed to subagents.
 *
 * The generator does not know which round it is on, and must not guess: after a regression the loop edits
 * the BEST version's handle, so "the next version" is not "the parent plus one". The resume layer, which
 * owns the round cursor, stamps the version through `at()` before the error reaches `step`.
 */
export class DesignPending extends Error {
  /** Set by `at()`. Undefined only between the throw and the resume layer's catch. */
  readonly version?: string;
  /** The version whose frame this edit starts from; null for a first generation. */
  readonly parentVersion?: string | null;

  constructor(
    readonly prompt: string,
    /** The node to edit, or null when this is a first generation with nothing to edit from. */
    readonly parentNodeId: string | null,
    stamp?: { version: string; parentVersion: string | null },
  ) {
    const target = stamp ? ` for ${stamp.version}` : "";
    super(
      parentNodeId === null
        ? `design pending${target}: create the frame in Figma`
        : `design pending${target}: duplicate ${parentNodeId} in Figma and edit the copy`,
    );
    this.name = "DesignPending";
    if (stamp) {
      this.version = stamp.version;
      this.parentVersion = stamp.parentVersion;
    }
  }

  /** The same pending design, now knowing which version it is for and which version it builds on. */
  at(version: string, parentVersion: string | null): DesignPending {
    return new DesignPending(this.prompt, this.parentNodeId, { version, parentVersion });
  }
}

/**
 * Figma URLs write a node id as `123-456`; the REST API and the Plugin API want `123:456`, and `getNode` looks
 * the id up literally in the response. Accepting both saves the operator a silent "no such node" when they
 * paste an id straight from a link. Anything else is refused with the format spelled out.
 */
export function normaliseNodeId(id: string): string {
  const trimmed = id.trim();
  if (!/^\d+[:-]\d+$/.test(trimmed)) {
    throw new Error(`"${trimmed}" is not a Figma frame id: expected the form 123:456 (or 123-456, as in a Figma link)`);
  }
  return trimmed.replace("-", ":");
}

export interface FigmaGeneratorOptions {
  client: FigmaClient;
}

/**
 * Drives the loop from Figma instead of Stitch.
 *
 * Reading is a plain REST call. Writing is not possible from a CLI at all, so `generate` and `edit`
 * suspend with `DesignPending` rather than pretending to do the work. Everything else — measurement,
 * distillation, critique, scoring, the report — is unchanged, because `getHtml` returns the node tree
 * as JSON and `figmaMeasure` turns that back into the same `MeasuredDoc` the Chromium path produces.
 */
export class FigmaGenerator implements Generator {
  private readonly client: FigmaClient;

  constructor(opts: FigmaGeneratorOptions) {
    this.client = opts.client;
  }

  async generate(prompt: string): Promise<Screen> {
    throw new DesignPending(prompt, null);
  }

  async variants(_seed: Screen, _prompt: string, _opts: VariantOptions): Promise<Screen[]> {
    // The same refusal agent mode makes, and for the same reason: work orders and the resume layer know
    // version directories, so there is nowhere to hand a candidate's design work back from.
    throw new Error(
      'the Figma generator does not support multiple candidates: set "families": 1 and "variantsPerFamily": 0',
    );
  }

  /**
   * Rebuilds a handle for a frame that already exists. This is the path every resumed round takes: the
   * operator recorded the node id, so the frame is read rather than asked for again.
   */
  fromId(id: string): Screen {
    const nodeId = normaliseNodeId(id);
    const client = this.client;
    return {
      id: nodeId,
      // The edit is described, not performed: the next `step` hands it to the operator.
      edit: async (prompt: string): Promise<Screen> => {
        throw new DesignPending(prompt, nodeId);
      },
      /**
       * The node tree as JSON, not HTML. Nothing downstream parses this as markup — the injected
       * `figmaMeasure` reads it back, and the resume layer only hashes it to key a round. Returning a
       * stable, per-screen-unique string is the whole contract.
       */
      getHtml: async (): Promise<string> => JSON.stringify(await client.getNode(nodeId), null, 2),
      getImage: (): Promise<Buffer> => client.getImage(nodeId),
    };
  }
}

/**
 * The `measure` seam, Figma-native. Satisfies `(html: string) => Promise<MeasuredDoc>` exactly, so it
 * drops into `RunOptions.measure` / `SelectOptions.measure` / `StepOptions.measure` with no interface
 * change — and never launches Chromium.
 */
export function figmaMeasure(opts: SerialiseOptions = {}): (html: string) => Promise<MeasuredDoc> {
  return async (html: string) => {
    let node: FigmaNode;
    try {
      node = JSON.parse(html) as FigmaNode;
    } catch {
      throw new Error("figmaMeasure expected a serialised Figma node tree, not HTML");
    }
    return serialise(node, opts);
  };
}
