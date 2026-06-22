#!/usr/bin/env node
// Convert a captured per-word OCR dump into a runnable IkiLine[] fixture and parse
// it, printing each product + flags. This closes the loop: a dev scan PERSISTS the
// dump into the receipt blob (header.wordsDump) -> paste the DB row to a file ->
// run this -> see EXACTLY what the column engine produces, and reproduce in a test.
//
// Usage:  node scripts/wordsToFixture.mjs <dump.json>
//   <dump.json> is EITHER the pasted DB receipt blob (reads header.wordsDump) OR a
//   bare dump array (e.g. between [IKI_WORDS_DUMP_START] and _END).
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const raw = readFileSync(process.argv[2], "utf8")
  .replace(/\[IKI_WORDS_DUMP_(START|END)\]/g, "").trim();
const parsed = JSON.parse(raw);
// top-level wordsDump (current) or header.wordsDump (older), or a bare array.
const dump = Array.isArray(parsed) ? parsed : (parsed?.wordsDump ?? parsed?.header?.wordsDump);
if (!Array.isArray(dump)) {
  console.error("No word dump found. Paste a DB row whose wordsDump is present (re-scan in dev to populate it), or the bare dump array.");
  process.exit(1);
}

// dump entry: { t, x:[xl,xr], y:[yt,yb], w?:[[text,xl,xr,yt,yb],...] }
const lines = dump.map((d) => ({
  text: d.t,
  xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
  yLeftTop: d.y[0], yRightTop: d.y[0], yLeftBottom: d.y[1], yRightBottom: d.y[1],
  words: d.w?.map((w) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));

// Emit a self-contained jest test (fixture inline) and run it through ts-jest.
const test = `
import { parseIkiReceipt } from '../shared/parsers/ikiParser';
const LINES: any = ${JSON.stringify(lines)};
test('words-fixture', () => {
  const { products, footer } = parseIkiReceipt(LINES);
  const out = products.map((p: any) => ({ name: p.name, price: p.price, qty: p.quantity, unit: p.unit, promo: p.promoPrice, xL: Math.round(p.region?.xLeft), xR: Math.round(p.region?.xRight), raw: p.rawLines }));
  console.log('WF_RESULT ' + JSON.stringify({ total: footer.total, products: out }, null, 2));
});
`;
import { writeFileSync, rmSync } from "node:fs";
writeFileSync("__tests__/_wordfix.test.ts", test);
try {
  let out = "";
  try { out = execSync("npx jest _wordfix 2>&1", { encoding: "utf8" }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  const i = out.indexOf("WF_RESULT");
  console.log(i >= 0 ? out.slice(i + "WF_RESULT".length).split("\n      at ")[0].trim() : out);
} finally {
  rmSync("__tests__/_wordfix.test.ts", { force: true });
}
