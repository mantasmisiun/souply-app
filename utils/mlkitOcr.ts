import TextRecognition from '@react-native-ml-kit/text-recognition';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';

export interface OcrLine {
    text: string;
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
}

export interface OcrResult {
    lines: OcrLine[];
    pixelWidth: number;
    pixelHeight: number;
    frameScale: number;
    mlkitMaxX: number;
    mlkitMaxY: number;
    tiled: boolean;
    tileCount: number;
}

/**
 * MLKit on-device text recognition silently downsamples images whose
 * long edge exceeds ~4096 px (a memory-driven soft cap in the native
 * bitmap pipeline). On a phone-photographed Lidl thermal receipt
 * (~3000 × 7000) that halves or quarters character detail, eating the
 * recognizer's confidence margin on already low-contrast thermal
 * glyphs — result: whole prices and names vanish from the output.
 *
 * Fix: split tall inputs into vertical strips that each fit under the
 * cap, OCR each strip at native resolution, then merge results with
 * per-strip y-offsets applied. Overlap between strips catches text
 * that would otherwise land on a cut; dedupe drops the copies.
 *
 * Short images pass through unchanged — single-shot OCR with the
 * same scale-inference logic the inline code used before.
 */
const TILE_HEIGHT = 3000;
const TILE_OVERLAP = 300;
const TILING_THRESHOLD = 3500;
// Dedupe distance for "same text at similar y from adjacent tiles".
// Text row height is ~25-30 px on typical receipt OCR, so anything
// beyond ~40 px is a different physical row. Using TILE_OVERLAP here
// is WAY too loose — two legitimately different products with the
// same price text within ~10 rows get merged into one.
const TILE_DEDUPE_Y_TOL = 20;

/**
 * OCR an image URI, tiling vertically if it exceeds the MLKit cap.
 * Returns lines in the image's pixel coordinate space (with tile
 * y-offsets already applied for tiled runs). frameScale is retained
 * for callers that need to map back to a display-sized preview, and
 * is always 1 when tiling is active (each tile is small enough that
 * MLKit coords match the image's native pixel space).
 */
