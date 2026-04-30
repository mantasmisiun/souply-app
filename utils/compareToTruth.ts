/**
 * Compare a parser's output against a hand-annotated truth file.
 *
 * Used by the dev Kvitų paketinis testas screen to score V1 vs V2
 * Maxima parser runs on real receipts. Pure function — no state, no
 * IO, just structured diffing.
 *
 * Matching strategy: for each truth product, find the parsed product
 * with the highest composite score (name token overlap + price
 * agreement). Greedy 1-to-1 pairing — once a parsed product is
 * paired, it can't be reused for another truth product. Truth
 * products with no acceptable match are flagged as "missed"; parsed
 * products with no truth pair are flagged as "extra".
 *
 * Per-pair correctness: ALL of (price within 0.01, promoPrice equal,
 * quantity equal, amount within 0.001, unit equal, isWeighable
 * equal) must hold to count as "fully correct".
 *
 * Score: productsCorrect / max(truthCount, parsedCount). This
 * penalizes both missed truths and extra hallucinations symmetrically.
 */

import type { MaximaProduct } from '../../shared/parsers/maximaParser';

export interface TruthProduct {
    name: string;
    price: number;
    promoPrice: number | null;
    quantity: number;
    amount: number;
    unit: string;
    isWeighable: boolean;
    pricePerUnit: number | null;
}

export interface TruthFile {
    $schema: string;
    source: { pdf: string; annotatedAt: string };
    store: { chainName: string; storeCode: string; name: string; address: string };
    receipt: {
        receiptNo: string;
        date: string;
        totalAmount: number;
        totalSavings: number;
    };
    products: TruthProduct[];
}

export interface ParserComparison {
    productCount: number;
    productsCorrect: number;
    productsMissed: number;
    productsExtra: number;
    pricesCorrect: number;
    promoPricesCorrect: number;
    /**
     * V1/V2 fold pack-size into a single `quantity` field (no
     * separate `amount`). We compare against truth's
     * `quantity * amount` product. So for `1,99 X 1,118 kg` truth
     * has `quantity=1, amount=1.118` and parser has `quantity=1.118` —
     * the effective measurement matches.
     */
    quantitiesCorrect: number;
    unitsCorrect: number;
    weighableCorrect: number;
    totalAmountDelta: number;
    totalAmountParsed: number | null;
    totalAmountTruth: number;
    score: number;
    issues: string[];
}

// ───────── helpers ─────────

const MIN_TOKEN_LEN = 3;
const MIN_NAME_SIM = 0.3; // below this two products are NOT a candidate pair
const PRICE_EPS = 0.01;
const AMOUNT_EPS = 0.001;

const tokenize = (name: string): Set<string> => {
    const tokens = name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= MIN_TOKEN_LEN);
    return new Set(tokens);
};

const nameSimilarity = (a: string, b: string): number => {
    const ta = tokenize(a);
    const tb = tokenize(b);
    if (ta.size === 0 || tb.size === 0) return 0;
    let intersection = 0;
    for (const t of ta) if (tb.has(t)) intersection++;
    return intersection / Math.min(ta.size, tb.size);
};

/**
 * Recover the line total from a parsed MaximaProduct. The parser
 * normalizes rows with a unit-qty line to per-unit pricing
 * (`price` == `pricePerUnit` and `promoPrice` divided by
 * `quantity`), so the line total comes back as `price × quantity`.
 * Truth files always carry the line total directly in `price`.
 */
const lineTotalGross = (p: MaximaProduct): number => p.price * p.quantity;
const lineTotalPromo = (p: MaximaProduct): number | null =>
    p.promoPrice === null ? null : p.promoPrice * p.quantity;

/** Composite candidate-pair score: name overlap (70%) + price match (30%). */
const pairScore = (parsed: MaximaProduct, truth: TruthProduct): number => {
    const nameSim = nameSimilarity(parsed.name, truth.name);
    if (nameSim < MIN_NAME_SIM) return 0;
    const priceMatch = Math.abs(lineTotalGross(parsed) - truth.price) < PRICE_EPS ? 1 : 0;
    return nameSim * 0.7 + priceMatch * 0.3;
};

/** True if the two values agree as null-or-equal floats within an epsilon. */
const promoEqual = (a: number | null | undefined, b: number | null | undefined): boolean => {
    if ((a ?? null) === null && (b ?? null) === null) return true;
    if (a == null || b == null) return false;
    return Math.abs(a - b) < PRICE_EPS;
};

// ───────── public API ─────────

