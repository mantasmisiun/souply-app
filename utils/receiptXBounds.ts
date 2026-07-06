/**
 * Receipt horizontal CONTENT bounds from OCR line geometry — for cropping the
 * A4 whitespace off PDF receipts (Maxima e-receipts render on a full page with
 * the receipt column ~55% of the width).
 *
 * left/right = the text extent, with the right edge refined to the PRICE
 * COLUMN when one clearly exists: the VAT letter after each price ("1,15 A")
 * is the receipt's rightmost real content, so ≥3 price-tail lines clamp the
 * right bound to their edge (+ a letter's worth of slack). Narrow-only and
 * only when the column sits in the right half — a degenerate match can never
 * cut into the receipt body. Returns null when there's too little geometry
 * to trust (callers keep their full-width fallback).
 */
export const PRICE_TAIL_RE = /-?\d{1,4}[.,]\s?\d{2}\s*[ABC]\s*$/;

export function receiptXBounds(
    lines: { xLeft: number; xRight: number; text: string }[],
    pageWidth: number,
): { left: number; right: number } | null {
    const xs = lines.filter(
        (l) => Number.isFinite(l.xLeft) && Number.isFinite(l.xRight) && l.xRight > l.xLeft,
    );
    if (xs.length < 5) return null;
    let left = Math.max(0, Math.min(...xs.map((l) => l.xLeft)));
    let right = Math.min(pageWidth, Math.max(...xs.map((l) => l.xRight)));
    const tails = xs.filter((l) => PRICE_TAIL_RE.test(l.text.trim()));
    if (tails.length >= 3) {
        const colRight = Math.max(...tails.map((l) => l.xRight)) + 12;
        if (colRight < right && colRight > left + (right - left) / 2) right = colRight;
    }
    if (right <= left) return null;
    return { left, right };
}
