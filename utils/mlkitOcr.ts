import TextRecognition from '@react-native-ml-kit/text-recognition';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image, Platform } from 'react-native';
import { devLog } from './devLog';
import { normalizeLithuanianText } from '@shared/parsers/normalizeLithuanianText';

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
// Tile geometry differs by platform because MLKit's iOS line/block
// grouping is empirically more aggressive at splitting same-row text
// from same-row price into separate blocks when the horizontal gap
// between them is large in pixels. Smaller tiles + a target image
// width compress that gap and tend to keep rows intact. Android's
// grouping is fine at native res, so its constants stay unchanged.
const TILE_HEIGHT = Platform.OS === 'ios' ? 1500 : 3000;
const TILE_OVERLAP = Platform.OS === 'ios' ? 150 : 300;
const TILING_THRESHOLD = Platform.OS === 'ios' ? 1800 : 3500;

// iOS-only target width for the recognizer's input. Phone-photographed
// Maxima receipts come in around 3000–4000 px wide; downsampling them
// to ~1500 px halves MLKit's perceived text-to-price column gap and,
// in spot-tests, dramatically reduces row fragmentation. Coords are
// scaled back to the original image space before returning so the
// parser + band-crop pipeline keep working in source-image
// coordinates.
const IOS_MAX_WIDTH = 1500;
const IOS_TILE_JPEG_QUALITY = 0.92;

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

    // iOS-only: downscale wide images before feeding them to MLKit.
    // The phone-side image stays untouched on disk; this is a one-off
    // re-encode for the recognizer pass. Coords come back in the
    // resized space and get scaled to the original at the end so
    // every downstream consumer (parser, RegionPreview, BandCropImage)
    // continues to work in source-image coordinates.
    const needsResize =
        Platform.OS === 'ios' && trueWidth > IOS_MAX_WIDTH;
    let workingUri = info.uri;
    let workingWidth = trueWidth;
    let workingHeight = trueHeight;
    let resizeFactor = 1;
    if (needsResize) {
        const resized = await ImageManipulator.manipulateAsync(
            info.uri,
            [{ resize: { width: IOS_MAX_WIDTH } }],
            { compress: IOS_TILE_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
        );
        workingUri = resized.uri;
        workingWidth = resized.width;
        workingHeight = resized.height;
        resizeFactor = workingWidth / trueWidth;
        devLog('mlkitOcr.resize', {
            origWidth: trueWidth,
            origHeight: trueHeight,
            workingWidth,
            workingHeight,
            resizeFactor,
        });
    }
    // Use the working URI for OCR (resized on iOS, original on
    // Android). On some Android devices passing the original
    // content:// URI to MLKit re-triggers BitmapFactory sampling even
    // though the file on disk is high-res; feeding ImageManipulator's
    // re-encoded file URI keeps MLKit on a file:// path with no
    // sampling surprises.
    const srcUri = workingUri;

    // Scale coords from working (resized) space back to original
    // pixel space. No-op when resizeFactor === 1.
    const invFactor = 1 / resizeFactor;
    const remap = (line: OcrLine): OcrLine => (
        resizeFactor === 1
            ? line
            : {
                  text: line.text,
                  yTop: line.yTop * invFactor,
                  yBottom: line.yBottom * invFactor,
                  xLeft: line.xLeft * invFactor,
                  xRight: line.xRight * invFactor,
              }
    );

    // Short image — single-shot path matches the legacy pipeline so
    // existing parser/RegionPreview math stays valid.
    if (workingHeight <= TILING_THRESHOLD) {
        const res = await runMlkitOnUri(srcUri, 0, workingWidth, workingHeight);
        const remapped = res.lines.map(remap);
        // Parsers assume y-sorted lines (findHeaderEnd scans the first
        // ~20 entries for `#NNNNN` / `Kvitas N/N` markers). MLKit returns
        // blocks in reading order, not strict y-order, so sort explicitly.
        remapped.sort((a, b) => a.yTop - b.yTop);
        const summary = {
            mode: 'single-shot',
            workingWidth,
            workingHeight,
            origWidth: trueWidth,
            origHeight: trueHeight,
            frameScale: res.frameScale,
            lineCount: remapped.length,
        };
        console.log(
            `[ocr] single-shot working=${workingWidth}x${workingHeight} orig=${trueWidth}x${trueHeight} → frameScale=${res.frameScale.toFixed(3)}, ${remapped.length} lines`,
        );
        devLog('mlkitOcr.singleShot', summary);
        return {
            lines: remapped,
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
    while (y < workingHeight) {
        const h = Math.min(TILE_HEIGHT, workingHeight - y);
        tiles.push({ yStart: y, h });
        if (y + h >= workingHeight) break;
        y += TILE_HEIGHT - TILE_OVERLAP;
    }

    // OCR tiles in parallel. Each tile's result coords are returned
    // with that tile's yStart already added to yTop/yBottom. Source
    // for the crop is `srcUri` (the working image — resized on iOS,
    // original on Android) so the crop coordinates line up with
    // `workingWidth`/`workingHeight`.
    const tileResults = await Promise.all(
        tiles.map(async ({ yStart, h }) => {
            const tile = await ImageManipulator.manipulateAsync(
                srcUri,
                [
                    {
                        crop: {
                            originX: 0,
                            originY: yStart,
                            width: workingWidth,
                            height: h,
                        },
                    },
                ],
                {
                    compress: Platform.OS === 'ios' ? IOS_TILE_JPEG_QUALITY : 1,
                    format: ImageManipulator.SaveFormat.JPEG,
                },
            );
            return runMlkitOnUri(tile.uri, yStart, tile.width, tile.height);
        }),
    );

    // Merge and dedupe. Text lines that fall inside the overlap zone
    // get two reads (one from each adjacent tile); we keep the first
    // occurrence by y to avoid double-counting. Dedupe runs BEFORE
    // remap so the y-tolerance constant stays in the same coord
    // space it was tuned in (post-tiling working space).
    const allLines = tileResults.flatMap((r) => r.lines);
    const deduped = dedupeOverlap(allLines).map(remap);
    deduped.sort((a, b) => a.yTop - b.yTop);

    const scaleSummary = tileResults.map((r) => r.frameScale.toFixed(2)).join(', ');
    console.log(
        `[ocr] tiled working=${workingWidth}x${workingHeight} orig=${trueWidth}x${trueHeight} → ${tiles.length} tiles, frameScales=[${scaleSummary}], ${deduped.length} lines (${allLines.length - deduped.length} deduped)`,
    );
    devLog('mlkitOcr.tiled', {
        workingWidth,
        workingHeight,
        origWidth: trueWidth,
        origHeight: trueHeight,
        tileCount: tiles.length,
        lineCount: deduped.length,
        duped: allLines.length - deduped.length,
        resizeFactor,
    });

    return {
        lines: deduped,
        pixelWidth: trueWidth,
        pixelHeight: trueHeight,
        // When tiled, each tile's frame coords are already in that
        // tile's native pixel space (frameScale=1 per tile), and
        // offsets land them in the working image's native pixel
        // space, which we then remap to original. Callers should
        // treat this as no additional scaling needed.
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
                // Normalize to Lithuanian alphabet here, before any
                // parser sees the text. iOS MLKit emits non-Lithuanian
                // Latin diacritics on receipt fonts (`Ā`/`É`/`Ǔ` etc.)
                // that are pure OCR confusions, never legitimate on
                // Lithuanian text. Mapping them back to ą/č/ė/š/ų/ū/ž
                // or ASCII removes a class of cascading failures
                // (name-token mismatches, regex anchors that demand
                // `\p{L}` and trip on combining marks, etc.). Platform-
                // agnostic — Android lines pass through identically
                // because they rarely produce these confusions.
                lines.push({
                    text: normalizeLithuanianText(line.text.trim()),
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
