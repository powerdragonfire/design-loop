import { chromium, errors as playwrightErrors } from "playwright";
import type { MeasuredDoc, MeasuredNode } from "../types.js";

export const VIEWPORT = { w: 393, h: 852 };
export const HOME_INDICATOR_INSET = 34;

const STYLE_PROPS = [
  "color", "backgroundColor", "fontSize", "fontWeight", "fontFamily",
  "lineHeight", "letterSpacing", "borderRadius", "padding", "margin",
  "opacity", "display", "position", "zIndex",
] as const;

export async function measure(html: string): Promise<MeasuredDoc> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: VIEWPORT.w, height: VIEWPORT.h },
      deviceScaleFactor: 3,
    });
    // Stitch pages load Tailwind's CDN, Google Fonts and Material Symbols; offline, or behind a slow proxy,
    // the network never goes idle. A timeout here means "measure what has loaded", not "fail the run".
    try {
      await page.setContent(html, { waitUntil: "networkidle", timeout: 15_000 });
    } catch (err) {
      if (!(err instanceof playwrightErrors.TimeoutError)) throw err;
    }
    const nodes = await page.evaluate((props) => {
      // KEEP FIRST. Playwright serialises this body and the browser re-parses it, so it may not
      // reference anything left behind in the Node module scope — and tsx, which is how the CLI
      // runs, compiles with esbuild's keepNames: every named function below is rewritten to
      // `__name(fn, "fn")`, whose helper never crosses over. An identity shim satisfies those calls.
      // vitest does not keep names, so only test/measure/runtime.test.ts can catch a regression here.
      (globalThis as { __name?: <T>(fn: T, name: string) => T }).__name ??= (fn) => fn;
      // Build a stable unique selector: prefer #id ONLY when that id is unique in
      // the document (generated HTML often repeats ids), else an nth-of-type path.
      // Task 4 resolves critic-cited selectors against these strings, so
      // uniqueness is a correctness requirement, and ids are CSS-escaped so
      // `#b\:c`-style ids stay valid selectors.
      function sel(el: Element): string {
        if (el.id && document.querySelectorAll(`[id="${el.id.replace(/"/g, '\\"')}"]`).length === 1) {
          return `#${CSS.escape(el.id)}`;
        }
        const parts: string[] = [];
        let cur: Element | null = el;
        while (cur && cur.tagName !== "HTML") {
          const parent: Element | null = cur.parentElement;
          if (!parent) break;
          const same = Array.from(parent.children)
            .filter(c => c.tagName === cur!.tagName);
          const i = same.indexOf(cur) + 1;
          parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${i})`);
          cur = parent;
        }
        return parts.join(" > ");
      }
      // Chromium serialises a computed colour in the syntax it was written in, so Tailwind v4's
      // `oklch()` palette (and `color()`, `color-mix()`) reaches the deterministic critic unparseable
      // and every contrast and token check is skipped in silence. Painting the value into a 1x1 canvas
      // and reading the pixel back turns any colour syntax into sRGB bytes plus alpha.
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const unreadable = (value: string) => ({
        css: value,
        a: value === "rgba(0, 0, 0, 0)" || value === "transparent" ? 0 : 255,
      });
      function paint(value: string): { css: string; a: number } {
        if (!ctx) return unreadable(value);
        try {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data as unknown as number[];
          return {
            css: a === 255
              ? `rgb(${r}, ${g}, ${b})`
              : `rgba(${r}, ${g}, ${b}, ${Number(((a as number) / 255).toFixed(3))})`,
            a: a as number,
          };
        } catch {
          return unreadable(value);
        }
      }
      // MeasuredDoc has no parent links, and `#id` selectors lose their path, so
      // consumers cannot walk ancestors. Resolve the painted background here.
      // A layer with ALPHA 0 paints nothing, whatever its channels say (`bg-white/0` is
      // `rgba(255, 255, 255, 0)`, which a string comparison read as painted); partial
      // alpha is NOT composited (v1).
      function effectiveBg(el: Element): string {
        for (let cur: Element | null = el; cur; cur = cur.parentElement) {
          const bg = paint(getComputedStyle(cur).backgroundColor);
          if (bg.a !== 0) return bg.css;
        }
        return "rgb(255, 255, 255)"; // the browser paints a white canvas by default
      }
      // Fixed or sticky, itself or through an ancestor: the element stays on screen while the page scrolls,
      // so it is the one thing the home-indicator inset can actually cover.
      function pinnedOf(el: Element): boolean {
        for (let cur: Element | null = el; cur && cur !== document.body; cur = cur.parentElement) {
          const position = getComputedStyle(cur).position;
          if (position === "fixed" || position === "sticky") return true;
        }
        return false;
      }
      function depthOf(el: Element): number {
        let d = 0;
        for (let cur = el.parentElement; cur && cur !== document.body; cur = cur.parentElement) d++;
        return d;
      }
      const out: any[] = [];
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        // An icon's internals (path, circle, g) are not elements a critic can act on, and each one
        // would be a full digest line: the <svg> root stands for the whole icon.
        if ((el as SVGElement).ownerSVGElement) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const style: Record<string, string> = {};
        for (const p of props) style[p] = (cs as any)[p];
        for (const p of ["color", "backgroundColor"]) {
          if (style[p] !== undefined) style[p] = paint(style[p]).css;
        }
        style.effectiveBackground = effectiveBg(el);
        out.push({
          selector: sel(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          // Own direct text only. textContent aggregates descendants, which would
          // repeat the same string at every ancestor level (duplicate contrast
          // issues, and wasted digest tokens in Task 7).
          text: Array.from(el.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => (n.textContent ?? "").trim())
            .filter(Boolean)
            .join(" ")
            .slice(0, 120),
          bbox: { x: r.x, y: r.y, w: r.width, h: r.height },
          style,
          depth: depthOf(el),
          pinned: pinnedOf(el),
        });
      }
      return out;
    }, STYLE_PROPS as unknown as string[]);
    return { viewport: VIEWPORT, nodes: nodes as MeasuredNode[] };
  } finally {
    await browser.close();
  }
}
