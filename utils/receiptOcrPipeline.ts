import TextRecognition from "@react-native-ml-kit/text-recognition";
import * as ImageManipulator from "expo-image-manipulator";
import { Image } from "react-native";
import { ocrImageEnhanced, type OcrEngine } from "./mlkitOcr";

/**
 * SINGLE SOURCE OF TRUTH for turning receipt image/PDF-page URIs into the OCR
 * line input the shared parsers consume.
 *
 * EVERY receipt-parsing surface MUST go through `ocrReceiptPages` so the exact
 * same lines reach the parsers regardless of entry point:
 *   - the Analyze-tab headless queue (`services/receiptProcessingService.ts`)
 *   - account recovery (`services/recoveryOcr.ts`)
 *  (the interactive `app/receipt-process.tsx` inlines an equivalent pass that
 *   also collects per-page crop/mask geometry; its merge math is identical.)
 *
 * Why this matters: account recovery matches a re-OCR'd receipt against the
 * total stored at upload time. If the two paths group lines even slightly
 * differently (e.g. a frameScale-unaware merge threshold, or skipping the
 * portrait rotation), the parsed total drifts by a few cents and the match
 * fails. Sharing the pipeline removes that whole class of divergence.
 */

export interface LineWithFrame {
    text: string;
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
    // Skew-aware edge Y (from MLKit cornerPoints) — top/bottom Y at the line's
    // left vs right edge. Optional; absent → axis-aligned yTop/yBottom.
    yLeftTop?: number;
    yRightTop?: number;
    yLeftBottom?: number;
    yRightBottom?: number;
    // Per-word boxes (MLKit elements), for word-anchored bands. Carry the same
    // y-offset as the line.
    words?: { text: string; xLeft: number; xRight: number; yTop: number; yBottom: number; cornerPoints?: { x: number; y: number }[] }[];
}

export interface ReceiptOcrPageMeta {
    /** Post-rotation page uri (what OCR actually ran on). */
    uri: string;
    pixelWidth: number;
    pixelHeight: number;
    frameScale: number;
    /** This page's y-offset in the concatenated parser space. */
    yOffsetScaled: number;
    /** Max line yBottom on this page (page-local, pre-offset). */
    pageMaxYScaled: number;
    /** Receipt CONTENT x-bounds — density histogram refined to the price
     *  column (see computeReceiptXBoundsForPage). Band crops use these to
     *  skip PDF page margins. */
    receiptXLeftScaled: number;
    receiptXRightScaled: number;
}

export interface ReceiptOcrResult {
    /** Raw OCR lines (page-pixel space, multi-page y-offset applied), sorted top→bottom. */
    allLines: LineWithFrame[];
    /** Same lines after the adjacent-row merge pass (Iki + chain detection use these). */
    mergedLines: LineWithFrame[];
    /** OCR downscale factor of page 0 — drives the merge threshold. */
    frameScale: number;
    /** First page, post-rotation: what the upload + crop run against. */
    firstPageUri: string;
    firstPageWidth: number;
    firstPageHeight: number;
    /** Per-page metadata (rotation-corrected uris, y-offsets, x-bounds). */
    pageMetas: ReceiptOcrPageMeta[];
}

/**
 * Receipt horizontal bounds for ONE page — the SINGLE implementation shared by
 * the live scan, the recovery flow and the dev batch (they must never drift):
 * a 20-px text-density histogram (percentile bounds fail when sparse edge
 * lines — dividers, logos — keep outer bins alive), then the price-column
 * clamp: the VAT letter after each price is the receipt's rightmost REAL
 * content, so ≥3 price-tail lines pull the right bound in (narrow-only,
 * right-half guarded).
 */
