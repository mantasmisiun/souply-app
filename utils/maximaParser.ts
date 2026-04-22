/**
 * Maxima Receipt Parser
 *
 * Mirrors the shape of rimiParser.ts (same Region/Product/Header/Footer
 * interfaces) so the receipt-process screen can branch on chain and reuse
 * the same downstream flow.
 *
 * Key format differences the parser has to handle:
 *  - Discount header is `AČIŪ nuolaida prekei:<name>` and the savings line
 *    `-X,XX A` comes on the next OCR row. OCR regularly corrupts the Ū
 *    diacritic, so we detect by `/nuolaida\s+prekei/i` instead of by word.
 *  - Discount header + savings are sometimes merged into a single OCR row.
 *  - The weighable indicator (`unit_price X weight kg`) comes *after* the
 *    product's price line — reversed vs Rimi — and stores the unit price
 *    on the left of the X, the weight on the right.
 *  - Name + price can also be merged into a single OCR row.
 *
 * Before line-by-line parsing, a preprocessing pass splits any merged
 * "<name-or-discount-text> <price>" lines into two pseudo-lines at the
 * same y-position, so the downstream logic can treat each field separately.
 */

export interface Region {
  yTop: number;
  yBottom: number;
  xLeft: number;
  xRight: number;
}

export interface MaximaLine {
  text: string;
  yTop: number;
  yBottom: number;
  xLeft: number;
  xRight: number;
}

export interface MaximaProduct {
  name: string;
  price: number;
  promoPrice: number | null;
  quantity: number;
  unit: string;
  pricePerUnit: number | null;
  rawLines: string[];
  region: Region;
}

export interface MaximaHeader {
  chainName: string;
  storeCode: string;
  storeAddress: string;
  pvmCode: string;
  rawText: string;
  region: Region;
}

export interface MaximaFooter {
  total: number | null;
  date: string;
  time: string;
  receiptNo: string;
  totalSavings: number | null;
  rawText: string;
  region: Region;
}

export interface MaximaParseResult {
  header: MaximaHeader;
  products: MaximaProduct[];
  footer: MaximaFooter;
}

// ───────── regexes ─────────

