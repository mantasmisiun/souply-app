import TextRecognition from "@react-native-ml-kit/text-recognition";
import * as ImageManipulator from "expo-image-manipulator";
import { Image } from "react-native";
import { ocrImageTiled } from "./mlkitOcr";

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

/**
 * OCR every page (rotating to portrait + auto-tiling tall images via
 * `ocrImageTiled`), concatenate with per-page y-offsets so multi-page e-receipts
 * parse as one document, then run the adjacent-row merge.
 */
export async function ocrReceiptPages(imageUris: string[]): Promise<ReceiptOcrResult> {
    const allLines: LineWithFrame[] = [];
    let frameScale = 1;
    let yOffset = 0;
    let firstPageUri = imageUris[0] ?? "";
    let firstPageWidth = 0;
    let firstPageHeight = 0;

    for (let pageIdx = 0; pageIdx < imageUris.length; pageIdx++) {
        const pageUri = await rotatePortrait(imageUris[pageIdx]);
        const ocr = await ocrImageTiled(pageUri);
        if (pageIdx === 0) {
            frameScale = ocr.frameScale;
            firstPageUri = pageUri;
            firstPageWidth = ocr.pixelWidth;
            firstPageHeight = ocr.pixelHeight;
        }

        let pageMaxYScaled = 0;
        for (const line of ocr.lines) {
            if (line.yBottom > pageMaxYScaled) pageMaxYScaled = line.yBottom;
            allLines.push({
                text: line.text,
                yTop: line.yTop + yOffset,
                yBottom: line.yBottom + yOffset,
                xLeft: line.xLeft,
                xRight: line.xRight,
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
                }
                continue;
            }
        }
        mergedLines.push({ ...line });
    }

    return { allLines, mergedLines, frameScale, firstPageUri, firstPageWidth, firstPageHeight };
}
