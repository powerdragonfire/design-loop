import type { MeasuredDoc } from "../types.js";
import type { Generator, Screen, VariantOptions } from "../stitch/adapter.js";
import type { FigmaClient } from "./client.js";
import { serialise, type FigmaNode, type SerialiseOptions } from "./serialise.js";

/**
 * Not a failure: the run cannot continue until a frame exists in Figma. Figma's REST API cannot create
 * or edit nodes — that is the Plugin API, which runs inside Figma — so design work is handed back to
 * the driving session exactly as agent-mode critiques are handed to subagents.
 *
 * The operator creates or edits the frame, writes its node id to `<version>/screen-id.txt`, and runs
 * `step` again; the resume layer then rebuilds the handle through `fromId` without asking again.
 */
export class DesignPending extends Error {
  constructor(
    readonly version: string,
    readonly prompt: string,
    /** The node to edit, or null when this is a first generation with nothing to edit from. */
    readonly parentNodeId: string | null,
  ) {
    super(
      parentNodeId === null
        ? `design pending for ${version}: create the frame in Figma`
        : `design pending for ${version}: edit ${parentNodeId} in Figma`,
    );
    this.name = "DesignPending";
  }
}

/** `v00`, `v01`, … — the same naming the store uses, so a work order names the directory it belongs to. */
export const versionName = (index: number): string => `v${String(index).padStart(2, "0")}`;

export interface FigmaGeneratorOptions {
  client: FigmaClient;
  /** Passed to the serialiser so a frame narrower than the default viewport is still measured against it. */
  serialise?: SerialiseOptions;
  /** Round to start counting from, so a resumed run names the version it is actually on. */
  startRound?: number;
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
  private round: number;
  private readonly client: FigmaClient;
  private readonly serialiseOpts: SerialiseOptions;

  constructor(opts: FigmaGeneratorOptions) {
    this.client = opts.client;
    this.serialiseOpts = opts.serialise ?? {};
    this.round = opts.startRound ?? 0;
  }

  /** The version the next generation would be written to, exposed so a caller can name the work order. */
  get version(): string {
    return versionName(this.round);
  }

  async generate(prompt: string): Promise<Screen> {
    throw new DesignPending(versionName(this.round), prompt, null);
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
    return this.screen(id);
  }

  private screen(nodeId: string): Screen {
    const client = this.client;
    const self = this;
    return {
      id: nodeId,
      // The edit is described, not performed: the next `step` hands it to the operator.
      edit: async (prompt: string): Promise<Screen> => {
        throw new DesignPending(versionName(self.round + 1), prompt, nodeId);
      },
      /**
       * The node tree as JSON, not HTML. Nothing downstream parses this as markup — the injected
       * `figmaMeasure` reads it back, and the resume layer only hashes it to key a round. Returning a
       * stable, per-screen-unique string is the whole contract.
       */
      getHtml: async (): Promise<string> => {
        const node = await client.getNode(nodeId);
        return JSON.stringify(node, null, 2);
      },
      getImage: (): Promise<Buffer> => client.getImage(nodeId),
    };
  }

  /** Called by the resume layer's accounting so `version` tracks the round actually being written. */
  advanceTo(round: number): void {
    this.round = round;
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