export function computeReceiptXBoundsForPage(
    lines: { xLeft: number; xRight: number; text: string }[],
    pageWidth: number,
    logLabel?: string,
): { left: number; right: number; peak: number } {
    const BIN = 20;
    const nBins = Math.max(1, Math.ceil(pageWidth / BIN));
    const hist = new Array(nBins).fill(0);
    for (const { xLeft: l, xRight: r } of lines) {
        const lo = Math.max(0, Math.floor(l / BIN));
        const hi = Math.min(nBins - 1, Math.floor(Math.max(l, r - 1) / BIN));
        for (let b = lo; b <= hi; b++) hist[b]++;
    }
    const peak = hist.reduce((m, v) => Math.max(m, v), 0);
    const densityThresh = Math.max(1, peak * 0.08);
    let leftBin = 0;
    while (leftBin < nBins && hist[leftBin] < densityThresh) leftBin++;
    let rightBin = nBins - 1;
    while (rightBin >= 0 && hist[rightBin] < densityThresh) rightBin--;
    let left = leftBin * BIN;
    let right = (rightBin + 1) * BIN;
    if (right <= left) { left = 0; right = pageWidth; }
    const PRICE_TAIL_RE = /-?\d{1,4}[.,]\s?\d{2}\s*[ABC]\s*$/;
    const tails = lines.filter((l) => PRICE_TAIL_RE.test(l.text.trim()));
    if (tails.length >= 3) {
        const colRight = Math.max(...tails.map((l) => l.xRight)) + 12;
        const mid = left + (right - left) / 2;
        if (colRight < right && colRight > mid) {
            if (logLabel) {
                console.log(`${logLabel} price-column right clamp: ${Math.round(right)} → ${Math.round(colRight)} (${tails.length} price tails)`);
            }
            right = colRight;
        }
    }
    return { left, right, peak };
}

/**
 * Camera photos held sideways arrive as landscape. Rotate to portrait (trying
 * both directions and keeping whichever OCRs to more lines) so the parser sees
 * the receipt upright. No-op for images already in portrait.
 */
export async function rotatePortrait(uri: string): Promise<string> {
    const dims = await new Promise<{ width: number; height: number }>(
        (resolve, reject) => {
            Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
        },
    );
    if (dims.height >= dims.width) return uri;
    const [cw, ccw] = await Promise.all([
        ImageManipulator.manipulateAsync(uri, [{ rotate: 90 }], {
            compress: 1,
            format: ImageManipulator.SaveFormat.JPEG,
        }),
        ImageManipulator.manipulateAsync(uri, [{ rotate: -90 }], {
            compress: 1,
            format: ImageManipulator.SaveFormat.JPEG,
        }),
    ]);
    const [ocrCW, ocrCCW] = await Promise.all([
        TextRecognition.recognize(cw.uri),
        TextRecognition.recognize(ccw.uri),
    ]);
    const countLines = (r: { blocks: { lines: unknown[] }[] }) =>
        r.blocks.reduce((s, b) => s + b.lines.length, 0);
    return countLines(ocrCW) >= countLines(ocrCCW) ? cw.uri : ccw.uri;
}

export interface CropResult {
    uri: string;
    width: number;
    height: number;
}

/**
 * Crop a captured receipt photo down to just the receipt, using the OCR text
 * geometry as a cheap, dependency-free edge detector: the union of all text
 * boxes (with padding) is the receipt's printed region; everything outside it
 * is background (table, hand, shadow). This avoids pulling in OpenCV / a native
 * contour detector while still isolating the receipt in the common guided-scan
 * case where text fills the paper top-to-bottom.
 *
 * `lines` MUST be in `uri`'s pixel space (i.e. the `allLines` that
 * `ocrReceiptPages` returns for this same page). Horizontal bounds use the
 * 5th/95th percentile so a single stray background read can't balloon the box;
 * vertical bounds keep the full text span. Returns the original uri unchanged
 * when there's too little text to trust a crop or the content already fills the
 * frame.
 */
export async function cropToContentBounds(
    uri: string,
    lines: LineWithFrame[],
    pageWidth: number,
    pageHeight: number,
): Promise<CropResult> {
    if (lines.length < 4 || pageWidth <= 0 || pageHeight <= 0) {
        return { uri, width: pageWidth, height: pageHeight };
    }

    let top = Infinity;
    let bottom = -Infinity;
    const lefts: number[] = [];
    const rights: number[] = [];
    for (const l of lines) {
        if (l.yTop < top) top = l.yTop;
        if (l.yBottom > bottom) bottom = l.yBottom;
        lefts.push(l.xLeft);
        rights.push(l.xRight);
    }
    lefts.sort((a, b) => a - b);
    rights.sort((a, b) => a - b);
    const pct = (arr: number[], p: number) =>
        arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
    let left = pct(lefts, 0.05);
    let right = pct(rights, 0.95);

    // Pad outward so the printed edge / a clipped last char is never shaved.
    const padX = pageWidth * 0.05;
    const padY = pageHeight * 0.02;
    left = Math.max(0, left - padX);
    right = Math.min(pageWidth, right + padX);
    top = Math.max(0, top - padY);
    bottom = Math.min(pageHeight, bottom + padY);

    const cropW = Math.round(right - left);
    const cropH = Math.round(bottom - top);
    // Degenerate, or already ~full-frame → not worth a re-encode.
    if (cropW < 24 || cropH < 24) {
        return { uri, width: pageWidth, height: pageHeight };
    }
    if (cropW >= pageWidth * 0.96 && cropH >= pageHeight * 0.96) {
        return { uri, width: pageWidth, height: pageHeight };
    }

    const out = await ImageManipulator.manipulateAsync(
        uri,
        [{ crop: { originX: Math.round(left), originY: Math.round(top), width: cropW, height: cropH } }],
        { compress: 0.95, format: ImageManipulator.SaveFormat.JPEG },
    );
    return { uri: out.uri, width: out.width, height: out.height };
}

