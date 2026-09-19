import { loadContract } from "../contract/load.js";
import { measure } from "../measure/measure.js";
import { deterministicCritique } from "../critics/deterministic.js";
import { distill, estimateTokens } from "../distill/distill.js";
import type { CriticInput, LlmClient } from "../critics/llm.js";
import type { ChairClient } from "../chair/chair.js";
import type { Generator, Screen } from "../stitch/adapter.js";
import { costUsd } from "./pricing.js";
import type { Issue, Usage } from "../types.js";

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeReport {
  steps: SmokeStep[];
  /** What the two clients actually spent; null when a configured model has no price row. */
  usd: number | null;
}

export interface SmokeOptions {
  designDir: string;
  generator: Generator;
  llm: LlmClient;
  chairClient: ChairClient;
}

/** A step that never ran because the step it needed did not succeed; it is not a failure of its own. */
const SKIPPED = "skipped: ";
export const isSkipped = (step: SmokeStep): boolean => step.detail.startsWith(SKIPPED);

/** What the plan budgets for one screen; the projection below is honest about exceeding it. */
const PLAN_USD_PER_SCREEN = 0.58;
const CRITICS = 4;
const ROUNDS = 4;

/** Small, but with a real tap-target and contrast failure, so the digest and the measurements are not empty. */
const SMOKE_HTML = `<!doctype html><html><body style="margin:0;background:#0B0B0F;font-family:system-ui">
  <h1 style="color:#F5F5F7;font-size:24px;margin:16px">Sign in</h1>
  <p id="hint" style="color:#2A2A33;font-size:13px;margin:16px">Use the email you signed up with</p>
  <button id="go" style="width:30px;height:30px;background:#FF7A1A;color:#0B0B0F;border:0">Go</button>
  </body></html>`;

/** A 1x1 PNG: the critics and the chair need an image, and the built-in page has no screenshot. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const DET_PREFIXES = ["det-token-", "det-contrast-", "det-tap-", "det-inset-"] as const;
const COLOUR_PROPS = ["color", "backgroundColor", "effectiveBackground"] as const;
const IS_RGB = /^rgba?\(/;

const noUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
const addUsage = (total: Usage, more: Usage | undefined): void => {
  if (!more) return;
  total.inputTokens += more.inputTokens;
  total.outputTokens += more.outputTokens;
  total.cachedTokens += more.cachedTokens;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Everything the first live run depends on, exercised once against the real services for about $0.30 and two
 * Stitch generations: the structured-output schema, adaptive thinking with an image, the prompt cache, the
 * chair's fallbacks beta, Stitch's generate AND edit, and — the one the unit tests cannot reach — `measure()`
 * on a REAL Stitch page, where an unparseable colour syntax or an exploded node count would otherwise only
 * show up after the money was spent.
 *
 * Every step runs, whatever the one before it did; a step that needs an earlier step's output is recorded as
 * skipped rather than silently passing. This never throws: a failed step is the result.
 */
