import React, { memo, useMemo, useState } from 'react';
import {
    Image,
    LayoutChangeEvent,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Polygon } from 'react-native-svg';
import { MaterialProgress } from '../MaterialProgress';
import { SkeletonBox } from '../SkeletonBox';
import { bandQuadPoints } from '../../utils/bandQuad';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useTheme, spacing, radius, typography, type AppTheme } from '../../constants/theme';

/**
 * Inline receipt-photo viewer for the Kvitas tab.
 *
 * Renders the original receipt image with parser-region overlays so
 * the user can see exactly which pixels Souply read for each piece of
 * data, coloured + labelled per field:
 *   • Parduotuvės adresas (blue) — store address line(s)
 *   • Prekės (green) — one band per product, with a #N badge
 *   • Suma (orange) — receipt total line
 *   • Data ir laikas (soft blue) — date and/or time
 *   • Kvito Nr. (lilac) — receipt number
 *
 * Each region carries a `kind` so the renderer can colour + label per
 * field. Legacy receipts (pre-Phase-6) have regions without a kind —
 * those fall back to the section's default colour (header → blue,
 * footer → orange) and the legacy generic label.
 *
 * Bands are padded by `BAND_PADDING_PX` in display space so the box
 * doesn't graze the text and the band is easy to read.
 *
 * Pre-redesign (or image-upload-failed) receipts have no `imageUri`;
 * the component renders a quiet fallback in those cases.
 */

export interface ReceiptRegion {
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
    /** Phase-6 label. Optional so legacy receipts still render. */
    kind?: string;
    /** Optional per-corner Y (skew) — band top/bottom at the left vs right
     *  edge, so tilt-aware bands can be drawn as polygons. Absent → rectangle. */
    yLeftTop?: number;
    yRightTop?: number;
    yLeftBottom?: number;
    yRightBottom?: number;
    /** Mid-column step (column engine's two-box product band): renders as an 8-point
     *  polygon — name box [xLeft..xMid] and price/discount box [xMid..xRight], each a clean
     *  parallelogram, joined by a VERTICAL step at xMid. yMidTop/yMidBottom = LEFT column at
     *  xMid; yMidTopR/yMidBottomR = RIGHT column. If the …R values are absent or equal, it
     *  collapses to the legacy 6-point. Absent xMid → ordinary 4-corner quad. */
    xMid?: number;
    yMidTop?: number;
    yMidBottom?: number;
    yMidTopR?: number;
    yMidBottomR?: number;
}

/** Display-space padding added to header/footer bands so the border
 *  doesn't sit flush against the text. Receipts vary in resolution
 *  but render at a constant card width, so flat display-pixel values
 *  give consistent visual breathing room.
 *
 *  Products are EXCLUDED — their parser-emitted bands already hug each
 *  product row precisely (band walls touch), and padding would push
 *  them into adjacent products.
 *
 *  Horizontal padding helps with truncated first/last characters
 *  inside the tight bbox MLKit emits for short tokens. */
const BAND_PADDING_Y_PX = 5;
const BAND_PADDING_X_PX = 4;

const PALETTE_DATETIME = '#7A9CC6';
const PALETTE_RECEIPT_NO = '#B585C9';
const PALETTE_COMPANY = '#4DB6AC';   // teal — company/VAT code (not the store address)
const PALETTE_SKIPPED = '#9AA0A6';   // grey — coupons/bags/points: shown but NOT counted

type BandGroup = 'address' | 'companyCode' | 'total' | 'dateTime' | 'receiptNo' | 'skipped';

interface BandStyle {
    colour: string;
    label: string;
    group: BandGroup;
}

