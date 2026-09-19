import { chromium } from "playwright";
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
    await page.setContent(html, { waitUntil: "networkidle" });
    const nodes = await page.evaluate((props) => {
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
      // MeasuredDoc has no parent links, and `#id` selectors lose their path, so
      // consumers cannot walk ancestors. Resolve the painted background here.
      // Fully transparent layers are skipped; partial alpha is NOT composited (v1).
      function effectiveBg(el: Element): string {
        for (let cur: Element | null = el; cur; cur = cur.parentElement) {
          const bg = getComputedStyle(cur).backgroundColor;
          if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
        }
        return "rgb(255, 255, 255)"; // the browser paints a white canvas by default
      }
      const out: any[] = [];
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const style: Record<string, string> = {};
        for (const p of props) style[p] = (cs as any)[p];
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
        });
      }
      return out;
    }, STYLE_PROPS as unknown as string[]);
    return { viewport: VIEWPORT, nodes: nodes as MeasuredNode[] };
  } finally {
    await browser.close();
  }
}
