import { Platform } from 'react-native';
import { ocrReceiptPages, type ReceiptOcrResult } from './receiptOcrPipeline';
import type { OcrEngine } from './mlkitOcr';

/**
 * PHASE-5 ENSEMBLE — one implementation for every chain and every entry point
 * (live Analyze scan AND the dev batch harness, which must produce identical
 * results). Apple Vision is the iOS primary; when the primary parse fails
 * SELF-VERIFICATION (doesn't reconcile, or left phantom / junk-name /
 * priceless lines), the same pages are re-read with ML Kit and the receipt's
 * own arithmetic picks the better result. Runs ONLY on flagged parses — the
 * happy path pays nothing. Android has its own degraded-OCR fusion inside
 * ocrImageEnhanced, so the ensemble is a no-op there.
 */

/** A name with embedded amount tokens ("MAGIJA … 0,65 84 A A") = a
 *  mis-segmented row group — flagged AND penalised, so a false-reconciled
 *  parse with junk names still gets (and loses to) the second opinion. */
export const junkName = (n: string | undefined | null): boolean =>
    !!n && /\d[.,]\s?\d{2}|\s\d{2,}\s+[ABC](?:\s|$)/.test(n);

export const parseQuality = (r: any): number => {
    let q = 0;
    if (r?.footer?.reconciled) q += 100;
    const prods = r?.products ?? [];
    q += Math.min(prods.length, 30);
    q -= prods.filter((pp: any) => !pp.name || pp.name === '?').length * 8;
    q -= prods.filter((pp: any) => junkName(pp.name)).length * 8;
    q -= prods.filter((pp: any) => !(pp.price > 0)).length * 5;
    if (!r?.footer?.reconciled && Number.isFinite(r?.footer?.reconDelta)) {
        q -= Math.min(30, Math.abs(r.footer.reconDelta) * 10);
    }
    if (r?.footer?.total == null) q -= 20;
    return q;
};

export interface EnsembleGeomLine { yTop: number; yBottom: number; text: string }

/** FUSED-ROW OCR defect — on very low-res document renders (Rimi app-share
 *  PDFs wrap a ~346px embedded JPEG; the 300-dpi raster is pure interpolation)
 *  Vision sometimes merges two printed rows into ONE double-height line,
 *  garbling both and dropping text ("RIMI SMART, 1 l" + "be glitimo BARILLA"
 *  → "Raaronal be glitimo BARILIA"). The parse can still reconcile, so the
 *  flagged-parse gate never fires — this geometric signal does. Body lines
 *  only (≥8 chars + a space): logo/barcode art always has huge boxes; the
 *  3.5× cap keeps decorative blocks out. Meaningful only on document inputs —
 *  photo skew inflates bboxes and would false-positive. */
export const countFusedRows = (lines: EnsembleGeomLine[]): number => {
    const body = lines.filter((l) => l.text.trim().length >= 8 && l.text.trim().includes(' '));
    const hs = body.map((l) => l.yBottom - l.yTop).filter((h) => h > 0).sort((a, b) => a - b);
    if (hs.length < 8) return 0;
    const median = hs[Math.floor(hs.length / 2)];
    if (!(median > 0)) return 0;
    return body.filter((l) => {
        const h = l.yBottom - l.yTop;
        return h >= 1.75 * median && h <= 3.5 * median;
    }).length;
};

export const parseIsFlagged = (parsed: any): boolean =>
    !parsed?.footer?.reconciled ||
    (parsed?.products ?? []).some(
        (pp: any) => !pp.name || pp.name === '?' || junkName(pp.name) || !(pp.price > 0),
    );

export interface EnsembleOutcome<P> {
    parsed: P;
    /** The second engine's OCR result, when it WON (callers rebuild wordsDump
     *  / downstream artefacts from the winning engine's lines). */
    secondOcr: ReceiptOcrResult | null;
    engine: 'primary' | 'second';
}

/**
 * Re-read + re-parse with the second engine and keep the better parse.
 * `parseFn` receives the second engine's FULL OCR result and picks its own
 * input (IKI parses mergedLines, Maxima/Rimi parse allLines — same as the
 * live scan) — quality arbitration is chain-agnostic.
 */
export async function ensembleSecondOpinion<P>(
    primaryParsed: P,
    imageUris: string[],
    parseFn: (second: ReceiptOcrResult) => P,
    opts: { document?: boolean; secondEngine?: OcrEngine; primaryLines?: EnsembleGeomLine[] } = {},
): Promise<EnsembleOutcome<P>> {
    const keepPrimary: EnsembleOutcome<P> = { parsed: primaryParsed, secondOcr: null, engine: 'primary' };
    if (Platform.OS !== 'ios' || imageUris.length === 0) return keepPrimary;
    // Fused rows destroy text WITHOUT breaking reconciliation (a whole row
    // disappears into its neighbour), so they force the second opinion even
    // on a parse that self-verifies. ML Kit segments the same pixels
    // independently and often keeps the rows apart.
    const fused1 = opts.document && opts.primaryLines ? countFusedRows(opts.primaryLines) : 0;
    if (!parseIsFlagged(primaryParsed) && fused1 === 0) return keepPrimary;
    try {
        const t0 = Date.now();
        const second = await ocrReceiptPages(imageUris, opts.secondEngine ?? 'mlkit', { document: opts.document });
        const parsed2 = parseFn(second);
        const q1 = parseQuality(primaryParsed);
        const q2 = parseQuality(parsed2);
        // Tiebreak: at equal-or-better parse quality, fewer fused rows wins —
        // quality can't see a fusion (names aren't arithmetic), geometry can.
        const fused2 = fused1 > 0 ? countFusedRows(second.allLines as EnsembleGeomLine[]) : 0;
        const secondWins = q2 > q1 || (fused1 > 0 && fused2 < fused1 && q2 >= q1);
        console.log(
            `[ensemble] vision=${q1} mlkit=${q2} fused=${fused1}→${fused2} (${Date.now() - t0}ms) → keeping ${secondWins ? 'ML KIT' : 'vision'}`,
        );
        if (secondWins) return { parsed: parsed2, secondOcr: second, engine: 'second' };
        return keepPrimary;
    } catch (e) {
        console.log('[ensemble] second opinion failed (kept primary):', e);
        return keepPrimary;
    }
}
