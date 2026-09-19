import { stitch } from "@google/stitch-sdk";
import { reserve } from "./quota.js";

export interface Screen {
  id: string;
  edit(prompt: string): Promise<Screen>;
  getHtml(): Promise<string>;
  getImage(): Promise<Buffer>;
}

export interface Generator {
  generate(prompt: string): Promise<Screen>;
}

type DeviceType = "DEVICE_TYPE_UNSPECIFIED" | "MOBILE" | "DESKTOP" | "TABLET" | "AGNOSTIC";
type ModelId = "MODEL_ID_UNSPECIFIED" | "GEMINI_3_PRO" | "GEMINI_3_FLASH" | "GEMINI_3_1_PRO";

/**
 * The slice of @google/stitch-sdk's Screen and Project that this adapter uses. In SDK 0.3.5 `getHtml()` and
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
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface StitchGeneratorOptions {
  project: SdkProject;
  /** Directory whose `.design-loop/quota.json` counts this month's generations. */
  quotaDir: string;
  fetch?: (url: string) => Promise<FetchResponse>;
  sleep?: (ms: number) => Promise<void>;
  modelId?: ModelId;
  /** Conker is a phone app, and the SDK's own default leaves the device unspecified. */
  deviceType?: DeviceType;
}

/** Waits before the 2nd and 3rd attempt. */
const BACKOFF_MS = [1000, 4000];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class DownloadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** A 4xx will not change on retry (expired or forbidden URL); a 5xx or a network failure might. */
const retryableDownload = (err: unknown): boolean =>
  !(err instanceof DownloadError && err.status >= 400 && err.status < 500);

export class StitchGenerator implements Generator {
  private readonly project: SdkProject;
  private readonly quotaDir: string;
  private readonly fetchUrl: (url: string) => Promise<FetchResponse>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly modelId: ModelId | undefined;
  private readonly deviceType: DeviceType;

  constructor(opts: StitchGeneratorOptions) {
    this.project = opts.project;
    this.quotaDir = opts.quotaDir;
    this.fetchUrl = opts.fetch ?? ((url) => fetch(url));
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.modelId = opts.modelId;
    this.deviceType = opts.deviceType ?? "MOBILE";
  }

  async generate(prompt: string): Promise<Screen> {
    return this.spend(() => this.project.generate(prompt, this.deviceType, this.modelId));
  }

  /**
   * Reserves quota ONCE, before the first attempt: a retry then never double-counts, and an exhausted quota never
   * reaches the SDK. The last error is rethrown once the attempts run out; the reservation stays spent.
   */
  private async spend(call: () => Promise<SdkScreen>): Promise<Screen> {
    await reserve(this.quotaDir, 1);
    return this.wrap(await this.retry(call));
  }

  private async retry<T>(fn: () => Promise<T>, shouldRetry: (err: unknown) => boolean = () => true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= BACKOFF_MS.length || !shouldRetry(err)) throw err;
        await this.sleep(BACKOFF_MS[attempt]!);
      }
    }
  }

  private wrap(inner: SdkScreen): Screen {
    return {
      id: inner.id,
      edit: (prompt) => this.spend(() => inner.edit(prompt, this.deviceType, this.modelId)),
      getHtml: async () => (await this.download(inner, "HTML", () => inner.getHtml())).text(),
      getImage: async () => {
        const png = Buffer.from(await (await this.download(inner, "image", () => inner.getImage())).arrayBuffer());
        if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          throw new Error(`Stitch image for screen ${inner.id} is not a PNG`);
        }
        return png;
      },
    };
  }

  /** Resolves the SDK's URL, then fetches it. Errors name the screen, never the URL (it can carry a signed token). */
  private async download(inner: SdkScreen, what: string, getUrl: () => Promise<string>): Promise<FetchResponse> {
    const url = await this.retry(getUrl);
    if (!url) throw new Error(`Stitch returned an empty ${what} URL for screen ${inner.id}`);
    return this.retry(async () => {
      const res = await this.fetchUrl(url);
      if (!res.ok) throw new DownloadError(`Stitch ${what} download for screen ${inner.id} failed: HTTP ${res.status}`, res.status);
      return res;
    }, retryableDownload);
  }
}

/** Production wiring: `STITCH_API_KEY` is read by the SDK itself, `STITCH_PROJECT_ID` picks the project. */
export function createStitchGenerator(opts: Omit<StitchGeneratorOptions, "project">): StitchGenerator {
  for (const name of ["STITCH_API_KEY", "STITCH_PROJECT_ID"]) {
    if (!process.env[name]) throw new Error(`${name} is not set; Stitch generation needs it`);
  }
  return new StitchGenerator({ ...opts, project: stitch.project(process.env.STITCH_PROJECT_ID!) });
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
}