// ── FUSED-ROW STRIP RE-OCR (document mode) ─────────────────────────────────
// Vision/ML Kit occasionally merge two printed rows into ONE double-height
// garbled line even when the pixels are pristine and cleanly separated — a
// layout-specific line-GROUPING failure (0AE04F24: the short "RIMI SMART, 1 l"
// row chained into "Makaronai be glitimo BARILLA" below it at every image
// quality, while the identical product block on 26117700 read perfectly).
// The cure is context isolation: crop exactly the fused box's y-range and
// re-OCR the strip alone — with nothing to mis-group against, engines read
// isolated strips reliably. The strip's lines then REPLACE everything whose
// center falls in that range (the fused box AND partial duplicate reads like
// a lone "Makaronai" or the same-row price, which the full-width strip
// re-reads). Fail-safe: the splice is accepted only when the strip read is
// demonstrably better — otherwise the fused box stays and the parser-side
// quarantine handles it exactly as before.

const isFusedBodyText = (l: { text: string }): boolean =>
    l.text.trim().length >= 8 && l.text.trim().includes(' ');

export interface FusedStripPlan {
    /** Crop bounds (page-local px). */
    top: number;
    bottom: number;
    /** The fused line's text (for logging). */
    fusedText: string;
    /** Indices (into the page's line array) replaced by the strip's read. */
    replacedIdx: number[];
    /** Median body-line height (acceptance check reuses it). */
    medianH: number;
}

/**
 * Pure planner: find fused boxes (double-height body lines spanning two
 * mutually-disjoint rows — same signature as the Rimi parser / ensemble
 * detectors) and compute for each the strip bounds + the lines the strip
 * replaces. Exported for tests.
 */
export function planFusedStrips(
    lines: { text: string; yTop: number; yBottom: number }[],
    pageHeight: number,
): FusedStripPlan[] {
    const hs = lines
        .filter(isFusedBodyText)
        .map((l) => l.yBottom - l.yTop)
        .filter((h) => h > 0)
        .sort((a, b) => a - b);
    if (hs.length < 8) return [];
    const medianH = hs[Math.floor(hs.length / 2)];
    if (!(medianH > 0)) return [];

    const spansTwoRows = (c: { yTop: number; yBottom: number }): boolean => {
        const inside = lines.filter((o) => {
            if (o === c) return false;
            const oh = o.yBottom - o.yTop;
            if (oh <= 0) return false;
            const ov = Math.min(o.yBottom, c.yBottom) - Math.max(o.yTop, c.yTop);
            return ov >= 0.6 * oh;
        });
        for (let a = 0; a < inside.length; a++) {
            for (let b = a + 1; b < inside.length; b++) {
                const la = inside[a], lb = inside[b];
                const ov = Math.min(la.yBottom, lb.yBottom) - Math.max(la.yTop, lb.yTop);
                const minH = Math.min(la.yBottom - la.yTop, lb.yBottom - lb.yTop);
                if (ov < 0.3 * minH) return true;
            }
        }
        return false;
    };

    const plans: FusedStripPlan[] = [];
    const claimed = new Set<number>();
    for (let i = 0; i < lines.length && plans.length < 4; i++) {
        const l = lines[i];
        const h = l.yBottom - l.yTop;
        if (!isFusedBodyText(l)) continue;
        if (h < 1.75 * medianH || h > 3.5 * medianH) continue;
        if (!spansTwoRows(l)) continue;
        if (claimed.has(i)) continue;
        const pad = Math.max(6, Math.round(0.12 * h));
        const top = Math.max(0, Math.round(l.yTop - pad));
        const bottom = Math.min(pageHeight, Math.round(l.yBottom + pad));
        if (bottom - top < 20) continue;
        const replacedIdx: number[] = [];
        for (let j = 0; j < lines.length; j++) {
            const c = (lines[j].yTop + lines[j].yBottom) / 2;
            if (c >= top && c <= bottom) {
                replacedIdx.push(j);
                claimed.add(j);
            }
        }
        plans.push({ top, bottom, fusedText: l.text, replacedIdx, medianH });
    }
    return plans;
}

