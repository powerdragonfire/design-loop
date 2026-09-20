import { stitch } from "@google/stitch-sdk";
// CreativeRange/VariantAspect live in types.js, the domain-types foundation; this adapter
// leaf imports and re-exports them so existing consumers of stitch/sdk.js are unaffected.
import type { CreativeRange, VariantAspect } from "../types.js";

export type { CreativeRange, VariantAspect };
export type DeviceType = "DEVICE_TYPE_UNSPECIFIED" | "MOBILE" | "DESKTOP" | "TABLET" | "AGNOSTIC";
export type ModelId = "MODEL_ID_UNSPECIFIED" | "GEMINI_3_PRO" | "GEMINI_3_FLASH" | "GEMINI_3_1_PRO";

export interface VariantOptions {
  variantCount: number;
  creativeRange: CreativeRange;
  aspects: VariantAspect[];
}

/**
 * The slice of @google/stitch-sdk's Screen and Project that the adapter uses. In SDK 0.3.5 `getHtml()` and
 * `getImage()` resolve to DOWNLOAD URLs (or "" when the response lacks one), not content.
 */
export interface SdkScreen {
  id: string;
  edit(prompt: string, deviceType?: DeviceType, modelId?: ModelId): Promise<SdkScreen>;
  getHtml(): Promise<string>;
  getImage(): Promise<string>;
}

export interface SdkProject {
  generate(prompt: string, deviceType?: DeviceType, modelId?: ModelId): Promise<SdkScreen>;
  variants(
    seedId: string,
    prompt: string,
    opts: VariantOptions,
    deviceType?: DeviceType,
    modelId?: ModelId,
  ): Promise<SdkScreen[]>;
}

/** The one call the MCP transport exposes. Injected so the projection can be tested without a network. */
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * A response came back, but no screen could be read out of it. Its own type because it must never be
 * retried: `edit_screens` documents "DO NOT RETRY", and a projection miss usually means the edit already
 * happened server-side — retrying spends quota to make more screens nobody asked for.
 */
export class StitchProjectionError extends Error {
  constructor(readonly tool: string, why: string) {
    super(`${tool} returned no screen: ${why}`);
    this.name = "StitchProjectionError";
  }
}

interface ScreenData {
  id?: unknown;
  name?: unknown;
  htmlCode?: { downloadUrl?: unknown };
  screenshot?: { downloadUrl?: unknown };
}

const keysOf = (value: unknown): string =>
  value !== null && typeof value === "object" ? Object.keys(value).join(", ") : "";

/**
 * Every screen the response carries. `generate_variants` returns several; `generate_screen_from_text`
 * and `edit_screens` return one, and `projectScreen` takes the first of these.
 */
export function projectScreens(raw: unknown, tool: string): ScreenData[] {
  if (raw === null || typeof raw !== "object") {
    throw new StitchProjectionError(tool, `the response was ${raw === null ? "null" : `a ${typeof raw}`}, not an object with outputComponents`);
  }
  const components = (raw as { outputComponents?: unknown }).outputComponents;
  if (!Array.isArray(components)) {
    throw new StitchProjectionError(tool, `the response was an object with keys [${keysOf(raw)}], but no outputComponents array`);
  }
  const screens = components.flatMap((c: unknown) => {
    const design = (c as { design?: { screens?: unknown } } | null)?.design;
    return Array.isArray(design?.screens) ? design.screens : [];
  });
  const usable = screens.filter((s: unknown): s is ScreenData => s !== null && typeof s === "object");
  if (usable.length === 0) {
    const shape = components.map((c) => `[${keysOf(c)}]`).join(", ");
    throw new StitchProjectionError(
      tool,
      `${components.length} output component(s) with keys ${shape}; ${screens.length} screens across them`,
    );
  }
  return usable;
}

/**
 * SDK 0.3.5 reads a screen out with
 * `outputComponents.find((c) => c?.design?.screens != null)?.design?.screens?.[0]`
 * (dist/generated/src/screen.js:30, and the same line in project.js). `[] != null` is true, so a progress
 * component carrying an empty `screens` array is chosen over the later component holding the real screen,
 * and a perfectly complete payload throws "Incomplete API response … expected object at projection path".
 *
 * This is the projection the SDK's own `variants()` uses instead, which flattens every component. On a
 * miss it says what did come back, so the next failure is diagnosable rather than opaque — the count and
 * the field names only, never the payload, which carries signed download URLs.
 */
