import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { ocrImageTiled } from './mlkitOcr';
import { devLog } from './devLog';
import { API_BASE_URL } from '../config/api';
import { PRODUCT_REOCR_ENABLED } from '../constants/flags';
import type { IkiLine, IkiParseResult } from '../shared/parsers/ikiParser';
import {
    maybeReocrProducts, maybeReocrProductBands, maybeReocrFooter, maybeReocrHeader,
    type ReOcrFn, type BandQuad, type ReocrOutcome,
} from './productReocr';

// Guarded Skia require — mirrors utils/imagePreprocess.ts. Resolves to null when the package isn't
// installed or its native side isn't in THIS build; the deskew ReOcrFn then falls back to a rect crop.
let Skia: any = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@shopify/react-native-skia');
    Skia = mod?.Skia ?? null;
} catch { Skia = null; }
/** Skia is installed AND its native side is in this (Android) build → the deskew warp can run. */
function skiaDeskewAvailable(): boolean {
    return Platform.OS === 'android' && Skia != null && typeof Skia.Surface?.MakeOffscreen === 'function';
}

/**
 * Fire-and-forget telemetry: report a product re-OCR pass outcome (accept/reject + the
 * garbage/reconciliation deltas in `detail`) to the server so we can watch, in aggregate,
 * whether on-device re-OCR is helping or regressing once the flag is enabled. Skips the
 * no-op case (the gate fired nothing). Never throws / never blocks the parse.
 */