/** Accept a strip read only when it is demonstrably BETTER than what it
 *  replaces: no line still fused-tall, at least two distinct rows, and it
 *  covers the replaced text (≥70% of the character mass, ≥ as many lines).
 *  Exported for tests. */
export function stripReadAcceptable(
    stripLines: { text: string; yTop: number; yBottom: number }[],
    replaced: { text: string }[],
    medianH: number,
): boolean {
    if (stripLines.length < Math.max(2, replaced.length)) return false;
    if (stripLines.some((l) => isFusedBodyText(l) && l.yBottom - l.yTop >= 1.75 * medianH)) return false;
    const sorted = [...stripLines].sort((a, b) => a.yTop - b.yTop);
    let rows = 1;
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1], cur = sorted[i];
        const ov = Math.min(prev.yBottom, cur.yBottom) - Math.max(prev.yTop, cur.yTop);
        if (ov < 0.5 * Math.min(prev.yBottom - prev.yTop, cur.yBottom - cur.yTop)) rows++;
    }
    if (rows < 2) return false;
    const removedLen = replaced.reduce((s, l) => s + l.text.trim().length, 0);
    const gotLen = stripLines.reduce((s, l) => s + l.text.trim().length, 0);
    return gotLen >= 0.7 * removedLen;
}

export async function reocrFusedRows(
    pageUri: string,
    pageWidth: number,
    pageHeight: number,
    lines: LineWithFrame[],
    engine: OcrEngine,
): Promise<LineWithFrame[]> {
    const plans = planFusedStrips(lines, pageHeight);
    if (plans.length === 0) return lines;
    const dropIdx = new Set<number>();
    const spliced: LineWithFrame[] = [];
    for (const plan of plans) {
        try {
            const strip = await ImageManipulator.manipulateAsync(
                pageUri,
                [{ crop: { originX: 0, originY: plan.top, width: pageWidth, height: plan.bottom - plan.top } }],
                { compress: 1, format: ImageManipulator.SaveFormat.PNG },
            );
            const stripOcr = await ocrImageEnhanced(strip.uri, engine, { document: true });
            const offY = (v: number | undefined) => (v == null ? undefined : v + plan.top);
            const remapped: LineWithFrame[] = stripOcr.lines.map((l) => ({
                text: l.text,
                yTop: l.yTop + plan.top,
                yBottom: l.yBottom + plan.top,
                xLeft: l.xLeft,
                xRight: l.xRight,
                yLeftTop: offY(l.yLeftTop),
                yRightTop: offY(l.yRightTop),
                yLeftBottom: offY(l.yLeftBottom),
                yRightBottom: offY(l.yRightBottom),
                words: l.words?.map((w) => ({
                    ...w, yTop: w.yTop + plan.top, yBottom: w.yBottom + plan.top,
                    cornerPoints: w.cornerPoints?.map((p) => ({ x: p.x, y: p.y + plan.top })),
                })),
            }));
            const replaced = plan.replacedIdx.map((i) => lines[i]);
            if (stripReadAcceptable(remapped, replaced, plan.medianH)) {
                plan.replacedIdx.forEach((i) => dropIdx.add(i));
                spliced.push(...remapped);
                console.log(
                    `[fusedReocr] strip y${plan.top}-${plan.bottom}: ${replaced.length}→${remapped.length} lines; ` +
                    `"${plan.fusedText.slice(0, 32)}" → ${remapped.map((l) => `"${l.text.slice(0, 24)}"`).join(' | ')}`,
                );
            } else {
                console.log(
                    `[fusedReocr] strip y${plan.top}-${plan.bottom} REJECTED (kept fused box "${plan.fusedText.slice(0, 32)}")`,
                );
            }
        } catch (e) {
            console.log('[fusedReocr] strip failed (kept original):', e);
        }
    }
    if (dropIdx.size === 0) return lines;
    const out = lines.filter((_, i) => !dropIdx.has(i)).concat(spliced);
    out.sort((a, b) => a.yTop - b.yTop);
    return out;
}

/**
 * OCR every page (rotating to portrait + auto-tiling tall images via
 * `ocrImageTiled`), concatenate with per-page y-offsets so multi-page e-receipts
 * parse as one document, then run the adjacent-row merge.
 */