export function compareToTruth(
    parsed: MaximaProduct[],
    parsedTotalAmount: number | null,
    truth: TruthFile,
): ParserComparison {
    const truthCount = truth.products.length;
    const parsedCount = parsed.length;

    // Greedy pairing. For each truth product (in order), find the
    // unpaired parsed product with the highest pair score.
    const parsedTaken = new Set<number>();
    const pairs: { truthIdx: number; parsedIdx: number; score: number }[] = [];
    const missed: number[] = [];

    for (let ti = 0; ti < truth.products.length; ti++) {
        const t = truth.products[ti];
        let bestIdx = -1;
        let bestScore = 0;
        for (let pi = 0; pi < parsed.length; pi++) {
            if (parsedTaken.has(pi)) continue;
            const s = pairScore(parsed[pi], t);
            if (s > bestScore) {
                bestScore = s;
                bestIdx = pi;
            }
        }
        if (bestIdx >= 0) {
            parsedTaken.add(bestIdx);
            pairs.push({ truthIdx: ti, parsedIdx: bestIdx, score: bestScore });
        } else {
            missed.push(ti);
        }
    }

    // Parsed products with no truth pair = extras.
    const extras: number[] = [];
    for (let pi = 0; pi < parsed.length; pi++) {
        if (!parsedTaken.has(pi)) extras.push(pi);
    }

    // Per-pair correctness checks + issue logging.
    const issues: string[] = [];
    let productsCorrect = 0;
    let pricesCorrect = 0;
    let promoPricesCorrect = 0;
    let quantitiesCorrect = 0;
    let unitsCorrect = 0;
    let weighableCorrect = 0;

    for (const pair of pairs) {
        const p = parsed[pair.parsedIdx];
        const t = truth.products[pair.truthIdx];
        const tNameShort = t.name.slice(0, 40);
        const localIssues: string[] = [];

        // Compare line totals, not raw `price`. Parser normalizes
        // unit-qty rows to per-unit pricing, so the line total is
        // `price × quantity`. Truth always stores the printed line
        // total directly.
        const pGross = lineTotalGross(p);
        const priceOk = Math.abs(pGross - t.price) < PRICE_EPS;
        if (priceOk) pricesCorrect++;
        else localIssues.push(`price=${pGross.toFixed(2)} (truth=${t.price})`);

        const pPromo = lineTotalPromo(p);
        const promoOk = promoEqual(pPromo, t.promoPrice);
        if (promoOk) promoPricesCorrect++;
        else localIssues.push(`promoPrice=${pPromo === null ? 'null' : pPromo.toFixed(2)} (truth=${t.promoPrice})`);

        // V1/V2 collapse pack-size into a single `quantity`. Compare
        // against truth's quantity*amount product so weighable
        // (`1,99 X 1,118 kg` → parser.quantity=1.118 vs truth qty=1
        // amount=1.118) and multi-pack (`2,99 X 2 vnt.` →
        // parser.quantity=2 vs truth qty=2 amount=1) both work.
        const truthEffectiveQty = t.quantity * t.amount;
        const qtyOk = Math.abs(p.quantity - truthEffectiveQty) < AMOUNT_EPS;
        if (qtyOk) quantitiesCorrect++;
        else localIssues.push(`quantity=${p.quantity} (truth qty*amount=${truthEffectiveQty})`);

        const unitOk = (p.unit ?? '').toLowerCase() === t.unit.toLowerCase();
        if (unitOk) unitsCorrect++;
        else localIssues.push(`unit=${p.unit} (truth=${t.unit})`);

        // MaximaProduct doesn't expose isWeighable directly. For the
        // batch test we use unit==='kg' as a proxy — agrees with
        // truth's isWeighable for all real Lithuanian receipts (the
        // only weighable unit in the field is kg).
        const pIsWeighable = (p.unit ?? '').toLowerCase() === 'kg';
        const weighableOk = pIsWeighable === t.isWeighable;
        if (weighableOk) weighableCorrect++;
        else localIssues.push(`isWeighable=${pIsWeighable} (truth=${t.isWeighable})`);

        if (localIssues.length === 0) {
            productsCorrect++;
        } else {
            issues.push(`P${pair.truthIdx + 1} '${tNameShort}': ${localIssues.join(', ')}`);
        }
    }

    for (const ti of missed) {
        const t = truth.products[ti];
        issues.push(`P${ti + 1} MISSED '${t.name.slice(0, 50)}' (price=${t.price}, qty=${t.quantity})`);
    }
    for (const pi of extras) {
        const p = parsed[pi];
        issues.push(`EXTRA '${p.name.slice(0, 50)}' (price=${p.price}, qty=${p.quantity})`);
    }

    const totalDelta =
        parsedTotalAmount === null
            ? NaN
            : Math.round((parsedTotalAmount - truth.receipt.totalAmount) * 100) / 100;

    const denom = Math.max(truthCount, parsedCount, 1);
    const score = Math.round((productsCorrect / denom) * 1000) / 1000;

    return {
        productCount: parsedCount,
        productsCorrect,
        productsMissed: missed.length,
        productsExtra: extras.length,
        pricesCorrect,
        promoPricesCorrect,
        quantitiesCorrect,
        unitsCorrect,
        weighableCorrect,
        totalAmountDelta: Number.isFinite(totalDelta) ? totalDelta : 0,
        totalAmountParsed: parsedTotalAmount,
        totalAmountTruth: truth.receipt.totalAmount,
        score,
        issues,
    };
}
