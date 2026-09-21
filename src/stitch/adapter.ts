import { reserve } from "./quota.js";
import {
  createSdkProject,
  screenFromId,
  ScreenRebuiltFromIdError,
  StitchProjectionError,
  type CreativeRange,
  type DeviceType,
  type ModelId,
  type SdkProject,
  type SdkScreen,
  type VariantAspect,
  type VariantOptions,
} from "./sdk.js";

export type { CreativeRange, DeviceType, ModelId, SdkProject, SdkScreen, VariantAspect, VariantOptions };

export interface Screen {
  id: string;
  edit(prompt: string): Promise<Screen>;
  getHtml(): Promise<string>;
  getImage(): Promise<Buffer>;
}

export interface Generator {
  generate(prompt: string): Promise<Screen>;
  variants(seed: Screen, prompt: string, opts: VariantOptions): Promise<Screen[]>;
  /** Rebuilds a handle for a screen this generator already produced. No network, no quota. */
  fromId?(id: string): Screen;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** `Response.body`, when the implementation has one: cancelling it frees the socket of a refused download. */
  body?: { cancel(): Promise<unknown> } | null;
}

export interface StitchGeneratorOptions {
  project: SdkProject;
  /** The project screens are generated in. Needed only to rebuild a handle by id, not to generate or edit. */
  projectId?: string;
  /** Directory whose `.design-loop/quota.json` counts this month's generations. */
  quotaDir: string;
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponse>;
  sleep?: (ms: number) => Promise<void>;
  modelId?: ModelId;
  /** Conker is a phone app, and the SDK's own default leaves the device unspecified. */
  deviceType?: DeviceType;
  /** Told before each wait between attempts, so a person watching sees a retry instead of a silent stall. */
  onRetry?: (info: { what: string; attempt: number; of: number; waitMs: number; error: string }) => void;
  /** Told the prompt before it is sent, so a run shows what it asked Stitch for and not only what came back. */
  onPrompt?: (info: { what: string; prompt: string }) => void;
}

/**
 * Stitch answers an edit in one of two shapes. A small, surgical change comes back as a
 * `sessionEvent` carrying `dom_operations` and no screen at all: the edit IS applied server-side,
 * but nothing in the response points at HTML or a PNG, and `get_screen` cannot recover it (the live
 * API rejects its own documented arguments, and a freshly generated screen is absent from
 * `list_screens`). A larger change comes back as a full `design.screens[]` with both download URLs.
 * The chair's prompts are deliberately small — "Make exactly these 3 changes and nothing else" — so
 * without this suffix most rounds take the first path and a run dies at v01 with
 * `StitchProjectionError`. Asking for the whole screen forces the second path.
 */
const WHOLE_SCREEN = "\n\nReturn the complete updated screen, not a partial edit.";

/** Waits before the 2nd and 3rd attempt. */
const BACKOFF_MS = [1000, 4000];
/** A download that has not finished in a minute is hung; without this the whole run waits on it forever. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class DownloadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * A 4xx will not change on retry (expired or forbidden URL), except 408 and 429, which say "try again". A 5xx or a
 * network failure, including a reset mid-body, might clear too.
 */
/**
 * A projection failure is the one error that must not be retried: `edit_screens` documents "DO NOT RETRY",
 * and a miss usually means the edit already happened server-side, so another attempt spends quota to make
 * screens nobody asked for. Everything else — a reset, a 5xx, a timeout — still gets its three tries.
 */
const retryableCall = (err: unknown): boolean => !(err instanceof StitchProjectionError);

const retryableDownload = (err: unknown): boolean =>
  !(err instanceof DownloadError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429);

/**
 * A rebuilt-from-id handle's `getHtml`/`getImage` throw `ScreenRebuiltFromIdError` on every call, the same
 * way every time — retrying it is as pointless as retrying a `StitchProjectionError`, and worse, it stalls
 * the caller through the full backoff before the (unchanged) error finally surfaces.
 */
const retryableLink = (err: unknown): boolean => !(err instanceof ScreenRebuiltFromIdError);

/** The body of a refused download is never read, so it is discarded explicitly rather than left open. */
async function drain(res: FetchResponse): Promise<void> {
  try {
    if (res.body) await res.body.cancel();
    else await res.arrayBuffer();
  } catch {
    // Discarding a body that cannot be read changes nothing: the caller is about to throw anyway.
  }
}

