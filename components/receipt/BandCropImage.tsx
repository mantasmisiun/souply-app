import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import Svg, { Defs, ClipPath, Polygon, Image as SvgImage } from "react-native-svg";
import { useTheme } from "../../constants/theme";
import { devLog } from "../../utils/devLog";
import { bandQuadPoints, type BandQuadRegion } from "../../utils/bandQuad";
import type { PageMeta } from "../../utils/receiptImage";

export interface BandCropImageProps {
  pages: PageMeta[];
  region: BandQuadRegion;
  cardWidth: number;
  /** Fired once when the crop has settled (rendered OR failed OR nothing to crop). */
  onSettled?: () => void;
  /**
   * Producer-supplied identity for THIS crop source. The downscale cache below
   * is module-level and keyed by file path, but a path can be REUSED for
   * different pixels (the OS document scanner reuses per-scan page filenames; a
   * retake overwrites the cached receipt-<id>.jpg). Pass a value that changes
   * whenever the underlying pixels change (a per-build nonce) so a reused path
   * can never serve a previous receipt's cached downscale.
   */
  cacheScope?: string;
  /** Free-text correlation label for crop-source diagnostics (devLog only) —
   *  e.g. `r113#l1 "RUKYTAS…"`, so a logged crop can be tied to the exact card. */
  debugLabel?: string;
}

/**
 * One-decode-per-page cache. Previously every band ran ImageManipulator on the
 * FULL-page uri (a ~4-5MP / 16-22MB transient ARGB bitmap) and threw away ~99% of
 * the pixels — N bands on the same page = N full decodes, a real Android OOM/jank
 * risk on long IKI receipts. Instead we decode each page ONCE to a downscaled
 * working width, cache the intermediate, and crop every band from that small file.
 * Cache holds tiny {uri, scale, dims} promises (the files live in the OS cache dir);
 * a soft cap clears it so it can't grow unbounded across a long session.
 */
const pageScaleCache = new Map<
  string,
  Promise<{ uri: string; scale: number; width: number; height: number }>
>();

async function getDownscaledPage(
  uri: string,
  pixelWidth: number,
  workingWidth: number,
  scopeKey: string,
): Promise<{ uri: string; scale: number; width: number; height: number }> {
  // No upscaling: if the page is already at/under the working width, crop it directly.
  if (!(workingWidth > 0) || !(pixelWidth > 0) || workingWidth >= pixelWidth) {
    return { uri, scale: 1, width: pixelWidth, height: 0 };
  }
  // CONTENT IDENTITY (not just the path): the same URI can point at DIFFERENT
  // pixels across receipts — the OS scanner reuses per-scan page filenames, and a
  // retake overwrites receipt-<id>.jpg. Folding the file's size+mtime into the key
  // makes a reused file:// path a cache MISS once its bytes change; the producer
  // `scopeKey` is the backstop for schemes getInfoAsync can't stat (content://).
  let ident = "";
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) ident = `${(info as any).size ?? ""}:${(info as any).modificationTime ?? ""}`;
  } catch {
    /* unstattable (content:// etc.) → rely on scopeKey to disambiguate */
  }
  const key = `${scopeKey}|${uri}@${workingWidth}@${ident}`;
  let p = pageScaleCache.get(key);
  if (!p) {
    if (pageScaleCache.size > 48) pageScaleCache.clear();
    p = ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: workingWidth } }],
      { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
    )
      .then((r) => ({ uri: r.uri, scale: r.width / pixelWidth, width: r.width, height: r.height }))
      // Fall back to cropping the full page directly if the downscale fails.
      .catch(() => ({ uri, scale: 1, width: pixelWidth, height: 0 }));
    pageScaleCache.set(key, p);
  }
  return p;
}

/**
 * Per-product band crop using `ImageManipulator.manipulateAsync` + an SVG clip.
 *
 * Why pre-crop to a file: sliding a full-page Image inside an overflow:hidden
 * container downsamples large bitmaps at decode time on Android — feeding a
 * 1080×5000 page into a 400×24 slot throws away ~99% of the source pixels and
 * renders unreadable mush for tiny product bands. Pre-cropping to a small file
 * dodges the downsample heuristic so the band renders at native resolution.
 *
 * The rectangular crop is then clipped to the band's true PARALLELOGRAM (the
 * persisted per-corner Y) with react-native-svg, using the shared `bandQuadPoints`
 * builder — the SAME polygon the Kvitas-tab overlay draws, so crop and overlay can
 * never drift. Shared by the receipt-detail "Items" tab and the swipe Card-B crop.
 */