export function reportReocrOutcome(receiptNo: string | null | undefined, accepted: boolean, detail: string): void {
    // Only report passes that ACTUALLY re-OCR'd (accept:/reject:) — gate-skips (no-suspects,
    // footer:reconciled, header:address-ok, …) mean the pass never ran, so they're not worth a POST.
    if (!detail || !/^(accept|reject):/.test(detail)) return;
    fetch(`${API_BASE_URL}/api/receipts/reocr-telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receiptNo: receiptNo ?? null, accepted, detail }),
    }).catch(() => {});
}

/**
 * Phase 1 device half of product-region re-OCR: the injected `ReOcrFn` that actually
 * crops + upscales + re-OCRs a suspect product's image strip and returns clean, source-
 * space IkiLines for the pure orchestrator (utils/productReocr.ts) to splice + re-run.
 *
 * The crop recipe is IDENTICAL to footerBandRefine (proven in production): full-width
 * strip with a ±0.6·height Y pad, upscaled ~3× (cap 2600px) so each glyph clears ML Kit's
 * size floor, re-OCR'd IN ISOLATION (clean, complete, correctly-ordered boxes), then mapped
 * back to source space (x ÷ f, y ÷ f + cropY0). Android/ML Kit only; returns null on any
 * failure → the orchestrator keeps the original parse.
 */
export function makeProductStripReocr(pageUri: string, pageWidth: number, pageHeight: number): ReOcrFn {
    return async (ySpan, reason, productIndex) => {
        if (Platform.OS !== 'android' || !pageUri || !(pageWidth > 0) || !(pageHeight > 0)) return null;
        const [yTop, yBottom] = ySpan;
        // Pad is 0.6× the strip height for a small band, CAPPED at 80px so a tall whole-section
        // crop doesn't swallow the header/footer (the orchestrator's linesInSpan also drops
        // anything outside the section, so a little extra pad is harmless).
        const padY = Math.min(Math.max(10, (yBottom - yTop) * 0.6), 80);
        const cropY0 = Math.max(0, Math.floor(yTop - padY));
        const cropH = Math.min(pageHeight, Math.ceil(yBottom + padY)) - cropY0;
        if (cropH < 6 || pageWidth < 4) return null;

        // Upscale ~3× so each glyph clears ML Kit's size floor, but cap BOTH dimensions so a tall
        // whole-section crop can't blow up native memory: ≤2600px wide AND ≤4000px tall; never downscale.
        const f = Math.max(1, Math.min(3, 2600 / pageWidth, 4000 / cropH));
        const targetW = Math.round(pageWidth * f);
        const mx = (x: number) => x / f;
        const my = (y: number) => y / f + cropY0;

        try {
            const crop = await ImageManipulator.manipulateAsync(
                pageUri,
                [
                    { crop: { originX: 0, originY: cropY0, width: pageWidth, height: cropH } },
                    { resize: { width: targetW } },
                ],
                { compress: 0.95, format: ImageManipulator.SaveFormat.JPEG },
            );
            const ocr = await ocrImageTiled(crop.uri);

            const lines: IkiLine[] = ocr.lines.map((ln) => {
                const words = (ln.words ?? []).map((w) => ({
                    text: w.text, xLeft: mx(w.xLeft), xRight: mx(w.xRight), yTop: my(w.yTop), yBottom: my(w.yBottom),
                }));
                const boxes = words.length
                    ? words
                    : [{ xLeft: mx(ln.xLeft), xRight: mx(ln.xRight), yTop: my(ln.yTop), yBottom: my(ln.yBottom) }];
                return {
                    text: ln.text,
                    xLeft: Math.min(...boxes.map((b) => b.xLeft)),
                    xRight: Math.max(...boxes.map((b) => b.xRight)),
                    yTop: Math.min(...boxes.map((b) => b.yTop)),
                    yBottom: Math.max(...boxes.map((b) => b.yBottom)),
                    // Carry the tilt-aware edge Y through the mapping when MLKit supplied it.
                    yLeftTop: ln.yLeftTop != null ? my(ln.yLeftTop) : undefined,
                    yRightTop: ln.yRightTop != null ? my(ln.yRightTop) : undefined,
                    yLeftBottom: ln.yLeftBottom != null ? my(ln.yLeftBottom) : undefined,
                    yRightBottom: ln.yRightBottom != null ? my(ln.yRightBottom) : undefined,
                    words,
                };
            });

            devLog('productReocr.reocr', {
                productIndex, reason,
                ySpan: [Math.round(yTop), Math.round(yBottom)],
                lines: lines.length,
                words: lines.reduce((n, l) => n + (l.words?.length ?? 0), 0),
            });
            return lines;
        } catch (e: any) {
            devLog('productReocr.reocr.error', { productIndex, reason, err: e?.message ?? String(e) });
            return null;
        }
    };
}

/**
 * Tier 2 — DESKEWING per-band re-OCR. A single product's band is a tilted parallelogram (its rows
 * shear down across the page); ML Kit reads a tilted band worse and the parser can mis-associate a
 * sheared price/discount. This ReOcrFn takes the band's QUAD, renders a straightened (vertically un-
 * sheared) + upscaled crop with Skia, OCRs THAT, then maps the fresh boxes back into source space so
 * the orchestrator's splice + re-parse are unchanged. Falls back to the plain rect crop when there's
 * no quad, the tilt is negligible, Skia isn't in the build, or the warp fails — so it is NEVER worse
 * than Tier 1, and the reconciliation accept-gate keeps the result only if it actually improves.
 *
 * GEOMETRY (full-width crop, so source x maps straight through). With band tilt `slope` (Δy per x),
 * upscale `f`, crop top `cropY0`, and a vertical output shift `yShift = f·|slope|·pageWidth` that
 * keeps the sheared content on-canvas, the forward warp source→deskewed is:
 *     x_d = f·x
 *     y_d = f·(y − cropY0 − slope·x) + yShift
 * realised by canvas ops (outermost first): translate(0,yShift) · scale(f) · skew(0,−slope) ·
 * translate(0,−cropY0). The exact inverse (deskewed→source), used to map OCR boxes back, is:
 *     x = x_d / f
 *     y = y_d/f + slope·(x_d/f) + cropY0 − |slope|·pageWidth
 * (verified: both band corners round-trip to cropY0; slope=0 reduces to the rect map y_d/f + cropY0.)
 */
export function makeBandDeskewReocr(pageUri: string, pageWidth: number, pageHeight: number): ReOcrFn {
    const rectFallback = makeProductStripReocr(pageUri, pageWidth, pageHeight);
    return async (ySpan, reason, productIndex, quad) => {
        // No quad / no Skia / not Android → plain rect re-OCR (Tier 1 behaviour).
        if (!quad || !skiaDeskewAvailable() || !pageUri || !(pageWidth > 0) || !(pageHeight > 0)) {
            return rectFallback(ySpan, reason, productIndex, quad);
        }
        const slope = bandSlope(quad);
        // Negligible tilt (<~0.6°) → the rect crop already reads it fine; skip the warp cost.
        if (!(Math.abs(slope) > 0.01) || Math.abs(slope) > 0.6) {
            return rectFallback(ySpan, reason, productIndex, quad);
        }
        const [yTop, yBottom] = ySpan;
        const padY = Math.min(Math.max(10, (yBottom - yTop) * 0.6), 80);
        const cropY0 = Math.max(0, Math.floor(yTop - padY));
        const cropBottom = Math.min(pageHeight, Math.ceil(yBottom + padY));
        const cropH = cropBottom - cropY0;
        if (cropH < 6 || pageWidth < 4) return rectFallback(ySpan, reason, productIndex, quad);

        // Upscale ~3× so glyphs clear ML Kit's size floor, but cap BOTH the width and the (taller,
        // sheared) output height so a warp can't blow up native memory; the sheared crop is
        // f·cropH + f·|slope|·pageWidth tall. If even f=1 overflows, bail to the rect crop.
        const shearPx = Math.abs(slope) * pageWidth;
        const f = Math.max(1, Math.min(3, 2600 / pageWidth, 4000 / (cropH + shearPx)));
        const outW = Math.round(pageWidth * f);
        const yShift = f * shearPx;
        const outH = Math.ceil(f * cropH + yShift) + 2;
        if (outH > 4200 || outW > 2600) return rectFallback(ySpan, reason, productIndex, quad);

        const mx = (xd: number) => xd / f;
        const my = (xd: number, yd: number) => yd / f + slope * (xd / f) + cropY0 - shearPx;

        try {
            const b64in = await FileSystem.readAsStringAsync(pageUri, { encoding: FileSystem.EncodingType.Base64 });
            const data = Skia.Data.fromBase64(b64in);
            const img = Skia.Image.MakeImageFromEncoded(data);
            if (!img) return rectFallback(ySpan, reason, productIndex, quad);
            const surface = Skia.Surface.MakeOffscreen(outW, outH);
            if (!surface) return rectFallback(ySpan, reason, productIndex, quad);
            const canvas = surface.getCanvas();
            // Outermost → innermost (the LAST op applies first to a source point). See GEOMETRY above.
            canvas.translate(0, yShift);
            canvas.scale(f, f);
            canvas.skew(0, -slope);
            canvas.translate(0, -cropY0);
            canvas.drawImage(img, 0, 0, Skia.Paint());
            surface.flush();
            const snap = surface.makeImageSnapshot();
            // PNG mirrors imagePreprocess's proven encode (the format enum is guaranteed present) and
            // keeps the upscaled glyph edges crisp for ML Kit; a single small band crop is cheap.
            const bytes = snap.encodeToBase64(Skia.ImageFormat.PNG, 100);
            const outUri = `${FileSystem.cacheDirectory}reocr-band-${productIndex}-${cropY0}.png`;
            await FileSystem.writeAsStringAsync(outUri, bytes, { encoding: FileSystem.EncodingType.Base64 });

            const ocr = await ocrImageTiled(outUri);
            const lines: IkiLine[] = ocr.lines.map((ln) => {
                const words = (ln.words ?? []).map((w) => ({
                    text: w.text, xLeft: mx(w.xLeft), xRight: mx(w.xRight),
                    // A row is horizontal in deskewed space; the inverse re-applies the band tilt, so
                    // a word's source Y depends on its X. Bound the box by both x-edges' mapped Y.
                    yTop: Math.min(my(w.xLeft, w.yTop), my(w.xRight, w.yTop)),
                    yBottom: Math.max(my(w.xLeft, w.yBottom), my(w.xRight, w.yBottom)),
                }));
                const boxes = words.length
                    ? words
                    : [{
                        xLeft: mx(ln.xLeft), xRight: mx(ln.xRight),
                        yTop: Math.min(my(ln.xLeft, ln.yTop), my(ln.xRight, ln.yTop)),
                        yBottom: Math.max(my(ln.xLeft, ln.yBottom), my(ln.xRight, ln.yBottom)),
                    }];
                return {
                    text: ln.text,
                    xLeft: Math.min(...boxes.map((b) => b.xLeft)),
                    xRight: Math.max(...boxes.map((b) => b.xRight)),
                    yTop: Math.min(...boxes.map((b) => b.yTop)),
                    yBottom: Math.max(...boxes.map((b) => b.yBottom)),
                    // Re-project the source tilt onto the line's own corners so downstream de-skew
                    // treats this band consistently with the un-re-OCR'd bands around it.
                    yLeftTop: my(ln.xLeft, ln.yTop), yRightTop: my(ln.xRight, ln.yTop),
                    yLeftBottom: my(ln.xLeft, ln.yBottom), yRightBottom: my(ln.xRight, ln.yBottom),
                    words,
                };
            });
            devLog('productReocr.deskew', {
                productIndex, reason, slope: Math.round(slope * 1000) / 1000,
                ySpan: [Math.round(yTop), Math.round(yBottom)], out: [outW, outH],
                lines: lines.length, words: lines.reduce((n, l) => n + (l.words?.length ?? 0), 0),
            });
            return lines;
        } catch (e: any) {
            devLog('productReocr.deskew.error', { productIndex, reason, err: e?.message ?? String(e) });
            return rectFallback(ySpan, reason, productIndex, quad);
        }
    };
}

/** Band tilt: average of the top-edge and bottom-edge slopes (Δy per unit x) across the band width. */
function bandSlope(q: BandQuad): number {
    const dx = q.xRight - q.xLeft;
    if (!(dx > 0)) return 0;
    return ((q.yRightTop - q.yLeftTop) + (q.yRightBottom - q.yLeftBottom)) / 2 / dx;
}

/**
 * THE single IKI product re-OCR pass sequence, shared by BOTH parse paths (the interactive scan flow
 * `receiptScanFlow` AND the background/heal queue `receiptProcessingService`) so they can never drift.
 * Whole-section passes first (fix CROSS-band scrambles), then per-band deskew passes (fix WITHIN-band
 * garbles + a reconciliation sweep). Every pass is reconciliation-accept-gated, so the worst case is a
 * no-op. Android + flag gated; a no-op (returns the inputs, changed:false) on any other platform.
 */
export async function runIkiReocrPasses(
    parsed: IkiParseResult,
    mergedLines: IkiLine[],
    page: { uri: string; pixelWidth: number; pixelHeight: number } | null | undefined,
    opts?: { report?: boolean },
): Promise<{ parsed: IkiParseResult; lines: IkiLine[]; changed: boolean }> {
    if (!PRODUCT_REOCR_ENABLED || Platform.OS !== 'android' || !page?.uri || !(page.pixelWidth > 0) || !(page.pixelHeight > 0)) {
        return { parsed, lines: mergedLines, changed: false };
    }
    const reOcr = makeProductStripReocr(page.uri, page.pixelWidth, page.pixelHeight);
    const bandReOcr = makeBandDeskewReocr(page.uri, page.pixelWidth, page.pixelHeight);
    const PROD_REASONS = ['no-name', 'no-price', 'amount-in-name', 'collapsed-band', 'garbled-name'] as const;
    let cur = parsed, lines = mergedLines, changed = false;
    const passes: [string, () => Promise<ReocrOutcome>][] = [
        ['products', () => maybeReocrProducts(cur, lines, reOcr, { reasons: [...PROD_REASONS] })],
        ['footer', () => maybeReocrFooter(cur, lines, reOcr, { reconcileThreshold: 1.0 })],
        ['header', () => maybeReocrHeader(cur, lines, reOcr)],
        ['products-recon', () => maybeReocrProducts(cur, lines, reOcr, { reconcileThreshold: 1.0 })],
        ['products-band', () => maybeReocrProductBands(cur, lines, bandReOcr, { reasons: [...PROD_REASONS] })],
        ['products-band-recon', () => maybeReocrProductBands(cur, lines, bandReOcr, { reconcileThreshold: 1.0 })],
    ];
    for (const [label, run] of passes) {
        try {
            const o = await run();
            devLog(`productReocr.pass.${label}`, { accepted: o.accepted, detail: o.detail });
            if (opts?.report) reportReocrOutcome(cur.footer?.receiptNo, o.accepted, o.detail);
            if (o.accepted) { cur = o.parsed; lines = o.lines; changed = true; }
        } catch { /* fail-safe: keep the prior parse */ }
    }
    return { parsed: cur, lines, changed };
}
