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
    opts: { document?: boolean; secondEngine?: OcrEngine } = {},
): Promise<EnsembleOutcome<P>> {
    const keepPrimary: EnsembleOutcome<P> = { parsed: primaryParsed, secondOcr: null, engine: 'primary' };
    if (Platform.OS !== 'ios' || imageUris.length === 0) return keepPrimary;
    if (!parseIsFlagged(primaryParsed)) return keepPrimary;
    try {
        const t0 = Date.now();
        const second = await ocrReceiptPages(imageUris, opts.secondEngine ?? 'mlkit', { document: opts.document });
        const parsed2 = parseFn(second);
        const q1 = parseQuality(primaryParsed);
        const q2 = parseQuality(parsed2);
        console.log(`[ensemble] vision=${q1} mlkit=${q2} (${Date.now() - t0}ms) → keeping ${q2 > q1 ? 'ML KIT' : 'vision'}`);
        if (q2 > q1) return { parsed: parsed2, secondOcr: second, engine: 'second' };
        return keepPrimary;
    } catch (e) {
        console.log('[ensemble] second opinion failed (kept primary):', e);
        return keepPrimary;
    }
}