const headerBandStyle = (kind: string | undefined, colors: AppTheme, t: TFunction): BandStyle => {
    switch (kind) {
        // The PVM/VAT line is the COMPANY's registration code, not the store
        // address — distinct colour + label so the two adjacent header bands
        // don't read as one "address" band.
        case 'storeCode':
            return { colour: PALETTE_COMPANY, label: t('receiptPhoto.bands.companyCode'), group: 'companyCode' };
        case 'storeAddress':
        case 'storeName':
            return { colour: colors.info, label: t('receiptPhoto.bands.address'), group: 'address' };
        default:
            // Legacy header without kind — single block-bbox case.
            return { colour: colors.info, label: t('receiptPhoto.bands.address'), group: 'address' };
    }
};

const footerBandStyle = (kind: string | undefined, colors: AppTheme, t: TFunction): BandStyle => {
    switch (kind) {
        case 'total':
            return { colour: colors.warning, label: t('receiptPhoto.bands.total'), group: 'total' };
        case 'date':
        case 'time':
        case 'dateTime':
            return { colour: PALETTE_DATETIME, label: t('receiptPhoto.bands.dateTime'), group: 'dateTime' };
        case 'receiptNo':
            return { colour: PALETTE_RECEIPT_NO, label: t('receiptPhoto.bands.receiptNo'), group: 'receiptNo' };
        default:
            // Legacy footer without kind — single block-bbox covering
            // total + date + receipt №. The generic "Suma" label /
            // orange colour matches the pre-Phase-6 behaviour.
            return { colour: colors.warning, label: t('receiptPhoto.bands.total'), group: 'total' };
    }
};

/** Precomputed display-space band geometry (one entry per drawable region). */
interface QuadEntry {
    points: string;
    left: number;
    midY: number;
    /** Per-kind band colour (header/footer bands only). */
    colour?: string;
}

interface OverlayData {
    products: QuadEntry[];
    skipped: QuadEntry[];
    masks: QuadEntry[];
    footer: QuadEntry[];
    header: QuadEntry[];
}

/**
 * The band overlay — hundreds of SVG polygons + #N badges. Memoised as one
 * unit over the PRECOMPUTED geometry so parent re-renders (image-loading
 * spinner flips, the explainer modal, pan/zoom-driven parent state) don't
 * rebuild every node; only a geometry change (new regions, container resize)
 * does.
 */
const BandOverlays = memo(function BandOverlays({ data, containerW, stageH, successColour, badgeTextStyle, badgeStyle }: {
    data: OverlayData;
    containerW: number;
    stageH: number;
    successColour: string;
    badgeTextStyle: object;
    badgeStyle: object;
}) {
    return (
        <>
            <Svg
                style={StyleSheet.absoluteFill}
                width={containerW}
                height={stageH}
                pointerEvents="none"
            >
                {data.products.map((q, i) => (
                    <Polygon
                        key={`pp-${i}`}
                        points={q.points}
                        stroke={successColour}
                        strokeWidth={2}
                        fill={`${successColour}1A`}
                    />
                ))}
                {data.skipped.map((q, i) => (
                    <Polygon
                        key={`sp-${i}`}
                        points={q.points}
                        stroke={PALETTE_SKIPPED}
                        strokeWidth={2}
                        strokeDasharray="4 3"
                        fill={`${PALETTE_SKIPPED}26`}
                    />
                ))}
                {/* Privacy masks — solid black, tilt-following (same quad as the
                    burned-in box) so the overlay matches the uploaded image. */}
                {data.masks.map((q, i) => (
                    <Polygon
                        key={`mk-${i}`}
                        points={q.points}
                        fill="#000"
                        stroke="#000"
                        strokeWidth={1}
                    />
                ))}
                {/* Footer bands (total / date / receipt №), coloured per kind. */}
                {data.footer.map((q, i) => (
                    <Polygon
                        key={`f-${i}`}
                        points={q.points}
                        stroke={q.colour}
                        strokeWidth={2}
                        fill={`${q.colour}1A`}
                    />
                ))}
                {/* Header bands (address / company-code). */}
                {data.header.map((q, i) => (
                    <Polygon
                        key={`h-${i}`}
                        points={q.points}
                        stroke={q.colour}
                        strokeWidth={2}
                        fill={`${q.colour}1A`}
                    />
                ))}
            </Svg>
            {/* Per-product #N badge to the left of each band. */}
            {data.products.map((q, i) => {
                const BADGE_W = 26;
                const BADGE_GAP = 4;
                const badgeLeft =
                    q.left >= BADGE_W + BADGE_GAP ? q.left - BADGE_W - BADGE_GAP : 2;
                return (
                    <View
                        key={`pb-${i}`}
                        pointerEvents="none"
                        style={[
                            badgeStyle,
                            { top: q.midY - 9, left: badgeLeft, backgroundColor: successColour },
                        ]}
                    >
                        <Text style={badgeTextStyle}>#{i + 1}</Text>
                    </View>
                );
            })}
        </>
    );
});

