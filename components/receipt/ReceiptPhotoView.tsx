import React, { useMemo, useState } from 'react';
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
    /** Mid-column connection (column engine's two-box product band): renders as a
     *  6-point polygon — name box [xLeft..xMid] joined to price box [xMid..xRight]
     *  at this Y. Absent → ordinary 4-corner quad. */
    xMid?: number;
    yMidTop?: number;
    yMidBottom?: number;
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
}

export default function ReceiptPhotoView({
    imageUri,
    imageDims,
    headerRegions,
    productRegions,
    footerRegions,
    skippedRegions = [],
    maskRegions = [],
}: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [explainerOpen, setExplainerOpen] = useState(false);

    // We measure the container's actual rendered width at runtime
    // because the card's content padding makes the math sensitive to
    // theme changes / future style tweaks.
    const [containerW, setContainerW] = useState(0);
    const onLayout = (e: LayoutChangeEvent) => {
        const w = e.nativeEvent.layout.width;
        if (w !== containerW) setContainerW(w);
    };

    const scale =
        imageDims && imageDims.width > 0 ? containerW / imageDims.width : 0;
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
        const dx = (x: number) => Math.max(0, Math.min(containerW, x * scale));
        const dy = (y: number) => Math.max(0, Math.min(stageH, y * scale - cropOffsetY));
        const xL = dx(r.xLeft);
        const xR = dx(r.xRight);
        const yTL = dy(r.yLeftTop ?? r.yTop);
        const yTR = dy(r.yRightTop ?? r.yTop);
        const yBR = dy(r.yRightBottom ?? r.yBottom);
        const yBL = dy(r.yLeftBottom ?? r.yBottom);
        // Two-box product band → 6-point polygon: name box [xL..xMid] joined to the
        // price box [xMid..xR] at the mid column, so each half hugs its own curve.
        if (r.xMid != null && r.yMidTop != null && r.yMidBottom != null) {
            const xM = dx(r.xMid);
            const yMT = dy(r.yMidTop);
            const yMB = dy(r.yMidBottom);
            const poly = `${xL},${yTL} ${xM},${yMT} ${xR},${yTR} ${xR},${yBR} ${xM},${yMB} ${xL},${yBL}`;
            return { points: poly, left: xL, midY: (yTL + yBL) / 2 };
        }
        const points = `${xL},${yTL} ${xR},${yTR} ${xR},${yBR} ${xL},${yBL}`;
        return { points, left: xL, midY: (yTL + yBL) / 2 };
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

    if (!imageUri || !imageDims) {
        return (
            <View style={styles.card}>
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
        <View style={styles.card}>
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
                                left: 0,
                                width: containerW,
                                height: displayedH,
                            }}
                            resizeMode="stretch"
                        />
                        {/* Tilt-following band walls: product (green) + skipped
                            (grey dashed) bands as SVG polygons built from each
                            region's per-corner Y, so the overlay follows a
                            skewed receipt instead of boxing it as rectangles. */}
                        <Svg
                            style={StyleSheet.absoluteFill}
                            width={containerW}
                            height={stageH}
                            pointerEvents="none"
                        >
                            {productRegions.map((r, i) => {
                                const q = toQuadPoints(r);
                                if (!q) return null;
                                return (
                                    <Polygon
                                        key={`pp-${i}`}
                                        points={q.points}
                                        stroke={colors.success}
                                        strokeWidth={2}
                                        fill={`${colors.success}1A`}
                                    />
                                );
                            })}
                            {skippedRegions.map((r, i) => {
                                const q = toQuadPoints(r);
                                if (!q) return null;
                                return (
                                    <Polygon
                                        key={`sp-${i}`}
                                        points={q.points}
                                        stroke={PALETTE_SKIPPED}
                                        strokeWidth={2}
                                        strokeDasharray="4 3"
                                        fill={`${PALETTE_SKIPPED}26`}
                                    />
                                );
                            })}
                            {/* Privacy masks — solid black, tilt-following (same
                                quad as the burned-in box) so the overlay matches
                                the uploaded image. */}
                            {maskRegions.map((r, i) => {
                                const q = toQuadPoints(r);
                                if (!q) return null;
                                return (
                                    <Polygon
                                        key={`mk-${i}`}
                                        points={q.points}
                                        fill="#000"
                                        stroke="#000"
                                        strokeWidth={1}
                                    />
                                );
                            })}
                            {/* Footer bands (total / date / receipt №) as tilt-
                                following polygons, coloured per kind — they sit
                                well below the product section so no neighbour
                                clamp is needed. */}
                            {footerRegions.map((r, i) => {
                                const q = toQuadPoints(r);
                                if (!q) return null;
                                const s = footerBandStyle(r.kind, colors, t);
                                return (
                                    <Polygon
                                        key={`f-${i}`}
                                        points={q.points}
                                        stroke={s.colour}
                                        strokeWidth={2}
                                        fill={`${s.colour}1A`}
                                    />
                                );
                            })}
                            {/* Header bands (address / company-code) as tilt-
                                following polygons too. The parser already tiled
                                them (bent seams, no overlap with each other or the
                                product section), so they render straight from the
                                quad like every other band. */}
                            {headerRegions.map((r, i) => {
                                const q = toQuadPoints(r);
                                if (!q) return null;
                                const s = headerBandStyle(r.kind, colors, t);
                                return (
                                    <Polygon
                                        key={`h-${i}`}
                                        points={q.points}
                                        stroke={s.colour}
                                        strokeWidth={2}
                                        fill={`${s.colour}1A`}
                                    />
                                );
                            })}
                        </Svg>
                        {/* Per-product #N badge to the left of each band; the
                            band itself is the green SVG polygon above. */}
                        {productRegions.map((r, i) => {
                            const q = toQuadPoints(r);
                            if (!q) return null;
                            const BADGE_W = 26;
                            const BADGE_GAP = 4;
                            const badgeLeft =
                                q.left >= BADGE_W + BADGE_GAP ? q.left - BADGE_W - BADGE_GAP : 2;
                            return (
                                <View
                                    key={`pb-${i}`}
                                    pointerEvents="none"
                                    style={[
                                        styles.bandBadge,
                                        { top: q.midY - 9, left: badgeLeft, backgroundColor: colors.success },
                                    ]}
                                >
                                    <Text style={styles.bandBadgeText}>#{i + 1}</Text>
                                </View>
                            );
                        })}
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
