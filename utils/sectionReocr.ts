import * as ImageManipulator from 'expo-image-manipulator';
import { ocrImageEnhanced, type OcrEngine } from './mlkitOcr';
import type { LineWithFrame } from './receiptOcrPipeline';

/**
 * PHOTO product-section re-OCR — the slim, chain-generic sibling of the IKI
 * whole-section machinery in utils/productReocr.ts. Fires only when a parse
 * explicitly FAILED reconciliation (footer.reconciled === false — so only
 * recon-aware chains, currently Rimi, ever qualify): the product section is
 * cropped, re-OCR'd in document mode (skips the photo downscale and upscales
 * past the glyph floor), spliced back, and the WHOLE receipt re-parsed.
 * Accepted only when the receipt's own arithmetic says the new parse is
 * strictly better; every failure path keeps the original.
 */

interface ParsedLike {
    products: {
        name?: string | null;
        price?: number;
        quantity?: number;
        parsedAmount?: number | null;
        parsedUnit?: string | null;
        region?: { yTop: number; yBottom: number };
    }[];
    footer: { reconciled?: boolean | null; reconDelta?: number | null };
}

const foldName = (s: string): string =>
    s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The re-read wins the ARITHMETIC; the original read may still have the
 * richer WORDS — a section re-OCR can drop a wrapped name row the primary
 * read had (ios-55: "MILLER, 250 g" vanished from the re-read while its
 * anchor and every price healed). For products matched by (price, qty) in
 * order, graft back the original's longer name (when the candidate's name is
 * its prefix) and its pack size (when the candidate lost it). Data-level
 * merge only — no geometry, no extra OCR. Exported for tests.
 */
export function graftRicherFields<P extends ParsedLike>(original: P, candidate: P): P {
    let oi = 0;
    const products = candidate.products.map((cp) => {
        for (let k = oi; k < Math.min(original.products.length, oi + 3); k++) {
            const op = original.products[k];
            const samePrice = Math.abs((op.price ?? 0) - (cp.price ?? 0)) < 0.005;
            const sameQty = Math.abs((op.quantity ?? 0) - (cp.quantity ?? 0)) < 0.005;
            if (!samePrice || !sameQty) continue;
            oi = k + 1;
            const fo = op.name ? foldName(op.name) : '';
            const fc = cp.name ? foldName(cp.name) : '';
            const sameItem = !!fo && !!fc && (fo.startsWith(fc) || fo.slice(0, 12) === fc.slice(0, 12));
            const out = { ...cp };
            if (sameItem && op.name && cp.name && fo.startsWith(fc) && op.name.length > cp.name.length) {
                out.name = op.name;
            }
            if (sameItem && out.parsedAmount == null && op.parsedAmount != null) {
                out.parsedAmount = op.parsedAmount;
                out.parsedUnit = op.parsedUnit ?? null;
            }
            return out;
        }
        return cp;
    });
    return { ...candidate, products };
}

const junkNameCount = (p: ParsedLike): number =>
    p.products.filter((x) => !x.name || x.name === '?').length;

/** Strictly-better test, arithmetic first. Exported for tests. */
export function sectionReocrAcceptable(original: ParsedLike, candidate: ParsedLike): boolean {
    if (candidate.products.length < original.products.length) return false;
    if (junkNameCount(candidate) > junkNameCount(original)) return false;
    if (candidate.footer.reconciled === true) return true;
    const oldD = typeof original.footer.reconDelta === 'number' ? Math.abs(original.footer.reconDelta) : Infinity;
    const newD = typeof candidate.footer.reconDelta === 'number' ? Math.abs(candidate.footer.reconDelta) : Infinity;
    return newD < oldD - 0.005;
}

/**
 * Rows the RE-READ dropped but the primary read had (ios-55: "MILLER, 250 g"
 * and "(80+), 1kl." vanished from the section re-read while everything else
 * healed). An original line inside the strip survives unless some fresh line
 * covers it — same row (y), same column (x) AND similar words. Token
 * similarity is the discriminator: on a skewed photo the neighbour row's box
 * y-overlaps a dropped row heavily, but its WORDS don't match, so geometry
 * alone would wrongly count it as covered. Exported for tests.
 */
export function preserveDroppedRows<T extends { text: string; yTop: number; yBottom: number; xLeft: number; xRight: number }>(
    originalInside: T[],
    fresh: { text: string; yTop: number; yBottom: number; xLeft: number; xRight: number }[],
): T[] {
    const tokens = (s: string): Set<string> => new Set(
        s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((t) => t.length >= 1),
    );
    return originalInside.filter((orig) => {
        const t = orig.text.trim();
        if (t.length < 4) return false;
        const ot = tokens(t);
        if (ot.size === 0) return false;
        const covered = fresh.some((f) => {
            const yOv = Math.min(f.yBottom, orig.yBottom) - Math.max(f.yTop, orig.yTop);
            const minH = Math.min(f.yBottom - f.yTop, orig.yBottom - orig.yTop);
            if (minH <= 0 || yOv < 0.5 * minH) return false;
            const xOv = Math.min(f.xRight, orig.xRight) - Math.max(f.xLeft, orig.xLeft);
            const minW = Math.min(f.xRight - f.xLeft, orig.xRight - orig.xLeft);
            if (minW <= 0 || xOv < 0.3 * minW) return false;
            const ft = tokens(f.text);
            let hit = 0;
            for (const tok of ot) if (ft.has(tok)) hit++;
            return hit / Math.min(ot.size, ft.size || 1) >= 0.34;
        });
        return !covered;
    });
}

