import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import * as ImageManipulator from "expo-image-manipulator";
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
export function BandCropImage({ pages, region, cardWidth, onSettled }: BandCropImageProps) {
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
    // JPEG output: PNG via expo-image-manipulator v14 on iOS trips
    // `calling the 'renderAsync' function has failed`. JPEG output works.
    const { uri, originX, originY, width, height } = cropPlan;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      setCropError('invalid crop bounds');
      return;
    }
    const cropArgs = {
      uri,
      originX: Math.floor(originX),
      originY: Math.floor(originY),
      width: Math.floor(width),
      height: Math.floor(height),
    };
    devLog('BandCropImage.attempt', cropArgs);
    ImageManipulator.manipulateAsync(
      uri,
      [{
        crop: {
          originX: cropArgs.originX,
          originY: cropArgs.originY,
          width: cropArgs.width,
          height: cropArgs.height,
        },
      }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
    )
      .then((res) => {
        devLog('BandCropImage.success', { uri, resultUri: res?.uri });
        if (!cancelled) setCroppedUri(res.uri);
      })
      .catch((e) => {
        const errMsg = e?.message ?? String(e);
        console.warn('[BandCropImage] crop failed', { ...cropArgs, err: errMsg });
        devLog('BandCropImage.failed', { ...cropArgs, err: errMsg });
        if (!cancelled) setCropError(String(e?.message ?? e));
      });
    return () => { cancelled = true; };
  }, [cropPlan]);

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