export async function smoke(opts: SmokeOptions): Promise<SmokeReport> {
  const { designDir, generator, llm, chairClient } = opts;
  // A run needs a measured sigma; a diagnostic does not, and refusing here would block the very command
  // meant to be run before calibrating.
  const contract = await loadContract(designDir, {}, undefined, { allowNullSigma: true });
  const cfg = contract.config;

  const steps: SmokeStep[] = [];
  const add = (name: string, ok: boolean, detail: string): void => { steps.push({ name, ok, detail }); };
  const skip = (name: string, why: string): void => { steps.push({ name, ok: false, detail: `${SKIPPED}${why}` }); };
  const criticUsage = noUsage();
  const chairUsage = noUsage();

  // 1. One real critic call: the schema, adaptive thinking and an image in one non-streaming request.
  let criticInput: CriticInput | null = null;
  try {
    const doc = await measure(SMOKE_HTML);
    const det = deterministicCritique(doc, contract.tokens);
    criticInput = {
      contract,
      screen: Object.keys(contract.screens)[0] ?? "smoke",
      digest: distill(doc),
      imagePng: PIXEL,
      openIssues: [],
      measurements: det.critique.issues.filter((i) => !i.id.startsWith("det-token-")),
    };
    const critique = await llm.critique("typography", criticInput, cfg.models.critic);
    addUsage(criticUsage, llm.takeUsage?.());
    add("critic call", true, `typography returned score ${critique.score} with ${critique.issues.length} issue(s)`);
  } catch (err) {
    addUsage(criticUsage, llm.takeUsage?.());
    criticInput = null;
    add("critic call", false, message(err));
  }

  // 2. The same call again: a hit needs a byte-identical stable prefix above the model's cache minimum.
  if (!criticInput) {
    skip("prompt cache", "the critic call did not succeed, so there is nothing cached to hit");
  } else {
    try {
      await llm.critique("typography", criticInput, cfg.models.critic);
      const u = llm.takeUsage?.();
      addUsage(criticUsage, u);
      if (!u) {
        add("prompt cache", false, "the client reports no token usage, so a cache hit cannot be seen");
      } else if (u.cachedTokens > 0) {
        add("prompt cache", true, `${u.cachedTokens} cached and ${u.inputTokens} fresh input tokens on the second call`);
      } else {
        add("prompt cache", false,
          `0 cached and ${u.inputTokens} fresh input tokens on the second call: the stable prefix may be under the model's minimum cacheable size`);
      }
    } catch (err) {
      addUsage(criticUsage, llm.takeUsage?.());
      add("prompt cache", false, message(err));
    }
  }

  // 3. One real chair call, which is where the server-side fallbacks beta is first exercised.
  const fake: Issue = {
    id: "accessibility-001",
    severity: "major",
    evidence: { selector: "#go", observed: "30x30px" },
    claim: "The primary button is a 30x30px tap target",
    fix: "Enlarge the primary button to at least 44x44px",
    effort: "low",
  };
  try {
    const out = await chairClient.synthesise(
      { critiques: [], openIssues: [fake], imagePng: PIXEL, tokens: contract.tokens, regression: null },
      cfg.models.chair,
    );
    addUsage(chairUsage, chairClient.takeUsage?.());
    add("chair call", out.prompt.trim().length > 0,
      out.prompt.trim().length > 0
        ? `the chair returned a ${out.prompt.length}-character prompt naming ${out.changes.length} change(s)`
        : "the chair returned an empty prompt");
  } catch (err) {
    addUsage(chairUsage, chairClient.takeUsage?.());
    const detail = message(err);
    add("chair call", false,
      /fallback/i.test(detail)
        ? `${detail} — build the chair with { fallbacks: false } and try again`
        : detail);
  }

  // 4. A real generation, and the two downloads that follow it.
  let screen: Screen | null = null;
  let html: string | null = null;
  try {
    const generated = await generator.generate("a simple mobile login screen");
    const got = await generated.getHtml();
    const png = await generated.getImage(); // the adapter rejects anything that is not a PNG
    if (got.trim() === "") throw new Error("Stitch returned an empty HTML document");
    screen = generated;
    html = got;
    add("stitch generate", true, `${got.length} bytes of HTML and a ${png.length}-byte PNG for screen ${generated.id}`);
  } catch (err) {
    screen = null;
    html = null;
    add("stitch generate", false, message(err));
  }

  // 5. An edit, which nothing else in the suite has ever exercised against the real API.
  if (!screen) {
    skip("stitch edit", "the generate step did not succeed, so there is no screen to edit");
  } else {
    try {
      const edited = await screen.edit("make the button larger");
      const editedHtml = await edited.getHtml();
      add("stitch edit", editedHtml.trim().length > 0,
        editedHtml.trim().length > 0
          ? `the edit returned screen ${edited.id} with ${editedHtml.length} bytes of HTML`
          : "the edit returned an empty HTML document");
    } catch (err) {
      add("stitch edit", false, message(err));
    }
  }

  // 6. The one check the unit tests cannot make: our measurement of a page Stitch actually wrote.
  let digestTokens: number | null = null;
  if (html === null) {
    skip("measure real page", "the generate step produced no HTML to measure");
  } else {
    try {
      const doc = await measure(html);
      const det = deterministicCritique(doc, contract.tokens);
      const digest = distill(doc);
      digestTokens = estimateTokens(digest);
      const counts = DET_PREFIXES
        .map((p) => `${p}${det.critique.issues.filter((i) => i.id.startsWith(p)).length}`)
        .join(" ");
      const unreadable = doc.nodes.reduce(
        (n, node) => n + COLOUR_PROPS.filter((p) => node.style[p] !== undefined && !IS_RGB.test(node.style[p]!)).length,
        0,
      );
      add("measure real page", true,
        `${doc.nodes.length} nodes, ~${digestTokens} digest tokens, ${counts}, ${unreadable} colour value(s) still not rgb()/rgba()`);
    } catch (err) {
      add("measure real page", false, message(err));
    }
  }

  // 7. What this diagnostic cost, and what a whole screen would cost at the digest size just measured.
  let usd: number | null = null;
  try {
    usd = costUsd(cfg.models.critic, criticUsage) + costUsd(cfg.models.chair, chairUsage);
    let detail = `$${usd.toFixed(4)} spent on this check`;
    if (digestTokens !== null) {
      const perScreen = costUsd(cfg.models.critic, {
        inputTokens: digestTokens * CRITICS * ROUNDS, outputTokens: 0, cachedTokens: 0,
      });
      detail += `; a screen projects to ~$${perScreen.toFixed(2)} (${digestTokens} digest tokens x ${CRITICS} critics x ${ROUNDS} rounds)`
        + ` against the plan's $${PLAN_USD_PER_SCREEN.toFixed(2)}`;
      if (perScreen > 2 * PLAN_USD_PER_SCREEN) detail += " — MORE THAN 2x the estimate; re-baseline before a batch";
    } else {
      detail += `; no real page was measured, so the plan's $${PLAN_USD_PER_SCREEN.toFixed(2)} per screen is unverified`;
    }
    add("cost", true, detail);
  } catch (err) {
    usd = null;
    add("cost", false, message(err));
  }

  return { steps, usd };
}