export class StitchGenerator implements Generator {
  private readonly project: SdkProject;
  private readonly projectId: string | undefined;
  private readonly quotaDir: string;
  private readonly fetchUrl: (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponse>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly modelId: ModelId | undefined;
  private readonly deviceType: DeviceType;
  private readonly onRetry: StitchGeneratorOptions["onRetry"];
  private readonly onPrompt: StitchGeneratorOptions["onPrompt"];

  constructor(opts: StitchGeneratorOptions) {
    this.project = opts.project;
    this.projectId = opts.projectId;
    this.quotaDir = opts.quotaDir;
    this.fetchUrl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.modelId = opts.modelId;
    this.deviceType = opts.deviceType ?? "MOBILE";
    this.onRetry = opts.onRetry;
    this.onPrompt = opts.onPrompt;
  }

  async generate(prompt: string): Promise<Screen> {
    return this.spend("generate", prompt, () => this.project.generate(prompt, this.deviceType, this.modelId));
  }

  /** Rebuilds a handle for a screen an earlier process generated, so a resumed run can edit it without regenerating it. */
  fromId(id: string): Screen {
    if (!this.projectId) throw new Error("StitchGenerator has no projectId; it cannot rebuild a screen by id");
    return this.wrap(screenFromId(this.projectId, id));
  }

  /**
   * Quota is reserved in two parts, to keep both of `spend`'s invariants at once. One unit goes down
   * BEFORE the call, exactly like `spend`, so an exhausted quota still never reaches the SDK. The rest
   * goes down AFTER, once the actual count is known: Stitch may return fewer variants than asked for,
   * and reserving the requested count up front would spend generations that were never made. The
   * prompt is announced first, as `generate` and `edit` do.
   */
  async variants(seed: Screen, prompt: string, opts: VariantOptions): Promise<Screen[]> {
    this.onPrompt?.({ what: "variants", prompt });
    await reserve(this.quotaDir, 1);
    const made = await this.retry("variants", () => this.project.variants(seed.id, prompt, opts, this.deviceType, this.modelId), retryableCall);
    if (made.length > 1) await reserve(this.quotaDir, made.length - 1);
    return made.map((s) => this.wrap(s));
  }

  /**
   * Reserves quota ONCE, before the first attempt: a retry then never double-counts, and an exhausted quota never
   * reaches the SDK. The last error is rethrown once the attempts run out; the reservation stays spent.
   *
   * The prompt is announced before the reservation, so a refusal still says what it would have sent.
   */
  private async spend(what: string, prompt: string, call: () => Promise<SdkScreen>): Promise<Screen> {
    this.onPrompt?.({ what, prompt });
    await reserve(this.quotaDir, 1);
    return this.wrap(await this.retry(what, call, retryableCall));
  }

  private async retry<T>(what: string, fn: () => Promise<T>, shouldRetry: (err: unknown) => boolean = () => true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= BACKOFF_MS.length || !shouldRetry(err)) throw err;
        this.onRetry?.({
          what, attempt: attempt + 2, of: BACKOFF_MS.length + 1, waitMs: BACKOFF_MS[attempt]!,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.sleep(BACKOFF_MS[attempt]!);
      }
    }
  }