export function projectScreen(raw: unknown, tool: string): ScreenData {
  return projectScreens(raw, tool)[0]!;
}

/** A screen's id is either given outright or the tail of its resource name (SDK: screen.js:8-18). */
function idOf(data: ScreenData): string {
  if (typeof data.id === "string" && data.id !== "") return data.id;
  if (typeof data.name === "string") {
    const parts = data.name.split("/screens/");
    if (parts.length === 2 && parts[1] !== "") return parts[1]!;
  }
  return "";
}

const downloadUrl = (value: unknown, field: "htmlCode" | "screenshot"): string => {
  const url = (value as Record<string, { downloadUrl?: unknown }> | null)?.[field]?.downloadUrl;
  return typeof url === "string" ? url : "";
};

/**
 * Builds a screen handle around a projected `ScreenData`. Module-level (not a closure inside
 * `createSdkProject`) so `screenFromId` can reach it too, without a project instance or a cast.
 */
function makeScreen(projectId: string, callTool: CallTool, data: ScreenData): SdkScreen {
  const id = idOf(data);
  /** Only called when the generate/edit response carried no URL of its own. */
  const refetch = (): Promise<unknown> =>
    callTool("get_screen", { projectId, screenId: id, name: `projects/${projectId}/screens/${id}` });
  const link = async (field: "htmlCode" | "screenshot"): Promise<string> =>
    downloadUrl(data, field) || downloadUrl(await refetch(), field);

  return {
    id,
    edit: async (prompt, deviceType, modelId) =>
      makeScreen(
        projectId,
        callTool,
        projectScreen(
          await callTool("edit_screens", { projectId, selectedScreenIds: [id], prompt, deviceType, modelId }),
          "edit_screens",
        ),
      ),
    getHtml: () => link("htmlCode"),
    getImage: () => link("screenshot"),
  };
}

/**
 * Speaks to the Stitch MCP tools directly instead of going through the SDK's Project/Screen classes, which
 * are only a thin wrapper over the same `callTool` plus the broken projection above. Behaviour otherwise
 * matches SDK 0.3.5: bare ids in the arguments, cached download URLs preferred over a second `get_screen`,
 * and "" rather than a throw when no URL is to be had — the adapter turns that into a named error.
 */
export function createSdkProject(projectId: string, callTool: CallTool = defaultCallTool): SdkProject {
  return {
    generate: async (prompt, deviceType, modelId) =>
      makeScreen(
        projectId,
        callTool,
        projectScreen(
          await callTool("generate_screen_from_text", { projectId, prompt, deviceType, modelId }),
          "generate_screen_from_text",
        ),
      ),
    variants: async (seedId, prompt, opts, deviceType, modelId) =>
      projectScreens(
        await callTool("generate_variants", {
          projectId,
          selectedScreenIds: [seedId],
          prompt,
          deviceType,
          modelId,
          variantOptions: opts,
        }),
        "generate_variants",
      ).map(screenOf),
  };
}

/**
 * A handle for a screen that was generated in an earlier process, rebuilt from its id alone so a resumed
 * run can edit it without spending quota to make it again.
 *
 * `getHtml` and `getImage` throw. They would resolve through `get_screen`, which the live API rejects with
 * `Invalid Argument` for its own documented arguments; the caller has the HTML and PNG on disk instead.
 */
export function screenFromId(projectId: string, id: string, callTool: CallTool = defaultCallTool): SdkScreen {
  if (!id) throw new Error("screenFromId needs a screen id");
  const refuse = async (): Promise<never> => {
    throw new Error(`screen ${id} was rebuilt from an id: read its HTML and image from the run directory instead`);
  };
  return { ...makeScreen(projectId, callTool, { id }), getHtml: refuse, getImage: refuse };
}

/** The shared singleton, not a hand-built client: only its factory honours STITCH_HOST. */
const defaultCallTool: CallTool = (name, args) => stitch.callTool(name, args);