interface Props {
    imageUri: string | null;
    /** Page-1 pixel dims as the parser saw them. */
    imageDims: { width: number; height: number } | null;
    /** Header section bands — store address etc. Each region carries
     *  `kind` when Phase-6 parsers emitted it; absent on legacy
     *  receipts where the caller passes a single block-bbox. */
    headerRegions: ReceiptRegion[];
    productRegions: ReceiptRegion[];
    footerRegions: ReceiptRegion[];
    /** Coupon / bag / loyalty-points lines: shown as distinct grey bands so the
     *  user can see they WERE read, but they are intentionally NOT counted as
     *  products. */
    skippedRegions?: ReceiptRegion[];
    /** Bank-card / loyalty-card / cashier redaction boxes — drawn as SOLID
     *  black bands so the private data is covered in this view too (the
     *  uploaded image is separately redacted before it ever leaves the phone). */
    maskRegions?: ReceiptRegion[];
    /** Draw the black mask polygons as an overlay. ONLY meaningful for a fresh scan,
     *  where the displayed image is the un-redacted camera capture. On a SAVED receipt
     *  the shown image is the already-burned MinIO file, so the overlay is REDUNDANT —
     *  and re-projecting it risks a transient mis-scaled band on a warm reopen. Off for
     *  existing receipts: the burned-in masks already show, with zero drift. */
    drawMasks?: boolean;
    /** A SAVED receipt's photo streams in from MinIO after the detail renders.
     *  While true, show a skeleton instead of the "photo not available" fallback —
     *  that fallback is otherwise indistinguishable from "still fetching" (both are
     *  imageUri/imageDims null) and flashes before the photo lands. */
    loading?: boolean;
    /** Drop the card's own horizontal margin — for hosts whose container already
     *  insets content (a sheet's SheetContent wrapper), so the photo card lines
     *  up with the surrounding sheet content instead of sitting further in.
     *  Screens that render this full-bleed keep the default margin. */
    flush?: boolean;
}