export function BandCropImage({ pages, region, cardWidth, onSettled, cacheScope, debugLabel }: BandCropImageProps) {
  const themeColors = useTheme();
  const clipId = useId();
  const [croppedUri, setCroppedUri] = useState<string | null>(null);
  const [cropError, setCropError] = useState<string | null>(null);

  // Resolve which page the region lands on + its local pixel coords.
  const cropPlan = useMemo(() => {
    if (region.yBottom <= region.yTop) return null;
    if (pages.length === 0) return null;
    let page: PageMeta = pages[0];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (
        region.yTop >= p.yOffsetScaled &&
        region.yTop < p.yOffsetScaled + p.pageMaxYScaled + 50
      ) {
        page = p;
        break;
      }
      page = p;
    }
    // Crop the full QUAD extent, not just yTop/yBottom: a skewed band's corner
    // Y (yLeftBottom/yRightBottom) can sit below region.yBottom (they're borrowed
    // from the next band's top edge by the parser's no-gap tiler). Cropping only
    // yTop..yBottom would clip the parallelogram's lower edge so the clipped
    // thumbnail renders as a near-rectangle. Span min-top..max-bottom of all
    // corners so the clip polygon below fits entirely inside the crop.
    const topSpace = Math.min(
      region.yTop,
      region.yLeftTop ?? region.yTop,
      region.yRightTop ?? region.yTop,
    );
    const bottomSpace = Math.max(
      region.yBottom,
      region.yLeftBottom ?? region.yBottom,
      region.yRightBottom ?? region.yBottom,
    );
    const localYTop = Math.max(0, Math.floor(topSpace - page.yOffsetScaled));
    const localYBottom = Math.min(
      Math.ceil(bottomSpace - page.yOffsetScaled),
      page.pageMaxYScaled,
      page.pixelHeight,
    );
    const heightPx = Math.max(1, localYBottom - localYTop);
    const pad = 20;
    const xLeft = Math.max(0, Math.floor(page.receiptXLeftScaled - pad));
    const xRight = Math.min(
      page.pixelWidth,
      Math.ceil(page.receiptXRightScaled + pad),
    );
    const widthPx = Math.max(1, xRight - xLeft);
    return {
      uri: page.uri,
      originX: xLeft,
      originY: localYTop,
      width: widthPx,
      height: heightPx,
      // Full page pixel dims — used to derive the downscale factor + clamp the
      // scaled crop rect inside the intermediate.
      pageWidth: page.pixelWidth,
      pageHeight: page.pixelHeight,
      // Region-space Y of the crop's top edge — the clip polygon is measured
      // from here (NOT region.yTop, which may be below the top quad corner).
      cropTopSpace: localYTop + page.yOffsetScaled,
      // Region-space X of the crop's left edge — lets the clip map the band's own
      // xLeft/xMid/xRight (not the padded crop edges), so a two-box step lands right.
      cropLeftSpace: xLeft,
    };
  }, [pages, region]);

  useEffect(() => {
    if (!cropPlan) return;
    let cancelled = false;
    const { uri, originX, originY, width, height, pageWidth, pageHeight } = cropPlan;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      setCropError('invalid crop bounds');
      return;
    }
    // ── CROP-SOURCE DIAGNOSTICS ──
    // Where did THIS crop come from, and does its tilt match the printed text?
    // `topEdgeTiltRight`/`bottomEdgeTiltRight` > 0 ⇒ the clip's edges slope DOWN to
    // the right; they should match the printed slope. If the on-screen text slopes
    // the OPPOSITE way, the region belongs to a different photo/orientation than the
    // pixels being cropped from `pageUri`.
    const rr = region;
    devLog('BandCrop.source', {
      label: debugLabel,
      cacheScope,
      pageUri: uri,
      pageIndexOf: pages.findIndex((p) => p.uri === uri),
      pageCount: pages.length,
      page: { pageWidth, pageHeight, yOffsetScaled: cropPlan.cropTopSpace - (originY) },
      region: {
        xLeft: rr.xLeft, xRight: rr.xRight, yTop: rr.yTop, yBottom: rr.yBottom,
        yLeftTop: rr.yLeftTop, yRightTop: rr.yRightTop,
        yLeftBottom: rr.yLeftBottom, yRightBottom: rr.yRightBottom,
      },
      topEdgeTiltRight: (rr.yRightTop ?? rr.yTop) - (rr.yLeftTop ?? rr.yTop),
      bottomEdgeTiltRight: (rr.yRightBottom ?? rr.yBottom) - (rr.yLeftBottom ?? rr.yBottom),
      cropRect: { originX, originY, width, height, cropTopSpace: cropPlan.cropTopSpace, cropLeftSpace: cropPlan.cropLeftSpace },
    });
    FileSystem.getInfoAsync(uri)
      .then((info) => devLog('BandCrop.srcFile', {
        label: debugLabel, uri,
        exists: info.exists, size: (info as any).size, mtime: (info as any).modificationTime,
      }))
      .catch(() => { /* content:// / unstattable */ });
    (async () => {
      // 1) Decode the FULL page ONCE to a downscaled intermediate (cached per page),
      //    so N bands on the same page share a single decode instead of N full-page
      //    decodes. Working width ≥ 2× the display width keeps the strip crisp (still
      //    above display res, so the overflow:hidden "mush" heuristic never fires).
      const workingWidth = Math.min(
        pageWidth > 0 ? pageWidth : Math.round(cardWidth * 2),
        Math.max(Math.round(cardWidth * 2), 640),
      );
      let srcUri = uri;
      let scale = 1;
      let interW = pageWidth;
      let interH = pageHeight;
      try {
        const ds = await getDownscaledPage(uri, pageWidth, workingWidth, cacheScope ?? "");
        srcUri = ds.uri;
        scale = ds.scale;
        if (ds.width > 0) interW = ds.width;
        if (ds.height > 0) interH = ds.height;
      } catch {
        /* fall back to cropping the full page directly */
      }
      if (cancelled) return;

      // 2) Crop the band from the intermediate, scaling the page-space rect by the
      //    downscale factor and clamping it inside the intermediate's true bounds
      //    (floor origins / ceil sizes can otherwise overrun by ±1px → a crop error).
      let ox = Math.max(0, Math.floor(originX * scale));
      let oy = Math.max(0, Math.floor(originY * scale));
      let w = Math.max(1, Math.ceil(width * scale));
      let h = Math.max(1, Math.ceil(height * scale));
      if (interW > 0) { ox = Math.min(ox, interW - 1); w = Math.min(w, interW - ox); }
      if (interH > 0) { oy = Math.min(oy, interH - 1); h = Math.min(h, interH - oy); }
      const cropArgs = { uri: srcUri, originX: ox, originY: oy, width: w, height: h };
      devLog('BandCropImage.attempt', { label: debugLabel, ...cropArgs });
      try {
        // JPEG output: PNG via expo-image-manipulator v14 on iOS trips
        // `calling the 'renderAsync' function has failed`. JPEG output works.
        const res = await ImageManipulator.manipulateAsync(
          srcUri,
          [{ crop: { originX: ox, originY: oy, width: w, height: h } }],
          { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
        );
        devLog('BandCropImage.success', { label: debugLabel, uri: srcUri, resultUri: res?.uri });
        if (!cancelled) setCroppedUri(res.uri);
      } catch (e: any) {
        const errMsg = e?.message ?? String(e);
        console.warn('[BandCropImage] crop failed', { ...cropArgs, err: errMsg });
        devLog('BandCropImage.failed', { ...cropArgs, err: errMsg });
        if (!cancelled) setCropError(String(e?.message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [cropPlan, cardWidth, cacheScope, debugLabel, pages, region]);

  // Notify the host (e.g. the swipe readiness gate) once the crop has settled —
  // rendered, errored, or there is nothing to crop — so it never hangs waiting.
  const settledRef = useRef(false);
  useEffect(() => {
    if (settledRef.current) return;
    if (croppedUri || cropError || !cropPlan) {
      settledRef.current = true;
      onSettled?.();
    }
  }, [croppedUri, cropError, cropPlan, onSettled]);

  if (!cropPlan) return null;
  const aspect = cropPlan.width / cropPlan.height;
  const dispH = cardWidth / aspect;

  // Skew clip: when the region carries per-corner Y (IKI photographed bands),
  // clip the rectangular crop to the actual parallelogram so the tilted band
  // doesn't show triangular slivers of the neighbouring rows. The corner Y are
  // in merged-OCR space; offset by the band's top and scale to the card.
  const s = cardWidth / cropPlan.width;
  const r = region;
  const hasQuad =
    r.yLeftTop != null && r.yRightTop != null && r.yLeftBottom != null && r.yRightBottom != null;
  const top0 = cropPlan.cropTopSpace;
  const left0 = cropPlan.cropLeftSpace;
  const clipPts = hasQuad
    ? bandQuadPoints(r, (x) => (x - left0) * s, (y) => (y - top0) * s)
    : null;

  return (
    <View
      style={{
        width: cardWidth,
        height: dispH,
        borderRadius: 6,
        overflow: "hidden",
        backgroundColor: "#0001",
      }}
    >
      {croppedUri && clipPts && (
        <Svg width={cardWidth} height={dispH}>
          <Defs>
            <ClipPath id={clipId}>
              <Polygon points={clipPts} />
            </ClipPath>
          </Defs>
          <SvgImage
            href={{ uri: croppedUri }}
            x={0}
            y={0}
            width={cardWidth}
            height={dispH}
            preserveAspectRatio="none"
            clipPath={`url(#${clipId})`}
          />
        </Svg>
      )}
      {croppedUri && !clipPts && (
        <Image
          source={{ uri: croppedUri }}
          style={{ width: "100%", height: "100%" }}
          resizeMode="stretch"
        />
      )}
      {cropError && (
        <Text style={{ fontSize: 10, color: themeColors.error, padding: 2 }} numberOfLines={5}>
          crop failed: {cropError}
        </Text>
      )}
    </View>
  );
}
