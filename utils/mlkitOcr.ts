import TextRecognition from '@react-native-ml-kit/text-recognition';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image, Platform } from 'react-native';
import { devLog } from './devLog';
import { normalizeLithuanianText } from '@shared/parsers/normalizeLithuanianText';
import { visionOcrAvailable, visionRecognize } from './visionOcr';
import { makeOcrVariants, preprocessAvailable } from './imagePreprocess';

// ── OCR engine ──────────────────────────────────────────────────────────────
// iOS uses Apple Vision (native module souply-vision-ocr); Android uses Google
// ML Kit. Both return the same block/line/element shape so the parser is engine-
// agnostic. The `visionOcrAvailable()` guard is a presence check only (it's true
// on any iOS build with the module) — there is no MLKit-on-iOS fallback toggle;
// if the module were somehow absent it degrades to ML Kit rather than crash.
type MlkitResult = Awaited<ReturnType<typeof TextRecognition.recognize>>;

/** Which recognizer reads the pixels. 'auto' = the platform primary (iOS: Apple
 *  Vision when the module is present; Android: ML Kit). 'mlkit' forces ML Kit —
 *  the PHASE-5 second opinion on iOS: the two engines misread DIFFERENTLY, so a
 *  parse that fails self-verification under Vision gets re-read by ML Kit and the
 *  receipt's own arithmetic picks the better result (see receipt-process). */
export type OcrEngine = 'auto' | 'vision' | 'mlkit';

async function recognizeText(uri: string, engine: OcrEngine = 'auto'): Promise<MlkitResult> {
    const wantVision = engine === 'vision' || (engine === 'auto' && Platform.OS === 'ios');
    if (wantVision && visionOcrAvailable()) {
        return (await visionRecognize(uri)) as unknown as MlkitResult;
    }
    return TextRecognition.recognize(uri);
}

/** Per-WORD box (MLKit element). Lets a parser anchor a band to a specific
 *  word (e.g. the "Kvito" and "Kasa" that bracket the receipt-number line)
 *  instead of the whole line's frame. All coords are in the same scaled,
 *  y-offset image space as the line. */
export interface OcrWord {
    text: string;
    xLeft: number;
    xRight: number;
    yTop: number;
    yBottom: number;
    // SPIKE (read-only): raw MLKit ELEMENT cornerPoints, scaled into the same image
    // space as the frame. MLKit returns them clockwise from top-left [TL,TR,BR,BL].
    // Captured to test whether per-word corners encode the receipt rotation (the
    // LINE-level corners come back flat). Not consumed by the parser — dev dump only.
    cornerPoints?: { x: number; y: number }[];
}

export interface OcrLine {
    text: string;
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
    // Skew-aware edge Y from MLKit cornerPoints: the line's top/bottom Y at its
    // LEFT edge vs its RIGHT edge. On a tilted photo these differ, letting the
    // detail view draw bands that follow the tilt. Absent → caller falls back to
    // the axis-aligned yTop/yBottom.
    yLeftTop?: number;
    yRightTop?: number;
    yLeftBottom?: number;
    yRightBottom?: number;
    // Per-word boxes (MLKit elements), for word-anchored bands.
    words?: OcrWord[];
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

// Android-only: UPSCALE a small capture so body glyphs clear MLKit's ~16-24px
// per-char floor. ML Kit has no sensitivity knob — a faint/stained date or
// product name on a low-res capture is exactly what it silently drops, and the
// recognizer's CNN works best near its trained glyph scale. Upscaling never
// hurts (coords scale straight back via invFactor) and the tiler still caps each
// tile under the 4096px downsample limit. Capped to avoid ballooning a tall
// receipt into excessive tiles.
const ANDROID_MIN_OCR_WIDTH = 1280;
const ANDROID_MAX_UPSCALE = 2;

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
// Count of "real" characters — a proxy for how complete a recognised line is,
// used to pick the best read of the same physical line across preprocess variants.
const alnumCount = (s: string): number =>
    (s.match(/[A-Za-z0-9ĄČĘĖĮŠŲŪŽąčęėįšųūž]/g) || []).length;

/** Cheap degradation signal: a healthy receipt OCR always surfaces a date AND a
 *  decimal amount. Missing either ⇒ the scan is degraded enough to justify the
 *  extra preprocess-variant passes. Conservative on purpose (clean receipts skip
 *  the cost). */
function isDegradedOcr(result: OcrResult): boolean {
    const text = result.lines.map((l) => l.text).join('\n');
    const hasDate = /\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4}/.test(text);
    const hasAmount = /\d+[.,]\d{2}\b/.test(text);
    return !hasDate || !hasAmount;
}

