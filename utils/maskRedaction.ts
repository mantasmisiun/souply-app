/**
 * Pure helpers for the pre-upload image redaction (P3b-2). The actual
 * compositing/capture is native (react-native-view-shot) and lives in
 * receipt-process; this module holds the coordinate math so it's unit-testable.
 */

export interface BoxBand {
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
}

/**
 * Only the bands that fall on the uploaded image are burned in. We upload
 * page 0 (a single photo, or the first PDF page); bands whose top is at/after
 * the image height belong to later pages (multi-page concat) and aren't on the
 * uploaded bitmap, so they're dropped.
 */
export const bandsForUploadedImage = <T extends { yTop: number }>(
    bands: T[],
    imageHeight: number,
): T[] => bands.filter((b) => b.yTop >= 0 && b.yTop < imageHeight);

/**
 * Percentage position of a redaction box within the image, so the offscreen
 * capture surface can be any DP size (the % keeps boxes aligned to the photo).
 */
export const maskBoxPercent = (
    b: BoxBand,
    imageWidth: number,
    imageHeight: number,
): { left: number; top: number; width: number; height: number } => {
    const w = Math.max(1, imageWidth);
    const h = Math.max(1, imageHeight);
    return {
        left: clampPct((b.xLeft / w) * 100),
        top: clampPct((b.yTop / h) * 100),
        width: clampPct((Math.max(1, b.xRight - b.xLeft) / w) * 100),
        height: clampPct((Math.max(1, b.yBottom - b.yTop) / h) * 100),
    };
};

const clampPct = (v: number): number => (v < 0 ? 0 : v > 100 ? 100 : v);

/** Optional per-corner Y (skew) carried by a redaction box. */
export interface QuadBand extends BoxBand {
    yLeftTop?: number;
    yRightTop?: number;
    yLeftBottom?: number;
    yRightBottom?: number;
}

/**
 * The redaction box as an SVG polygon `points` string in PERCENT units (0–100),
 * following the receipt tilt via the per-corner Y. Rendered inside an
 * `<Svg viewBox="0 0 100 100" preserveAspectRatio="none">` so the percentages
 * map straight onto the capture surface (any DP size). Falls back to the
 * axis-aligned rectangle when no corners are present.
 */
export const maskQuadPercentPoints = (
    b: QuadBand,
    imageWidth: number,
    imageHeight: number,
): string => {
    const w = Math.max(1, imageWidth);
    const h = Math.max(1, imageHeight);
    const xL = clampPct((b.xLeft / w) * 100);
    const xR = clampPct((Math.max(b.xLeft + 1, b.xRight) / w) * 100);
    const yLT = clampPct(((b.yLeftTop ?? b.yTop) / h) * 100);
    const yRT = clampPct(((b.yRightTop ?? b.yTop) / h) * 100);
    const yRB = clampPct(((b.yRightBottom ?? b.yBottom) / h) * 100);
    const yLB = clampPct(((b.yLeftBottom ?? b.yBottom) / h) * 100);
    return `${xL},${yLT} ${xR},${yRT} ${xR},${yRB} ${xL},${yLB}`;
};

/**
 * DP size to render the offscreen capture surface at.
 *
 * The redacted image MUST be uploaded at the ORIGINAL pixel dimensions —
 * the stored `image.width/height` and every parsed region (header/footer/
 * product bands) are in that space, so a downscaled upload makes the
 * detail-screen crops compute out-of-bounds rects ("Invalid crop option").
 *
 * react-native-view-shot captures the view at `DP × pixelRatio` then resizes
 * to the `width/height` option. So to output the original pixel dims sharply
 * AND keep the intermediate bitmap ~= original size (not ×pixelRatio²), we
 * render the surface at `originalPx ÷ pixelRatio` DP and capture with
 * `{ width/height = originalPx }`.
 */
export const maskRenderSize = (
    outputWidth: number,
    outputHeight: number,
    pixelRatio: number,
): { width: number; height: number } => {
    const pr = Math.max(1, pixelRatio || 1);
    return {
        width: Math.max(1, Math.round(outputWidth / pr)),
        height: Math.max(1, Math.round(outputHeight / pr)),
    };
};