function ReceiptPhotoView({
    imageUri,
    imageDims,
    headerRegions,
    productRegions,
    footerRegions,
    skippedRegions = [],
    maskRegions = [],
    drawMasks = true,
    loading = false,
    flush = false,
}: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const cardStyle = flush ? [styles.card, styles.cardFlush] : styles.card;
    const [explainerOpen, setExplainerOpen] = useState(false);
    // A saved receipt's photo is fetched from MinIO over the network — show a spinner over the
    // stage while it loads. Seeded true for a remote (http) URI so the spinner is up before the
    // Image even fires onLoadStart; local file:// images skip it (they paint instantly).
    const isRemoteImage = !!imageUri && /^https?:/i.test(imageUri);
    const [imgLoading, setImgLoading] = useState(isRemoteImage);

    // We measure the container's actual rendered width at runtime
    // because the card's content padding makes the math sensitive to
    // theme changes / future style tweaks.
    const [containerW, setContainerW] = useState(0);
    const onLayout = (e: LayoutChangeEvent) => {
        const w = e.nativeEvent.layout.width;
        if (w !== containerW) setContainerW(w);
    };

    /** Horizontal content extent — the x analog of contentY below. Maxima
     *  e-receipt PDFs render the receipt column on a full A4 page: without
     *  this crop half the Kvitas view is white margin. Regions carry the
     *  parser's x extents, so the same confidence rules apply; skipped when
     *  the content already fills the page (photos) — no pointless zoom. */
    const contentX = useMemo(() => {
        if (!imageDims) return null;
        const xs: number[] = [];
        for (const r of headerRegions) xs.push(r.xLeft, r.xRight);
        for (const r of productRegions) xs.push(r.xLeft, r.xRight);
        for (const r of footerRegions) xs.push(r.xLeft, r.xRight);
        for (const r of skippedRegions) xs.push(r.xLeft, r.xRight);
        for (const r of maskRegions) xs.push(r.xLeft, r.xRight);
        const finite = xs.filter((v) => Number.isFinite(v));
        if (finite.length < 4) return null;
        const xMin = Math.max(0, Math.min(...finite) - 24);
        const xMax = Math.min(imageDims.width, Math.max(...finite) + 24);
        const w = xMax - xMin;
        if (w < imageDims.width * 0.2) return null;          // suspicious — bail
        if (w > imageDims.width * 0.92) return null;          // full-width already
        return { xMin, xMax };
    }, [headerRegions, productRegions, footerRegions, skippedRegions, maskRegions, imageDims]);

    const viewW = contentX
        ? contentX.xMax - contentX.xMin
        : (imageDims?.width ?? 0);
    const scale = imageDims && viewW > 0 ? containerW / viewW : 0;
    const cropOffsetX = contentX ? contentX.xMin * scale : 0;
    const displayedH = (imageDims?.height ?? 0) * scale;

    /** Vertical content extent (image-pixel space) covered by the
     *  parsed regions. Used to crop visual letterboxing — Lidl PDFs
     *  render with black/empty margins above and below the receipt,
     *  and this universally trims any chain's whitespace too. Returns
     *  null when we don't have enough bands to make a confident
     *  decision (legacy receipts with empty arrays). */
    const CONTENT_MARGIN_PX = 24; // image-pixel-space padding above/below
    const contentY = useMemo(() => {
        if (!imageDims) return null;
        const ys: number[] = [];
        for (const r of headerRegions) ys.push(r.yTop, r.yBottom);
        for (const r of productRegions) ys.push(r.yTop, r.yBottom);
        for (const r of footerRegions) ys.push(r.yTop, r.yBottom);
        for (const r of skippedRegions) ys.push(r.yTop, r.yBottom);
        // Include mask bands so the (often bottom-of-receipt) payment/loyalty
        // section isn't cropped out of the visible viewport.
        for (const r of maskRegions) ys.push(r.yTop, r.yBottom);
        if (ys.length < 2) return null;
        const yMin = Math.max(0, Math.min(...ys) - CONTENT_MARGIN_PX);
        const yMax = Math.min(imageDims.height, Math.max(...ys) + CONTENT_MARGIN_PX);
        if (yMax - yMin < imageDims.height * 0.2) return null;
        return { yMin, yMax };
    }, [headerRegions, productRegions, footerRegions, skippedRegions, maskRegions, imageDims]);

    // Display-space offset to apply when content is cropped. Bands'
    // top coords are computed against the full image; subtracting this
    // shifts them up to align with the cropped viewport.
    const cropOffsetY = contentY ? contentY.yMin * scale : 0;
    const stageH = contentY
        ? Math.max(80, (contentY.yMax - contentY.yMin) * scale)
        : displayedH;

    /** Page-1 filter — multi-page receipts only have page 1 uploaded. */
    const onPageOne = (r: ReceiptRegion): boolean =>
        !!imageDims &&
        r.yTop >= 0 &&
        r.yTop < imageDims.height &&
        r.yBottom > r.yTop;

    /** Page-1 region → an SVG polygon (display space) that follows the receipt
     *  tilt: the band's top/bottom edges use the per-corner Y (yLeftTop/yRightTop
     *  …) when present, falling back to the axis-aligned rect. Returns the
     *  `points` string plus the left edge + vertical centre (for the #N badge).
     *  Used for product + skipped bands, whose walls must hug the tilted rows. */
    const toQuadPoints = (r: ReceiptRegion): { points: string; left: number; midY: number } | null => {
        if (!imageDims || !onPageOne(r)) return null;
        const dx = (x: number) => Math.max(0, Math.min(containerW, x * scale - cropOffsetX));
        const dy = (y: number) => Math.max(0, Math.min(stageH, y * scale - cropOffsetY));
        // Shared with the Items-tab crop clip (utils/bandQuad) so the two never diverge.
        return {
            points: bandQuadPoints(r, dx, dy),
            left: dx(r.xLeft),
            midY: (dy(r.yLeftTop ?? r.yTop) + dy(r.yLeftBottom ?? r.yBottom)) / 2,
        };
    };

    // Legend chips list the kinds actually present on this receipt,
    // in a stable display order so the bar feels consistent across
    // receipts (address → prekės → suma → data ir laikas → kvito nr.).
    const legendItems = useMemo(() => {
        const groups = new Map<BandGroup | 'products', { colour: string; label: string; order: number }>();
        for (const r of headerRegions) {
            const s = headerBandStyle(r.kind, colors, t);
            if (!groups.has(s.group)) {
                groups.set(s.group, { colour: s.colour, label: s.label, order: 0 });
            }
        }
        if (productRegions.length > 0) {
            groups.set('products', { colour: colors.success, label: t('receiptPhoto.bands.products'), order: 1 });
        }
        for (const r of footerRegions) {
            const s = footerBandStyle(r.kind, colors, t);
            if (groups.has(s.group)) continue;
            const order = s.group === 'total' ? 2 : s.group === 'dateTime' ? 3 : 4;
            groups.set(s.group, { colour: s.colour, label: s.label, order });
        }
        if (skippedRegions.length > 0) {
            groups.set('skipped', { colour: PALETTE_SKIPPED, label: t('receiptPhoto.bands.skipped'), order: 5 });
        }
        return Array.from(groups.values()).sort((a, b) => a.order - b.order);
    }, [headerRegions, productRegions.length, footerRegions, skippedRegions.length, colors, t]);

    // Precompute EVERY band's display-space quad once per geometry change —
    // before this, each parent re-render (image spinner flips, modal opens)
    // recomputed hundreds of polygon strings and rebuilt their nodes.
    const overlayData = useMemo<OverlayData | null>(() => {
        if (!imageDims || containerW <= 0) return null;
        const quad = (r: ReceiptRegion): QuadEntry | null => {
            const q = toQuadPoints(r);
            return q ? { points: q.points, left: q.left, midY: q.midY } : null;
        };
        const withStyle = (r: ReceiptRegion, style: BandStyle): QuadEntry | null => {
            const q = quad(r);
            return q ? { ...q, colour: style.colour } : null;
        };
        return {
            products: productRegions.map(quad).filter((q): q is QuadEntry => q != null),
            skipped: skippedRegions.map(quad).filter((q): q is QuadEntry => q != null),
            masks: drawMasks
                ? maskRegions.map(quad).filter((q): q is QuadEntry => q != null)
                : [],
            footer: footerRegions
                .map(r => withStyle(r, footerBandStyle(r.kind, colors, t)))
                .filter((q): q is QuadEntry => q != null),
            header: headerRegions
                .map(r => withStyle(r, headerBandStyle(r.kind, colors, t)))
                .filter((q): q is QuadEntry => q != null),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        productRegions, skippedRegions, maskRegions, footerRegions, headerRegions,
        imageDims, containerW, scale, cropOffsetX, cropOffsetY, stageH, drawMasks, colors, t,
    ]);

    if (!imageUri || !imageDims) {
        // Still fetching the saved photo from MinIO → skeleton (title + legend hints +
        // a tall image placeholder) so the layout is set and nothing flashes. Only once
        // the fetch settles WITHOUT an image do we show the honest "not available".
        if (loading) {
            return (
                <View style={cardStyle}>
                    <View style={styles.titleRow}>
                        <Text style={styles.title}>{t('receiptPhoto.title')}</Text>
                    </View>
                    <View style={styles.legend}>
                        <SkeletonBox width={72} height={12} borderRadius={6} />
                        <SkeletonBox width={56} height={12} borderRadius={6} />
                        <SkeletonBox width={64} height={12} borderRadius={6} />
                    </View>
                    <SkeletonBox width="100%" height={360} borderRadius={6} />
                </View>
            );
        }
        return (
            <View style={cardStyle}>
                <View style={styles.fallbackWrap}>
                    <Text style={styles.fallbackTitle}>{t('receiptPhoto.fallbackTitle')}</Text>
                    <Text style={styles.fallbackBody}>
                        {t('receiptPhoto.fallbackBody')}
                    </Text>
                </View>
            </View>
        );
    }

    return (
        <View style={cardStyle}>
            {/* Compact title row + (?) for the explainer modal. */}
            <View style={styles.titleRow}>
                <Text style={styles.title}>{t('receiptPhoto.title')}</Text>
                <TouchableOpacity
                    onPress={() => setExplainerOpen(true)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={styles.helpBtn}
                >
                    <Ionicons name="help-circle-outline" size={20} color={colors.textSecondary} />
                </TouchableOpacity>
            </View>
            <View style={styles.legend}>
                {legendItems.map((it, i) => (
                    <LegendChip
                        key={i}
                        colour={it.colour}
                        label={it.label}
                        styles={styles}
                    />
                ))}
                {maskRegions.length > 0 && (
                    <LegendChip
                        colour="#000"
                        label={t('receiptPhoto.bands.private')}
                        styles={styles}
                        bordered
                    />
                )}
            </View>

            <View style={styles.stage} onLayout={onLayout}>
                {containerW > 0 && (
                    <View style={{ width: containerW, height: stageH, overflow: 'hidden' }}>
                        {/* Image rendered at its full displayed height and
                            shifted up by `cropOffsetY`; the outer view's
                            `overflow: hidden` clips the letterbox. When
                            content fills the image, cropOffsetY === 0
                            and stageH === displayedH (no-op crop). */}
                        <Image
                            source={{ uri: imageUri }}
                            style={{
                                position: 'absolute',
                                top: -cropOffsetY,
                                left: -cropOffsetX,
                                width: (imageDims?.width ?? 0) * scale,
                                height: displayedH,
                            }}
                            resizeMode="stretch"
                            onLoadStart={() => setImgLoading(true)}
                            onLoadEnd={() => setImgLoading(false)}
                            onError={() => setImgLoading(false)}
                        />
                        {/* Spinner while the saved-receipt photo streams in from MinIO. */}
                        {isRemoteImage && imgLoading && (
                            <View style={styles.imgLoadingOverlay} pointerEvents="none">
                                <MaterialProgress size="large" color={colors.primary} />
                            </View>
                        )}
                        {/* Tilt-following band walls: product (green) + skipped
                            (grey dashed) bands as SVG polygons built from each
                            region's per-corner Y, so the overlay follows a
                            skewed receipt instead of boxing it as rectangles.
                            Geometry precomputed + memoised (BandOverlays), so a
                            re-render that changes nothing rebuilds nothing. */}
                        {overlayData && (
                            <BandOverlays
                                data={overlayData}
                                containerW={containerW}
                                stageH={stageH}
                                successColour={colors.success}
                                badgeStyle={styles.bandBadge}
                                badgeTextStyle={styles.bandBadgeText}
                            />
                        )}
                        {/* (Footer bands are the per-kind SVG polygons in the
                            layer above; skipped coupon/bag/points bands are the
                            grey dashed polygons there too.) */}
                        {/* Private-info areas are already burned black INTO
                            the uploaded image (MinIO), so no UI overlay is
                            drawn here — we show the real redacted file. */}
                    </View>
                )}
            </View>

            {/* Detail modal — opens from the (?) icon next to the title. */}
            <Modal
                visible={explainerOpen}
                transparent
                animationType="fade"
                onRequestClose={() => setExplainerOpen(false)}
            >
                <Pressable
                    style={styles.modalBackdrop}
                    onPress={() => setExplainerOpen(false)}
                >
                    <Pressable
                        style={styles.modalCard}
                        onPress={(e) => e.stopPropagation()}
                    >
                        <Text style={styles.modalTitle}>{t('receiptPhoto.explainer.title')}</Text>
                        <Text style={styles.modalBody}>{t('receiptPhoto.explainer.body')}</Text>
                        <View style={styles.modalLegendList}>
                            <ExplainerRow
                                colour={colors.info}
                                title={t('receiptPhoto.bands.address')}
                                body={t('receiptPhoto.explainer.addressBody')}
                                styles={styles}
                            />
                            <ExplainerRow
                                colour={PALETTE_COMPANY}
                                title={t('receiptPhoto.bands.companyCode')}
                                body={t('receiptPhoto.explainer.companyCodeBody')}
                                styles={styles}
                            />
                            <ExplainerRow
                                colour={colors.success}
                                title={t('receiptPhoto.bands.products')}
                                body={t('receiptPhoto.explainer.productsBody')}
                                styles={styles}
                            />
                            <ExplainerRow
                                colour={PALETTE_SKIPPED}
                                title={t('receiptPhoto.bands.skipped')}
                                body={t('receiptPhoto.explainer.skippedBody')}
                                styles={styles}
                            />
                            <ExplainerRow
                                colour={colors.warning}
                                title={t('receiptPhoto.bands.total')}
                                body={t('receiptPhoto.explainer.totalBody')}
                                styles={styles}
                            />
                            <ExplainerRow
                                colour={PALETTE_DATETIME}
                                title={t('receiptPhoto.bands.dateTime')}
                                body={t('receiptPhoto.explainer.dateTimeBody')}
                                styles={styles}
                            />
                            <ExplainerRow
                                colour={PALETTE_RECEIPT_NO}
                                title={t('receiptPhoto.bands.receiptNo')}
                                body={t('receiptPhoto.explainer.receiptNoBody')}
                                styles={styles}
                            />
                            <ExplainerRow
                                colour="#000"
                                bordered
                                title={t('receiptPhoto.bands.private')}
                                body={t('receiptPhoto.explainer.privateBody')}
                                styles={styles}
                            />
                        </View>
                        <TouchableOpacity
                            style={styles.modalCloseBtn}
                            onPress={() => setExplainerOpen(false)}
                        >
                            <Text style={styles.modalCloseText}>{t('receiptPhoto.explainer.close')}</Text>
                        </TouchableOpacity>
                    </Pressable>
                </Pressable>
            </Modal>
        </View>
    );
}

// memo'd: parents (receipt-process Kvitas tab, ReceiptDetailSheet) re-render
// on scroll/sheet state; with stable region-array props the whole card skips.
export default memo(ReceiptPhotoView);

function LegendChip({
    colour,
    label,
    styles,
    bordered,
}: {
    colour: string;
    label: string;
    styles: ReturnType<typeof makeStyles>;
    bordered?: boolean;
}) {
    return (
        <View style={styles.legendChip}>
            <View style={[styles.legendDot, { backgroundColor: colour }, bordered && styles.dotBordered]} />
            <Text style={styles.legendLabel}>{label}</Text>
        </View>
    );
}

function ExplainerRow({
    colour,
    title,
    body,
    styles,
    bordered,
}: {
    colour: string;
    title: string;
    body: string;
    styles: ReturnType<typeof makeStyles>;
    bordered?: boolean;
}) {
    return (
        <View style={styles.explainerRow}>
            <View style={[styles.explainerDot, { backgroundColor: colour }, bordered && styles.dotBordered]} />
            <View style={{ flex: 1 }}>
                <Text style={styles.explainerTitle}>{title}</Text>
                <Text style={styles.explainerBody}>{body}</Text>
            </View>
        </View>
    );
}

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        card: {
            backgroundColor: c.cardBackground,
            marginHorizontal: 16,
            marginTop: 16,
            borderRadius: 12,
            padding: 16,
            elevation: 1,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.05,
            shadowRadius: 2,
        },
        // `flush` hosts (sheet content, already inset by SheetContent) — the
        // card must line up with its siblings, not sit a margin further in.
        cardFlush: { marginHorizontal: 0 },
        titleRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
        },
        title: {
            fontSize: 14,
            fontWeight: '600',
            color: c.textPrimary,
        },
        helpBtn: {
            padding: 2,
        },
        legend: {
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            columnGap: 16,
            rowGap: 6,
            marginTop: 8,
            marginBottom: 14,
        },
        legendChip: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
        },
        legendDot: {
            width: 10,
            height: 10,
            borderRadius: 5,
        },
        legendLabel: {
            fontSize: 12,
            color: c.textSecondary,
            fontWeight: '600',
        },
        stage: {
            width: '100%',
            position: 'relative',
            backgroundColor: c.surfaceMuted,
            borderRadius: 6,
            overflow: 'hidden',
        },
        imgLoadingOverlay: {
            ...StyleSheet.absoluteFill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: c.surfaceMuted,
        },
        overlay: {
            position: 'absolute',
            borderWidth: 2,
            borderRadius: 3,
        },
        // Solid private-info redaction box (white border so it reads as an
        // intentional mask in both light + dark themes).
        maskBand: {
            backgroundColor: '#000',
            borderColor: '#fff',
            borderWidth: 1.5,
        },
        // Legend/explainer dot for the black private-info entry — white ring
        // keeps the black dot visible on dark card backgrounds.
        dotBordered: {
            borderWidth: 1.5,
            borderColor: '#fff',
        },
        bandBadge: {
            position: 'absolute',
            width: 26,
            height: 18,
            borderRadius: 4,
            alignItems: 'center',
            justifyContent: 'center',
        },
        bandBadgeText: {
            fontSize: 10,
            fontWeight: '700',
            color: c.onPrimary,
        },
        fallbackWrap: {
            paddingVertical: 24,
            alignItems: 'center',
            gap: 4,
        },
        fallbackTitle: {
            fontSize: 14,
            fontWeight: '600',
            color: c.textPrimary,
        },
        fallbackBody: {
            fontSize: 12,
            color: c.textMuted,
        },

        // ── Explainer modal ──────────────────────────────────────────
        modalBackdrop: {
            flex: 1,
            backgroundColor: c.overlayBackdrop,
            justifyContent: 'center',
            paddingHorizontal: spacing.xl,
        },
        modalCard: {
            backgroundColor: c.cardBackground,
            borderRadius: radius.lg,
            padding: spacing.xl,
            gap: spacing.md,
        },
        modalTitle: {
            ...typography.subheading,
            color: c.textPrimary,
            textAlign: 'center',
        },
        modalBody: {
            ...typography.bodySmall,
            color: c.textSecondary,
        },
        modalLegendList: {
            gap: spacing.md,
            marginTop: spacing.xs,
        },
        explainerRow: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: spacing.sm,
        },
        explainerDot: {
            width: 12,
            height: 12,
            borderRadius: 6,
            marginTop: spacing.xs,
        },
        explainerTitle: {
            ...typography.bodySmallStrong,
            fontWeight: '700',
            color: c.textPrimary,
        },
        explainerBody: {
            ...typography.labelSmall,
            fontWeight: '400',
            color: c.textSecondary,
            marginTop: 2,
        },
        modalCloseBtn: {
            backgroundColor: c.primary,
            borderRadius: radius.pill,
            paddingVertical: spacing.md,
            paddingHorizontal: spacing.xl,
            alignItems: 'center',
            marginTop: spacing.sm,
        },
        modalCloseText: {
            ...typography.bodySmallStrong,
            fontWeight: '700',
            color: c.onPrimary,
        },
    });