/** Fuse several OCR passes of the SAME page (base + preprocess variants, all in
 *  the same pixel space). Cluster lines by vertical position + horizontal
 *  overlap and keep the most-complete read per physical line — so a stained word
 *  recovered by the destain pass replaces the base pass's partial read, while
 *  clean lines are unchanged. */
function fuseOcrResults(results: OcrResult[]): OcrResult {
    const base = results[0];
    const all = results.flatMap((r) => r.lines);
    if (all.length === 0) return base;
    const heights = all.map((l) => l.yBottom - l.yTop).filter((h) => h > 0).sort((a, b) => a - b);
    const medH = heights[Math.floor(heights.length / 2)] || 24;
    const yTol = medH * 0.5;
    const sorted = [...all].sort((a, b) => a.yTop - b.yTop);
    const used = new Array(sorted.length).fill(false);
    const fused: OcrLine[] = [];
    for (let i = 0; i < sorted.length; i++) {
        if (used[i]) continue;
        const seedTop = sorted[i].yTop;
        let best = sorted[i];
        let bestScore = alnumCount(best.text);
        used[i] = true;
        for (let j = i + 1; j < sorted.length; j++) {
            if (used[j]) continue;
            const o = sorted[j];
            if (o.yTop - seedTop > medH) break; // sorted by yTop ⇒ cluster is done
            const yClose = Math.abs((o.yTop + o.yBottom) / 2 - (best.yTop + best.yBottom) / 2) <= yTol;
            const xOverlap = Math.min(best.xRight, o.xRight) - Math.max(best.xLeft, o.xLeft);
            const minW = Math.min(best.xRight - best.xLeft, o.xRight - o.xLeft);
            if (yClose && xOverlap > 0.5 * minW) {
                used[j] = true;
                const s = alnumCount(o.text);
                if (s > bestScore) { best = o; bestScore = s; }
            }
        }
        fused.push(best);
    }
    fused.sort((a, b) => a.yTop - b.yTop);
    return { ...base, lines: fused };
}

// Re-scale a variant's line coords back to the BASE pixel space so all passes
// fuse in one coordinate system (the upscaled variant is rendered larger).
function scaleLinesToWidth(result: OcrResult, toWidth: number): OcrResult {
    const f = result.pixelWidth > 0 ? toWidth / result.pixelWidth : 1;
    if (Math.abs(f - 1) < 1e-3) return result;
    const sc = (v: number | undefined) => (v == null ? undefined : v * f);
    return {
        ...result,
        lines: result.lines.map((l) => ({
            ...l,
            yTop: l.yTop * f, yBottom: l.yBottom * f, xLeft: l.xLeft * f, xRight: l.xRight * f,
            yLeftTop: sc(l.yLeftTop), yRightTop: sc(l.yRightTop),
            yLeftBottom: sc(l.yLeftBottom), yRightBottom: sc(l.yRightBottom),
            words: l.words?.map((w) => ({
                ...w, xLeft: w.xLeft * f, xRight: w.xRight * f, yTop: w.yTop * f, yBottom: w.yBottom * f,
            })),
        })),
    };
}

// Upscale a degraded receipt past this width for the recovery re-OCR pass — more
// pixels per glyph gives ML Kit's CNN a better shot at faint/misread text (e.g. a
// thermal date it garbled to "226-D6-19"). Bounded so a tall receipt stays sane.
const FUSION_UPSCALE_TARGET = 2600;

/**
 * OCR entry with degraded-receipt recovery (Android / ML Kit only). Runs the
 * normal pass; if it looks degraded, re-OCRs extra whole-receipt variants and
 * keeps the most-complete read per line:
 *   • an UPSCALED pass — BUILD-FREE (expo-image-manipulator), so it runs today;
 *   • Skia destain + contrast passes — only once @shopify/react-native-skia is in
 *     the build (the blue-stain cure).
 * Falls straight back to the base result when not degraded or on iOS (Apple
 * Vision) — so it can never regress the happy path. THIS is the funnel the
 * pipeline calls.
 */
export async function ocrImageEnhanced(uri: string, engine: OcrEngine = 'auto'): Promise<OcrResult> {
    const base = await ocrImageTiled(uri, engine);
    if (Platform.OS !== 'android' || !isDegradedOcr(base)) return base;

    const variants: OcrResult[] = [];

    // (1) Build-free upscaled re-OCR — the lever that needs no native build.
    if (base.pixelWidth > 0 && base.pixelWidth < FUSION_UPSCALE_TARGET) {
        try {
            const factor = Math.min(FUSION_UPSCALE_TARGET / base.pixelWidth, 2);
            const up = await ImageManipulator.manipulateAsync(
                uri,
                [{ resize: { width: Math.round(base.pixelWidth * factor) } }],
                { compress: 0.95, format: ImageManipulator.SaveFormat.JPEG },
            );
            variants.push(scaleLinesToWidth(await ocrImageTiled(up.uri, engine), base.pixelWidth));
        } catch { /* skip — recovery is best-effort */ }
    }

    // (2) Skia destain/contrast (same dims as base) — present only after the build.
    if (preprocessAvailable()) {
        for (const v of await makeOcrVariants(uri)) {
            try { variants.push(await ocrImageTiled(v, engine)); } catch { /* skip */ }
        }
    }

    if (variants.length === 0) return base;
    const fused = fuseOcrResults([base, ...variants]);
    devLog('mlkitOcr.fused', {
        variants: variants.length,
        baseLines: base.lines.length,
        fusedLines: fused.lines.length,
    });
    return fused;
}

