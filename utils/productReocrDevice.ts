import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';
import { ocrImageTiled } from './mlkitOcr';
import { devLog } from './devLog';
import { API_BASE_URL } from '../config/api';
import type { IkiLine } from '../shared/parsers/ikiParser';
import type { ReOcrFn } from './productReocr';

/**
 * Fire-and-forget telemetry: report a product re-OCR pass outcome (accept/reject + the
 * garbage/reconciliation deltas in `detail`) to the server so we can watch, in aggregate,
 * whether on-device re-OCR is helping or regressing once the flag is enabled. Skips the
 * no-op case (the gate fired nothing). Never throws / never blocks the parse.
 */
export function reportReocrOutcome(receiptNo: string | null | undefined, accepted: boolean, detail: string): void {
    if (!detail || detail === 'no-suspects') return;
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
        const padY = Math.max(10, (yBottom - yTop) * 0.6);
        const cropY0 = Math.max(0, Math.floor(yTop - padY));
        const cropH = Math.min(pageHeight, Math.ceil(yBottom + padY)) - cropY0;
        if (cropH < 6 || pageWidth < 4) return null;

        const targetW = Math.min(Math.round(pageWidth * 3), 2600);
        const f = targetW / pageWidth;
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
