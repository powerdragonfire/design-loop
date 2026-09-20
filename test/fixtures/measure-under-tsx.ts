// Run by test/measure/runtime.test.ts through the real `tsx` loader, which is how the CLI runs.
// vitest's own transform does not keep function names, so it cannot see a helper the browser lacks.
import { measure } from "../../src/measure/measure.js";

const doc = await measure(`<body style="margin:0;background:#0B0B0F"><p id="t" style="color:#fff">hi</p></body>`);
const p = doc.nodes.find(n => n.selector === "#t");
if (!p) throw new Error("the paragraph was not measured");
console.log(JSON.stringify({ nodes: doc.nodes.length, effectiveBackground: p.style.effectiveBackground }));
