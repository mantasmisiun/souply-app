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

/**
 * OCR every page (rotating to portrait + auto-tiling tall images via
 * `ocrImageTiled`), concatenate with per-page y-offsets so multi-page e-receipts
 * parse as one document, then run the adjacent-row merge.
 */
export async function ocrReceiptPages(imageUris: string[], engine: OcrEngine = 'auto'): Promise<ReceiptOcrResult> {
    const allLines: LineWithFrame[] = [];
    let frameScale = 1;
    let yOffset = 0;
    let firstPageUri = imageUris[0] ?? "";
    let firstPageWidth = 0;
    let firstPageHeight = 0;

    for (let pageIdx = 0; pageIdx < imageUris.length; pageIdx++) {
        const pageUri = await rotatePortrait(imageUris[pageIdx]);
        const ocr = await ocrImageEnhanced(pageUri, engine);
        if (pageIdx === 0) {
            frameScale = ocr.frameScale;
            firstPageUri = pageUri;
            firstPageWidth = ocr.pixelWidth;
            firstPageHeight = ocr.pixelHeight;
        }

        let pageMaxYScaled = 0;
        const off = (v: number | undefined) => (v == null ? undefined : v + yOffset);
        for (const line of ocr.lines) {
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

    return { allLines, mergedLines, frameScale, firstPageUri, firstPageWidth, firstPageHeight };
}