export interface SectionReocrOutcome<P> {
    parsed: P;
    lines: LineWithFrame[];
    applied: boolean;
}

export async function sectionReocrIfFlagged<P extends ParsedLike>(
    parsed: P,
    lines: LineWithFrame[],
    pageUri: string,
    pageWidth: number,
    pageHeight: number,
    engine: OcrEngine,
    parseFn: (lines: LineWithFrame[]) => P,
): Promise<SectionReocrOutcome<P>> {
    const keep: SectionReocrOutcome<P> = { parsed, lines, applied: false };
    // Only an EXPLICIT reconciliation failure qualifies — undefined means the
    // chain has no recon and this lane has no arbitration signal.
    if (parsed.footer.reconciled !== false) return keep;
    const regions = parsed.products
        .map((p) => p.region)
        .filter((r): r is { yTop: number; yBottom: number } => !!r && r.yBottom > r.yTop);
    if (regions.length === 0) return keep;
    const pad = 40;
    const top = Math.max(0, Math.round(Math.min(...regions.map((r) => r.yTop)) - pad));
    const bottom = Math.min(pageHeight, Math.round(Math.max(...regions.map((r) => r.yBottom)) + pad));
    if (bottom - top < 60 || bottom - top > pageHeight) return keep;

    try {
        const strip = await ImageManipulator.manipulateAsync(
            pageUri,
            [{ crop: { originX: 0, originY: top, width: pageWidth, height: bottom - top } }],
            { compress: 1, format: ImageManipulator.SaveFormat.PNG },
        );
        // document mode: no photo downscale + min-width upscale — the glyph
        // boost is the whole point of the second read.
        const stripOcr = await ocrImageEnhanced(strip.uri, engine, { document: true });
        const scale = pageWidth / (stripOcr.pixelWidth || pageWidth);
        const offY = (v: number | undefined) => (v == null ? undefined : v * scale + top);
        const fresh: LineWithFrame[] = stripOcr.lines.map((l) => ({
            text: l.text,
            yTop: l.yTop * scale + top,
            yBottom: l.yBottom * scale + top,
            xLeft: l.xLeft * scale,
            xRight: l.xRight * scale,
            yLeftTop: offY(l.yLeftTop),
            yRightTop: offY(l.yRightTop),
            yLeftBottom: offY(l.yLeftBottom),
            yRightBottom: offY(l.yRightBottom),
            words: l.words?.map((w) => ({
                ...w,
                xLeft: w.xLeft * scale, xRight: w.xRight * scale,
                yTop: w.yTop * scale + top, yBottom: w.yBottom * scale + top,
                cornerPoints: w.cornerPoints?.map((pt) => ({ x: pt.x * scale, y: pt.y * scale + top })),
            })),
        }));
        const outside = lines.filter((l) => {
            const c = (l.yTop + l.yBottom) / 2;
            return c < top || c > bottom;
        });
        const inside = lines.filter((l) => !outside.includes(l));
        // Two candidates: fresh-only, and fresh + rows the re-read dropped.
        // The union usually wins (same arithmetic, more words); when the
        // preserved rows confuse the parse, the fresh-only splice still
        // stands on its own.
        const freshSplice = outside.concat(fresh).sort((a, b) => a.yTop - b.yTop);
        const preserved = preserveDroppedRows(inside, fresh);
        const unionSplice = preserved.length
            ? outside.concat(fresh, preserved).sort((a, b) => a.yTop - b.yTop)
            : freshSplice;
        const candFresh = parseFn(freshSplice);
        const candUnion = preserved.length ? parseFn(unionSplice) : candFresh;
        const okFresh = sectionReocrAcceptable(parsed, candFresh);
        const okUnion = sectionReocrAcceptable(parsed, candUnion);
        const dOf = (p: ParsedLike) => (p.footer.reconciled ? 0 : Math.abs(p.footer.reconDelta ?? Infinity));
        const useUnion = okUnion && (!okFresh || dOf(candUnion) <= dOf(candFresh) + 0.001);
        const winner = useUnion ? candUnion : okFresh ? candFresh : null;
        if (winner) {
            const winnerLines = useUnion ? unionSplice : freshSplice;
            console.log(
                `[sectionReocr] ACCEPTED y${top}-${bottom} (${useUnion ? `union, ${preserved.length} preserved` : 'fresh'}): ` +
                `recon ${parsed.footer.reconDelta} → ${winner.footer.reconciled ? '✓' : winner.footer.reconDelta}, ` +
                `products ${parsed.products.length}→${winner.products.length}`,
            );
            return { parsed: graftRicherFields(parsed, winner as P), lines: winnerLines, applied: true };
        }
        console.log(`[sectionReocr] rejected y${top}-${bottom} (recon ${parsed.footer.reconDelta} vs ${candFresh.footer.reconDelta})`);
        return keep;
    } catch (e) {
        console.log('[sectionReocr] failed (kept original):', e);
        return keep;
    }
}