export async function ocrReceiptPages(
    imageUris: string[],
    engine: OcrEngine = 'auto',
    opts: { document?: boolean } = {},
): Promise<ReceiptOcrResult> {
    const allLines: LineWithFrame[] = [];
    const pageMetas: ReceiptOcrPageMeta[] = [];
    let frameScale = 1;
    let yOffset = 0;
    let firstPageUri = imageUris[0] ?? "";
    let firstPageWidth = 0;
    let firstPageHeight = 0;

    for (let pageIdx = 0; pageIdx < imageUris.length; pageIdx++) {
        const pageUri = await rotatePortrait(imageUris[pageIdx]);
        const ocr = await ocrImageEnhanced(pageUri, engine, opts);
        if (pageIdx === 0) {
            frameScale = ocr.frameScale;
            firstPageUri = pageUri;
            firstPageWidth = ocr.pixelWidth;
            firstPageHeight = ocr.pixelHeight;
        }

        // Document pages only: heal fused double-height boxes by re-OCRing
        // their strip in isolation (photos skew-inflate boxes and never enter
        // planFusedStrips' two-disjoint-rows signature reliably — and their
        // recovery path is the Android whole-section re-OCR instead).
        const pageLines = opts.document
            ? await reocrFusedRows(pageUri, ocr.pixelWidth, ocr.pixelHeight, ocr.lines as LineWithFrame[], engine)
            : (ocr.lines as LineWithFrame[]);

        let pageMaxYScaled = 0;
        const off = (v: number | undefined) => (v == null ? undefined : v + yOffset);
        for (const line of pageLines) {
            if (line.yBottom > pageMaxYScaled) pageMaxYScaled = line.yBottom;
            allLines.push({
                text: line.text,
                yTop: line.yTop + yOffset,
                yBottom: line.yBottom + yOffset,
                xLeft: line.xLeft,
                xRight: line.xRight,
                yLeftTop: off(line.yLeftTop),
                yRightTop: off(line.yRightTop),
                yLeftBottom: off(line.yLeftBottom),
                yRightBottom: off(line.yRightBottom),
                words: line.words?.map((w) => ({
                    ...w, yTop: w.yTop + yOffset, yBottom: w.yBottom + yOffset,
                    cornerPoints: w.cornerPoints?.map((p) => ({ x: p.x, y: p.y + yOffset })),
                })),
            });
        }
        const xb = computeReceiptXBoundsForPage(pageLines, ocr.pixelWidth, `PAGE ${pageIdx + 1}`);
        pageMetas.push({
            uri: pageUri,
            pixelWidth: ocr.pixelWidth,
            pixelHeight: ocr.pixelHeight,
            frameScale: ocr.frameScale,
            yOffsetScaled: yOffset,
            pageMaxYScaled,
            receiptXLeftScaled: xb.left,
            receiptXRightScaled: xb.right,
        });
        yOffset += pageMaxYScaled + 50;
    }

    allLines.sort((a, b) => a.yTop - b.yTop);

    const mergedLines: LineWithFrame[] = [];
    const PRICE_RE = /^\d+[.,]\s?\d{2}\s*[AB]\s*$/;
    const ROW_THRESHOLD = 30 * frameScale;

    for (const line of allLines) {
        if (mergedLines.length > 0) {
            const last = mergedLines[mergedLines.length - 1];
            if (Math.abs(line.yTop - last.yTop) < ROW_THRESHOLD) {
                if (PRICE_RE.test(line.text)) {
                    mergedLines.push({ ...line });
                } else if (PRICE_RE.test(last.text)) {
                    mergedLines.splice(mergedLines.length - 1, 0, { ...line });
                } else {
                    last.text = last.text + " " + line.text;
                    last.yTop = Math.min(last.yTop, line.yTop);
                    last.yBottom = Math.max(last.yBottom, line.yBottom);
                    last.xLeft = Math.min(last.xLeft, line.xLeft);
                    last.xRight = Math.max(last.xRight, line.xRight);
                    // Merge the word boxes too (kept x-sorted) so a row split by OCR
                    // into two lines still exposes every word for band anchoring.
                    if (line.words?.length) {
                        last.words = [...(last.words ?? []), ...line.words].sort((a, b) => a.xLeft - b.xLeft);
                    }
                }
                continue;
            }
        }
        mergedLines.push({ ...line });
    }

    return { allLines, mergedLines, frameScale, firstPageUri, firstPageWidth, firstPageHeight, pageMetas };
}