const PRICE_RE = /(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const STANDALONE_PRICE_RE = /^(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const SAVINGS_RE = /^-\s*(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const INLINE_SAVINGS_RE = /-\s*(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
// `unit_price X quantity unit` — unit price on left, quantity+unit on right.
// Covers both weighables (`1,59 X 0,430 kg`) and multi-pack (`1,59 X 2 maiŠ.`).
// Quantity decimal is optional since pack counts are whole numbers.
// Unit tolerates OCR variants: maiš/maiŠ/mais, vnt/vnt., pak/pak.
const UNIT_LINE_RE =
  /(\d+[.,]\d{1,2})\s*[xX×]\s*(\d+(?:[.,]\d{1,3})?)\s*(kg|mai[sšŠ]\.?|vnt\.?|pak\.?)/i;
// `3 vnt už 1,19 eur` — multi-buy bundle, the bundle discount is on another line
const MULTI_RE = /(\d+)\s*vnt\.?\s*u[zž]\s*(\d+[.,]\d{1,2})\s*eur/i;
const DISCOUNT_HEADER_RE = /nuolaida\s+prekei/i;

// ───────── helpers ─────────

function parseNum(str: string): number {
  return parseFloat(str.replace(",", ".").replace(/\s/g, ""));
}

function regionOf(lines: MaximaLine[]): Region {
  if (lines.length === 0) return { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 };
  return {
    yTop: Math.min(...lines.map((l) => l.yTop)),
    yBottom: Math.max(...lines.map((l) => l.yBottom)),
    xLeft: Math.min(...lines.map((l) => l.xLeft)),
    xRight: Math.max(...lines.map((l) => l.xRight)),
  };
}

// ───────── detection ─────────

export function isMaximaReceipt(lines: string[]): boolean {
  const head = lines.slice(0, 15).join(" ").toUpperCase();
  return head.includes("MAXIMA");
}

// ───────── preprocessing ─────────

/**
 * Split OCR rows that have a price trailing at the end into two pseudo-lines
 * so downstream parsing sees name/discount and price/savings separately.
 */
function splitMergedLines(lines: MaximaLine[]): MaximaLine[] {
  const out: MaximaLine[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;

    // Already standalone price or savings — keep as is.
    if (STANDALONE_PRICE_RE.test(text) || SAVINGS_RE.test(text)) {
      out.push(line);
      continue;
    }

    const priceMatch = text.match(PRICE_RE);
    const savingsMatch = text.match(INLINE_SAVINGS_RE);

    // Inline discount: "AČIŪ nuolaida prekei:<name> -X,XX A"
    if (DISCOUNT_HEADER_RE.test(text) && savingsMatch) {
      const savingsStart = text.lastIndexOf(savingsMatch[0]);
      const left = text.slice(0, savingsStart).trim();
      const right = text.slice(savingsStart).trim();
      out.push({ ...line, text: left });
      out.push({ ...line, text: right });
      continue;
    }

    // Merged product line: "<name> X,XX A"
    if (priceMatch && !DISCOUNT_HEADER_RE.test(text)) {
      const priceStart = text.lastIndexOf(priceMatch[0]);
      const left = text.slice(0, priceStart).trim();
      const right = text.slice(priceStart).trim();
      if (left.length > 0) {
        out.push({ ...line, text: left });
        out.push({ ...line, text: right });
        continue;
      }
    }

    out.push(line);
  }
  return out;
}

// ───────── section boundaries ─────────

function findHeaderEnd(lines: MaximaLine[]): number {
  // Products start after `Kvitas bazėje:` or at the first standalone price.
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    if (/kvitas\s+baz[eėé]/i.test(lines[i].text)) return i + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    if (STANDALONE_PRICE_RE.test(lines[i].text.trim())) {
      return Math.max(0, i - 1);
    }
  }
  return Math.min(7, lines.length);
}

function findFooterStart(lines: MaximaLine[], afterIdx: number): number {
  for (let i = afterIdx; i < lines.length; i++) {
    const text = lines[i].text;
    if (/suteiktos\s+naudos/i.test(text)) return i;
    if (/^A[ČCČ][IÍ][ŪÜŪÖU]\s+nuolaidos/i.test(text)) return i;
    if (/^Kvito\s+suma/i.test(text)) return i;
    if (/^f1Mok[eėé]tina/i.test(text)) return i;
    if (/^Mok[eė]tina\s+suma/i.test(text)) return i;
    if (/^={10,}/.test(text)) return i; // separator lines near the footer
  }
  return lines.length;
}

// ───────── header ─────────

function parseHeader(lines: MaximaLine[]): MaximaHeader {
  let storeCode = "";
  let storeAddress = "";
  let pvmCode = "";

  for (const line of lines) {
    const text = line.text.trim();

    const pvmMatch = text.match(/(LT|LV|EE)\d{9,12}/);
    if (pvmMatch) pvmCode = pvmMatch[0];

    // Address lines typically contain `g.`, `pr.`, `al.`, `pl.` and `Kasa` or a comma+city.
    if (
      !storeAddress &&
      /\b(g|pr|al|pl)\.\s/i.test(text) &&
      !/UAB|MAXIMA|PVM/i.test(text)
    ) {
      // Strip trailing "Kasa Nr. N" — it's a cashier counter, not part of the
      // address, and leaving it in the string tanks the Levenshtein ratio
      // against a clean DB address and breaks the store match.
      storeAddress = text.replace(/,?\s*Kasa\s+Nr\.?\s*\d+.*$/i, "").trim();
    }

    // Occasional "X-NNN MAXIMA" legacy store code — used only as a display label
    // since store matching is done via address.
    const codeMatch = text.match(/\b([A-Z]-\d{3,4})\s+MAXIMA\b/i);
    if (codeMatch) storeCode = codeMatch[1].toUpperCase();
  }

  return {
    chainName: "MAXIMA",
    storeCode,
    storeAddress,
    pvmCode,
    rawText: lines.map((l) => l.text).join("\n"),
    region: regionOf(lines),
  };
}

// ───────── products ─────────

function parseProducts(lines: MaximaLine[]): MaximaProduct[] {
  const products: MaximaProduct[] = [];

  // Collect indices of standalone (non-savings) price lines — these anchor
  // each product. Savings lines (-X,XX A) are handled separately.
  const priceIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text.trim();
    if (STANDALONE_PRICE_RE.test(t) && !SAVINGS_RE.test(t)) {
      priceIndices.push(i);
    }
  }

  const usedLines = new Set<number>();

  for (let pi = 0; pi < priceIndices.length; pi++) {
    const priceIdx = priceIndices[pi];
    const priceLine = lines[priceIdx];
    const priceText = priceLine.text.trim();
    const priceMatch = priceText.match(STANDALONE_PRICE_RE)!;
    let price = parseNum(priceMatch[1]);

    if (usedLines.has(priceIdx)) continue;
    usedLines.add(priceIdx);

    const consumedLines: MaximaLine[] = [priceLine];
    const rawLines: string[] = [];

    let quantity = 1;
    let unit = "vnt";
    let pricePerUnit: number | null = null;
    let promoPrice: number | null = null;

    const prevPriceIdx = pi > 0 ? priceIndices[pi - 1] : -1;

    // Look backward for name lines.
    const nameLines: string[] = [];
    let lookback = priceIdx - 1;
    while (lookback > prevPriceIdx && nameLines.length < 4) {
      const prev = lines[lookback];
      const prevText = prev.text.trim();

      if (!prevText || usedLines.has(lookback)) {
        lookback--;
        continue;
      }
      if (STANDALONE_PRICE_RE.test(prevText)) break;
      // Discount header or savings line belong to the PREVIOUS product, not this one.
      if (DISCOUNT_HEADER_RE.test(prevText) || SAVINGS_RE.test(prevText)) break;
      if (UNIT_LINE_RE.test(prevText)) break; // unit/weight lines come after, not before

      nameLines.unshift(prevText);
      consumedLines.push(prev);
      usedLines.add(lookback);
      lookback--;
    }

    let name = nameLines.join(" ").trim();
    rawLines.push(...nameLines);
    rawLines.push(priceText);

    // Skip non-product artefacts occasionally captured as prices.
    if (!name) continue;
    if (/^\d+[.,]?\d*$/.test(name)) continue;

    // Look FORWARD for weight indicator and discount pair.
    const nextPriceIdx =
      pi + 1 < priceIndices.length ? priceIndices[pi + 1] : lines.length;

    for (let j = priceIdx + 1; j < Math.min(priceIdx + 5, nextPriceIdx); j++) {
      if (usedLines.has(j)) continue;
      const next = lines[j];
      const nextText = next.text.trim();
      if (!nextText) continue;

      const unitMatch = nextText.match(UNIT_LINE_RE);
      if (unitMatch) {
        pricePerUnit = parseNum(unitMatch[1]);
        quantity = parseNum(unitMatch[2]);
        const rawUnit = unitMatch[3].toLowerCase().replace(/\./g, "");
        // Normalize pack/bag/piece to vnt; kg stays kg.
        unit = rawUnit === "kg" ? "kg" : "vnt";
        rawLines.push(nextText);
        consumedLines.push(next);
        usedLines.add(j);
        continue;
      }

      // Discount header — expect a savings line right after (or already on
      // this line if preprocessing caught it). Checked BEFORE the standalone
      // multi-buy regex because Maxima often inlines multi-buy info inside
      // the discount header ("AČIŪ nuolaida prekei:Sūrelis MAGIJA; 3 vnt už
      // 1,19 eur") — if MULTI_RE ran first it would swallow the header and
      // the -0,XX savings row would be orphaned.
      if (DISCOUNT_HEADER_RE.test(nextText)) {
        rawLines.push(nextText);
        consumedLines.push(next);
        usedLines.add(j);
        // Look at the immediately following line for the savings amount.
        for (let k = j + 1; k < Math.min(j + 3, nextPriceIdx); k++) {
          if (usedLines.has(k)) continue;
          const savText = lines[k].text.trim();
          if (!savText) continue;
          const savMatch = savText.match(SAVINGS_RE);
          if (savMatch) {
            const savings = parseNum(savMatch[1]);
            // promoPrice is the per-line effective price = price - savings.
            // For weighable items, price and savings are both totals, so this
            // still holds. We'll normalize to per-unit below if weighable.
            promoPrice = Math.round((price - savings) * 100) / 100;
            rawLines.push(savText);
            consumedLines.push(lines[k]);
            usedLines.add(k);
            break;
          }
          // If the "next" line isn't savings, stop looking.
          break;
        }
        continue;
      }

      // Standalone multi-buy indicator (no discount header) — informational
      // only; quantity stays 1 and the bundle effect reports via a separate
      // savings row handled above.
      const multiMatch = nextText.match(MULTI_RE);
      if (multiMatch) {
        rawLines.push(nextText);
        consumedLines.push(next);
        usedLines.add(j);
        continue;
      }

      // Anything else — stop looking forward for this product.
      break;
    }

    // For weighable items, normalize to per-unit pricing for DB consistency
    // (matches what rimiParser does).
    if (pricePerUnit !== null) {
      price = pricePerUnit;
      if (promoPrice !== null && quantity > 0) {
        promoPrice = Math.round((promoPrice / quantity) * 100) / 100;
      }
    }

    name = cleanProductName(name);
    if (!name) continue;

    products.push({
      name,
      price,
      promoPrice,
      quantity,
      unit,
      pricePerUnit,
      rawLines,
      region: regionOf(consumedLines),
    });
  }

  return products;
}

function cleanProductName(name: string): string {
  let cleaned = name;
  cleaned = cleaned.replace(/,?\s*\d+[\.,]?\d*\s*(g|kg|ml|l|vnt\.?)\s*$/i, "").trim();
  cleaned = cleaned.replace(/,\s*$/, "").trim();
  return cleaned;
}

// ───────── footer ─────────

function parseFooter(lines: MaximaLine[]): MaximaFooter {
  let total: number | null = null;
  let date = "";
  let time = "";
  let receiptNo = "";
  let totalSavings: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text.trim();

    // Kvito suma 71,44  — same line or on the next.
    const sumaMatch = text.match(/Kvito\s+suma\s+(\d+[.,]\s?\d{2})/i);
    if (sumaMatch) total = parseNum(sumaMatch[1]);
    if (/^Kvito\s+suma\s*$/i.test(text) && i + 1 < lines.length) {
      const m = lines[i + 1].text.trim().match(/(\d+[.,]\s?\d{2})/);
      if (m) total = parseNum(m[1]);
    }

    // Fallback: `Mokėtina suma 71,44` or `f1Mokėtina suma 71,44`.
    if (total === null) {
      const mok = text.match(/Mok[eė]tina\s+suma\s+(\d+[.,]\s?\d{2})/i);
      if (mok) total = parseNum(mok[1]);
    }

    // Data ir laikas 2026-04-04 14:49:30
    const dtMatch = text.match(
      /Data\s+ir\s+laikas\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/i
    );
    if (dtMatch) {
      date = dtMatch[1];
      time = dtMatch[2];
    }

    // Kvito Nr. 363753  — single number, possibly followed by more tokens.
    const nrMatch = text.match(/Kvito\s+Nr\.?\s+(\S+)/i);
    if (nrMatch && !receiptNo) receiptNo = nrMatch[1];

    // Sutaupėte 13,40
    if (/sutaup[eėè]te/i.test(text)) {
      const s = text.match(/(\d+[.,]\s?\d{2})/);
      if (s) totalSavings = parseNum(s[1]);
      else if (i + 1 < lines.length) {
        const ns = lines[i + 1].text.trim().match(/(\d+[.,]\s?\d{2})/);
        if (ns) totalSavings = parseNum(ns[1]);
      }
    }
  }

  return {
    total,
    date,
    time,
    receiptNo,
    totalSavings,
    rawText: lines.map((l) => l.text).join("\n"),
    region: regionOf(lines),
  };
}

// ───────── public entry points ─────────

export function parseMaximaReceipt(lines: MaximaLine[]): MaximaParseResult {
  const processed = splitMergedLines(lines);
  const headerEnd = findHeaderEnd(processed);
  const footerStart = findFooterStart(processed, headerEnd);

  return {
    header: parseHeader(processed.slice(0, headerEnd)),
    products: parseProducts(processed.slice(headerEnd, footerStart)),
    footer: parseFooter(processed.slice(footerStart)),
  };
}

export function parseMaximaHeaderOnly(lines: MaximaLine[]): MaximaHeader {
  const processed = splitMergedLines(lines);
  const headerEnd = findHeaderEnd(processed);
  return parseHeader(processed.slice(0, headerEnd));
}