export async function ocrImageTiled(uri: string): Promise<OcrResult> {
    // Probe true pixel dims via ImageManipulator — NOT Image.getSize.
    // On Android, Image.getSize goes through BitmapFactory which auto-
    // downsamples tall bitmaps (a 1080×4885 receipt photo can come
    // back as 1080×1168, well under the tiling threshold), so probing
    // with Image.getSize would silently skip tiling on exactly the
    // inputs that need it most. ImageManipulator with an empty action
    // list returns the underlying decoder's real pixel dims.
    const info = await ImageManipulator.manipulateAsync(uri, []);
    const trueWidth = info.width;
    const trueHeight = info.height;
    // Use the ImageManipulator output URI for OCR as well — on some
    // Android devices passing the original content:// URI to MLKit
    // re-triggers BitmapFactory sampling even though the file on disk
    // is high-res; feeding ImageManipulator's re-encoded file URI
    // keeps MLKit on a file:// path with no sampling surprises.
    const srcUri = info.uri;

    // Short image — single-shot path matches the legacy pipeline so
    // existing parser/RegionPreview math stays valid.
    if (trueHeight <= TILING_THRESHOLD) {
        const res = await runMlkitOnUri(srcUri, 0, trueWidth, trueHeight);
        // Parsers assume y-sorted lines (findHeaderEnd scans the first
        // ~20 entries for `#NNNNN` / `Kvitas N/N` markers). MLKit returns
        // blocks in reading order, not strict y-order, so sort explicitly.
        res.lines.sort((a, b) => a.yTop - b.yTop);
        console.log(
            `[ocr] single-shot ${trueWidth}x${trueHeight} → frameScale=${res.frameScale.toFixed(3)}, ${res.lines.length} lines`,
        );
        return {
            lines: res.lines,
            pixelWidth: trueWidth,
            pixelHeight: trueHeight,
            frameScale: res.frameScale,
            mlkitMaxX: res.mlkitMaxX,
            mlkitMaxY: res.mlkitMaxY,
            tiled: false,
            tileCount: 1,
        };
    }

    // Build strip ranges. Each strip is TILE_HEIGHT px tall, strides
    // forward by (TILE_HEIGHT - TILE_OVERLAP) so TILE_OVERLAP pixels
    // of vertical content appears in both adjacent tiles.
    const tiles: { yStart: number; h: number }[] = [];
    let y = 0;
    while (y < trueHeight) {
        const h = Math.min(TILE_HEIGHT, trueHeight - y);
        tiles.push({ yStart: y, h });
        if (y + h >= trueHeight) break;
        y += TILE_HEIGHT - TILE_OVERLAP;
    }

    // OCR tiles in parallel. Each tile's result coords are returned
    // with that tile's yStart already added to yTop/yBottom. Source
    // for the crop is `srcUri` (ImageManipulator's re-encoded file)
    // so the crop coordinates line up with the true pixel dims we
    // just measured, not whatever size BitmapFactory would report.
    const tileResults = await Promise.all(
        tiles.map(async ({ yStart, h }) => {
            const tile = await ImageManipulator.manipulateAsync(
                srcUri,
                [
                    {
                        crop: {
                            originX: 0,
                            originY: yStart,
                            width: trueWidth,
                            height: h,
                        },
                    },
                ],
                { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
            );
            return runMlkitOnUri(tile.uri, yStart, tile.width, tile.height);
        }),
    );

    // Merge and dedupe. Text lines that fall inside the overlap zone
    // get two reads (one from each adjacent tile); we keep the first
    // occurrence by y to avoid double-counting.
    const allLines = tileResults.flatMap((r) => r.lines);
    const deduped = dedupeOverlap(allLines);
    deduped.sort((a, b) => a.yTop - b.yTop);

    const scaleSummary = tileResults.map((r) => r.frameScale.toFixed(2)).join(', ');
    console.log(
        `[ocr] tiled ${trueWidth}x${trueHeight} → ${tiles.length} tiles, frameScales=[${scaleSummary}], ${deduped.length} lines (${allLines.length - deduped.length} deduped)`,
    );

    return {
        lines: deduped,
        pixelWidth: trueWidth,
        pixelHeight: trueHeight,
        // When tiled, each tile's frame coords are already in that
        // tile's native pixel space (frameScale=1 per tile), and
        // offsets land them in the whole image's native pixel space.
        // Callers should treat this as no additional scaling needed.
        frameScale: 1,
        mlkitMaxX: Math.max(...tileResults.map((r) => r.mlkitMaxX)),
        mlkitMaxY: Math.max(...tileResults.map((r) => r.mlkitMaxY)),
        tiled: true,
        tileCount: tiles.length,
    };
}

interface RawOcrResult {
    lines: OcrLine[];
    frameScale: number;
    mlkitMaxX: number;
    mlkitMaxY: number;
}

async function runMlkitOnUri(
    uri: string,
    yOffset: number,
    refWidth: number,
    refHeight: number,
): Promise<RawOcrResult> {
    const pageResult = await TextRecognition.recognize(uri);

    let mlkitMaxX = 0;
    let mlkitMaxY = 0;
    for (const block of pageResult.blocks) {
        for (const line of block.lines) {
            if (line.frame) {
                mlkitMaxX = Math.max(mlkitMaxX, line.frame.left + line.frame.width);
                mlkitMaxY = Math.max(mlkitMaxY, line.frame.top + line.frame.height);
            }
        }
    }
    // Same power-of-2 scale inference the inline pipeline used. On a
    // tile small enough to fit under the MLKit cap, estimatedScale
    // lands at 1 (no downsample) — so frameScale=1 and MLKit coords
    // pass through untouched.
    const scaleX = mlkitMaxX > 0 ? refWidth / mlkitMaxX : 1;
    const scaleY = mlkitMaxY > 0 ? refHeight / mlkitMaxY : 1;
    const estimatedScale = Math.min(1, scaleX, scaleY);
    const roundedInv = Math.max(1, Math.min(8, Math.round(1 / estimatedScale)));
    const frameScale = 1 / roundedInv;

    const lines: OcrLine[] = [];
    for (const block of pageResult.blocks) {
        for (const line of block.lines) {
            if (line.frame && line.text.trim()) {
                lines.push({
                    text: line.text.trim(),
                    yTop: line.frame.top * frameScale + yOffset,
                    yBottom: (line.frame.top + line.frame.height) * frameScale + yOffset,
                    xLeft: line.frame.left * frameScale,
                    xRight: (line.frame.left + line.frame.width) * frameScale,
                });
            }
        }
    }
    return { lines, frameScale, mlkitMaxX, mlkitMaxY };
}

function dedupeOverlap(lines: OcrLine[]): OcrLine[] {
    // Same-text lines within TILE_DEDUPE_Y_TOL vertical distance come
    // from two adjacent tiles reading the same receipt row. Keep the
    // one with smaller yTop. The tolerance is tight (~20 px, well under
    // one receipt text line) to avoid killing legitimately-different
    // products whose price text happens to repeat (e.g. two `1,59 A`
    // rows a few products apart). n is small (tens to low hundreds)
    // so O(n²) is fine.
    const sorted = [...lines].sort((a, b) => a.yTop - b.yTop);
    const kept: OcrLine[] = [];
    for (const line of sorted) {
        const dup = kept.find(
            (k) =>
                k.text === line.text &&
                Math.abs(k.yTop - line.yTop) <= TILE_DEDUPE_Y_TOL,
        );
        if (!dup) kept.push(line);
    }
    return kept;
}