export async function ocrImageTiled(uri: string, engine: OcrEngine = 'auto'): Promise<OcrResult> {
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
    // iOS DOWNSCALES wide images (row-fragmentation mitigation); Android UPSCALES
    // small captures up to the glyph-size floor. Both re-encode a one-off OCR
    // input and remap coords back to original space via invFactor below.
    let targetWidth: number | null = null;
    if (Platform.OS === 'ios' && trueWidth > IOS_MAX_WIDTH) {
        targetWidth = IOS_MAX_WIDTH;
    } else if (Platform.OS === 'android' && trueWidth > 0 && trueWidth < ANDROID_MIN_OCR_WIDTH) {
        const factor = Math.min(ANDROID_MIN_OCR_WIDTH / trueWidth, ANDROID_MAX_UPSCALE);
        targetWidth = Math.round(trueWidth * factor);
    }
    let workingUri = info.uri;
    let workingWidth = trueWidth;
    let workingHeight = trueHeight;
    let resizeFactor = 1;
    if (targetWidth != null && targetWidth !== trueWidth) {
        const resized = await ImageManipulator.manipulateAsync(
            info.uri,
            [{ resize: { width: targetWidth } }],
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
    const sc = (v: number | undefined) => (v == null ? undefined : v * invFactor);
    const remap = (line: OcrLine): OcrLine => (
        resizeFactor === 1
            ? line
            : {
                  text: line.text,
                  yTop: line.yTop * invFactor,
                  yBottom: line.yBottom * invFactor,
                  xLeft: line.xLeft * invFactor,
                  xRight: line.xRight * invFactor,
                  yLeftTop: sc(line.yLeftTop),
                  yRightTop: sc(line.yRightTop),
                  yLeftBottom: sc(line.yLeftBottom),
                  yRightBottom: sc(line.yRightBottom),
                  words: line.words?.map((w) => ({
                      text: w.text,
                      xLeft: w.xLeft * invFactor,
                      xRight: w.xRight * invFactor,
                      yTop: w.yTop * invFactor,
                      yBottom: w.yBottom * invFactor,
                  })),
              }
    );

    // Short image — single-shot path matches the legacy pipeline so
    // existing parser/RegionPreview math stays valid.
    if (workingHeight <= TILING_THRESHOLD) {
        const res = await runMlkitOnUri(srcUri, 0, workingWidth, workingHeight, engine);
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
            return runMlkitOnUri(tile.uri, yStart, tile.width, tile.height, engine);
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
    engine: OcrEngine = 'auto',
): Promise<RawOcrResult> {
    const pageResult = await recognizeText(uri, engine);

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

    // Per-line tilt from per-word ELEMENT frames. MLKit often returns the LINE's
    // cornerPoints FLAT even on visibly skewed text, but each word's axis-aligned
    // `frame` steps down with the skew — so the leftmost+rightmost words give the
    // REAL left/right Y, i.e. the real slope of THAT line. We keep tilt PER-LINE
    // (the receipt curves — less skew at the top, more at the bottom; one global
    // angle is wrong) but make it SMOOTH and robust:
    //   1. measure each line's own slope from its words,
    //   2. lines with too few words inherit the nearest measured slope (no flat
    //      fallback — flat-vs-skew jumps were the trapezoid mess),
    //   3. median-smooth over 3 neighbours so a garbled line can't spike the tilt.
    type ElFrame = { top: number; left: number; width: number; height: number };
    interface RawLine {
        text: string;
        frame: ElFrame;
        slope: number | null;   // own element slope (px/px), or null when unmeasurable
        textH: number;          // per-word text height (the line box is inflated by tilt)
        els: { text: string; frame: ElFrame; corners?: { x: number; y: number }[] }[]; // per-word boxes, left→right
    }
    const raws: RawLine[] = [];
    for (const block of pageResult.blocks) {
        for (const line of block.lines) {
            if (!line.frame || !line.text.trim()) continue;
            const els = ((line as { elements?: { text?: string; frame?: ElFrame; cornerPoints?: { x: number; y: number }[] }[] }).elements ?? [])
                .filter((e): e is { text?: string; frame: ElFrame; cornerPoints?: { x: number; y: number }[] } => !!e.frame && e.frame.width > 0 && e.frame.height > 0)
                .map((e) => ({ text: (e.text ?? '').trim(), frame: e.frame, corners: e.cornerPoints }))
                .sort((a, b) => a.frame.left - b.frame.left);
            let slope: number | null = null;
            let textH = line.frame.height;
            if (els.length >= 2) {
                const L = els[0].frame, R = els[els.length - 1].frame;
                textH = (L.height + R.height) / 2;
                // SHEAR-PROOF slope: median of ADJACENT-element-pair slopes, skipping
                // pairs separated by a large x-gap. A receipt line that glues the NAME
                // column to the PRICE column ("DEPOZI TAS  0, 10") has one huge
                // cross-column pair whose leftmost-vs-rightmost "slope" measures the
                // OCR column SHEAR, not the paper tilt — and steps (2)+(3) below then
                // spread that poison to neighbouring lines. The corners synthesized
                // from it scrambled the parser's de-skew (receipt-232: interleaved
                // names + bands pivoting up on a perfectly straight photo). Intra-
                // column adjacent pairs pass the gap cap; the cross-gap pair doesn't.
                const span = (R.left + R.width) - L.left || 1;
                const gapCap = Math.max(120, span * 0.25);
                const pairSlopes: number[] = [];
                for (let k = 1; k < els.length; k++) {
                    const a = els[k - 1].frame, b = els[k].frame;
                    const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
                    if (dx < 8 || b.left - (a.left + a.width) > gapCap) continue;
                    pairSlopes.push((b.top - a.top) / dx);
                }
                if (pairSlopes.length) {
                    pairSlopes.sort((x, y) => x - y);
                    const m = Math.floor(pairSlopes.length / 2);
                    slope = pairSlopes.length % 2 ? pairSlopes[m] : (pairSlopes[m - 1] + pairSlopes[m]) / 2;
                }
            }
            raws.push({
                // Normalize to Lithuanian alphabet before any parser sees the text
                // (iOS MLKit emits non-Lithuanian Latin diacritics — pure OCR
                // confusions; mapping them back avoids cascading failures).
                text: normalizeLithuanianText(line.text.trim()),
                frame: line.frame,
                slope,
                textH,
                els,
            });
        }
    }
    raws.sort((a, b) => a.frame.top - b.frame.top); // y order, for slope continuity
    // (2) fill unmeasured slopes from the nearest measured neighbour
    const measured = raws.map((r, i) => (r.slope != null ? i : -1)).filter((i) => i >= 0);
    const filled = raws.map((r, i) => {
        if (r.slope != null) return Math.max(-0.15, Math.min(0.15, r.slope));
        if (measured.length === 0) return 0;
        let best = measured[0];
        for (const k of measured) if (Math.abs(k - i) < Math.abs(best - i)) best = k;
        return Math.max(-0.15, Math.min(0.15, raws[best].slope!));
    });
    // (3) median-smooth over 3 neighbours so one garbled row can't spike the tilt
    const slopeAt = (i: number) => {
        const a = filled[Math.max(0, i - 1)], b = filled[i], c = filled[Math.min(filled.length - 1, i + 1)];
        return [a, b, c].sort((x, y) => x - y)[1];
    };

    const sy = (v: number) => v * frameScale + yOffset;
    const lines: OcrLine[] = raws.map((r, i) => {
        const f = r.frame;
        const span = slopeAt(i) * f.width;                          // signed tilt across THIS line
        const textH = Math.min(f.height, Math.max(4, r.textH));     // actual text height
        // Axis box TOP = the higher corner; the parallelogram tilts by `span`.
        const topL = f.top + Math.max(0, -span);
        const topR = f.top + Math.max(0, span);
        const yLeftTop = sy(topL), yRightTop = sy(topR);
        const yLeftBottom = sy(topL + textH), yRightBottom = sy(topR + textH);
        const words: OcrWord[] = r.els.map((e) => ({
            text: e.text,
            xLeft: e.frame.left * frameScale,
            xRight: (e.frame.left + e.frame.width) * frameScale,
            yTop: sy(e.frame.top),
            yBottom: sy(e.frame.top + e.frame.height),
            // SPIKE: scale the raw element corners into the same space as the frame.
            cornerPoints: e.corners?.map((p) => ({ x: p.x * frameScale, y: sy(p.y) })),
        }));
        return {
            text: r.text,
            yTop: Math.min(yLeftTop, yRightTop),
            yBottom: Math.max(yLeftBottom, yRightBottom),
            xLeft: f.left * frameScale,
            xRight: (f.left + f.width) * frameScale,
            yLeftTop, yRightTop, yLeftBottom, yRightBottom,
            words: words.length ? words : undefined,
        };
    });
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