  private wrap(inner: SdkScreen): Screen {
    return {
      id: inner.id,
      // The suffix is machinery, not intent, so `spend` still reports the chair's own prompt.
      edit: (prompt) => this.spend("edit", prompt, () => inner.edit(prompt + WHOLE_SCREEN, this.deviceType, this.modelId)),
      getHtml: () => this.download(inner, "HTML", () => inner.getHtml(), (res) => res.text()),
      getImage: async () => {
        const png = await this.download(inner, "image", () => inner.getImage(), async (res) =>
          Buffer.from(await res.arrayBuffer()),
        );
        if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          throw new Error(`Stitch image for screen ${inner.id} is not a PNG`);
        }
        return png;
      },
    };
  }

  /**
   * Resolves the SDK's URL, then fetches it and reads the body, all inside the retried step so a connection reset
   * mid-body is retried like a failed request. Errors name the screen, never the URL (it can carry a signed token):
   * undici puts the URL in some of its own messages, and an abort reason reaches the manifest and the report, so
   * a raw rejection is replaced by its class name alone.
   */
  private async download<T>(
    inner: SdkScreen,
    what: string,
    getUrl: () => Promise<string>,
    read: (res: FetchResponse) => Promise<T>,
  ): Promise<T> {
    const url = await this.retry(`${what} link`, getUrl, retryableLink);
    if (!url) throw new Error(`Stitch returned an empty ${what} URL for screen ${inner.id}`);
    return this.retry(`${what} download`, async () => {
      try {
        const res = await this.fetchUrl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok) {
          await drain(res);
          throw new DownloadError(`Stitch ${what} download for screen ${inner.id} failed: HTTP ${res.status}`, res.status);
        }
        return await read(res);
      } catch (err) {
        // A DownloadError already names the screen and its status, which the retry policy reads.
        if (err instanceof DownloadError) throw err;
        throw new Error(`Stitch ${what} download for screen ${inner.id} failed: ${(err as Error)?.name ?? "unknown error"}`);
      }
    }, retryableDownload);
  }
}

/**
 * Production wiring. `STITCH_PROJECT_ID` picks the project; the SDK authenticates from either `STITCH_API_KEY` or
 * `STITCH_ACCESS_TOKEN` with `GOOGLE_CLOUD_PROJECT` (spec §4). Errors name variables, never their values.
 */
export function createStitchGenerator(opts: Omit<StitchGeneratorOptions, "project">): StitchGenerator {
  const env = process.env;
  const projectId = env.STITCH_PROJECT_ID;
  if (!projectId) throw new Error("STITCH_PROJECT_ID is not set; Stitch generation needs the project to generate in");
  if (!env.STITCH_API_KEY && !(env.STITCH_ACCESS_TOKEN && env.GOOGLE_CLOUD_PROJECT)) {
    if (!env.STITCH_ACCESS_TOKEN && !env.GOOGLE_CLOUD_PROJECT) {
      throw new Error("Stitch has no credentials: set STITCH_API_KEY, or both STITCH_ACCESS_TOKEN and GOOGLE_CLOUD_PROJECT");
    }
    const missing = env.STITCH_ACCESS_TOKEN ? "GOOGLE_CLOUD_PROJECT" : "STITCH_ACCESS_TOKEN";
    throw new Error(`${missing} is not set; the OAuth route needs both STITCH_ACCESS_TOKEN and GOOGLE_CLOUD_PROJECT (or set STITCH_API_KEY)`);
  }
  return new StitchGenerator({ ...opts, project: createSdkProject(projectId), projectId });
}

export interface FakeScreenSpec {
  html: string;
  png: Buffer;
}

/** Walks a scripted array, one entry per generate/edit. Running past the end throws: repeating would hide bugs. */
export class FakeGenerator implements Generator {
  readonly prompts: string[] = [];
  private next = 0;

  constructor(private readonly script: FakeScreenSpec[]) {}

  async generate(prompt: string): Promise<Screen> {
    this.prompts.push(prompt);
    const index = this.next++;
    const spec = this.script[index];
    if (!spec) throw new Error(`script exhausted: no entry ${index} for prompt "${prompt}"`);
    return {
      id: `fake-${index}`,
      edit: (editPrompt) => this.generate(editPrompt),
      getHtml: async () => spec.html,
      getImage: async () => spec.png,
    };
  }

  async variants(_seed: Screen, prompt: string, opts: VariantOptions): Promise<Screen[]> {
    const out: Screen[] = [];
    for (let i = 0; i < opts.variantCount; i++) out.push(await this.generate(prompt));
    return out;
  }

  fromId(id: string): Screen {
    const index = Number(id.replace("fake-", ""));
    const spec = this.script[index];
    if (!spec) throw new Error(`no fake screen ${id}`);
    // Rebuilding a handle re-enters the script at that screen, so the next edit must produce the entry AFTER
    // it. Without this the fake hands an edit the screen it was just rebuilt from, which reads as "the edit
    // changed nothing" — the exact failure a resumed run exists to rule out.
    this.next = Math.max(this.next, index + 1);
    return {
      id,
      edit: (prompt) => this.generate(prompt),
      getHtml: async () => spec.html,
      getImage: async () => spec.png,
    };
  }
}
