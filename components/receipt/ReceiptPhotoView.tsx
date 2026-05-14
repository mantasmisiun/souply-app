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
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useTheme, type AppTheme } from '../../constants/theme';

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

type BandGroup = 'address' | 'total' | 'dateTime' | 'receiptNo';

interface BandStyle {
    colour: string;
    label: string;
    group: BandGroup;
}

const headerBandStyle = (kind: string | undefined, colors: AppTheme, t: TFunction): BandStyle => {
    switch (kind) {
        case 'storeAddress':
        case 'storeName':
        case 'storeCode':
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
}

export default function ReceiptPhotoView({
    imageUri,
    imageDims,
    headerRegions,
    productRegions,
    footerRegions,
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
        if (ys.length < 2) return null;
        const yMin = Math.max(0, Math.min(...ys) - CONTENT_MARGIN_PX);
        const yMax = Math.min(imageDims.height, Math.max(...ys) + CONTENT_MARGIN_PX);
        if (yMax - yMin < imageDims.height * 0.2) return null;
        return { yMin, yMax };
    }, [headerRegions, productRegions, footerRegions, imageDims]);

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

    /** Page-1 pixel rect → display-space rect, with no padding and no
     *  neighbour-aware clamping. Used for product bands which already
     *  hug each row precisely and can't pad without bleeding into
     *  adjacent products. */
    const toDisplayRectRaw = (r: ReceiptRegion) => {
        if (!imageDims) return null;
        const rawTop = r.yTop * scale - cropOffsetY;
        const rawBottom = r.yBottom * scale - cropOffsetY;
        const rawLeft = r.xLeft * scale;
        const rawRight = r.xRight * scale;
        const top = Math.max(0, rawTop);
        const bottom = Math.min(stageH, rawBottom);
        const left = Math.max(0, rawLeft);
        const right = Math.min(containerW, rawRight);
        return {
            left,
            top,
            width: Math.max(2, right - left),
            height: Math.max(2, bottom - top),
        };
    };

    /** Layout a section's bands with padding + per-band clamping.
     *
     *  For each band, padding may NEVER extend past the midpoint of
     *  the original (unpadded) gap to a horizontally-overlapping
     *  neighbour. Two key consequences:
     *    • Side-by-side bands on the same physical row (e.g. "Kvito
     *      suma" + "12,34 EUR" → two OCR boxes at same y, different
     *      x) do NOT clamp each other, because they don't overlap
     *      horizontally. Both retain full padding.
     *    • Vertically-stacked bands in the same column (e.g. Rimi
     *      header: storeCode line over street line) clamp each other
     *      at the midpoint of their original gap. Padding cannot
     *      cross the divider, so neither band gets crushed away from
     *      its own text.
     *
     *  This replaces the previous "snap after padding overlap" rule
     *  which mistreated side-by-side bands and shrank both halves.
     */
    const layoutSection = (regions: ReceiptRegion[], padded: boolean) => {
        if (!imageDims) return regions.map(() => null);
        const padY = padded ? BAND_PADDING_Y_PX : 0;
        const padX = padded ? BAND_PADDING_X_PX : 0;

        return regions.map((r, i) => {
            if (!onPageOne(r)) return null;
            const rawTop = r.yTop * scale - cropOffsetY;
            const rawBottom = r.yBottom * scale - cropOffsetY;
            const rawLeft = r.xLeft * scale;
            const rawRight = r.xRight * scale;

            let upperDivider = 0;
            let lowerDivider = stageH;
            const myH = Math.max(1, rawBottom - rawTop);
            const myCenter = (rawTop + rawBottom) / 2;
            for (let j = 0; j < regions.length; j++) {
                if (j === i) continue;
                const other = regions[j];
                if (!onPageOne(other)) continue;
                // Horizontal overlap: bands in the same column can
                // constrain each other vertically. Side-by-side bands
                // (different columns) cannot.
                const horizOverlap = !(other.xRight < r.xLeft || other.xLeft > r.xRight);
                if (!horizOverlap) continue;
                const otherTop = other.yTop * scale - cropOffsetY;
                const otherBottom = other.yBottom * scale - cropOffsetY;
                const otherH = Math.max(1, otherBottom - otherTop);
                const otherCenter = (otherTop + otherBottom) / 2;
                // Same-row guard: two bands on the same physical OCR
                // line (e.g. Maxima `date` + `time` matched on a
                // shared "2026-01-13 15:42:30" line, or any kind
                // dedup that emits identical coords with different
                // labels) have centers closer than half the smaller
                // band's height. They shouldn't constrain each other
                // — without this, both bands snap to the midpoint and
                // cover only the top half of the digits.
                const vertCenterDist = Math.abs(otherCenter - myCenter);
                if (vertCenterDist < Math.min(myH, otherH) * 0.5) continue;
                if (otherCenter < myCenter) {
                    // 'other' sits above — midpoint of original gap
                    // (or overlap region) is the divider.
                    const divider = (otherBottom + rawTop) / 2;
                    if (divider > upperDivider) upperDivider = divider;
                } else {
                    const divider = (rawBottom + otherTop) / 2;
                    if (divider < lowerDivider) lowerDivider = divider;
                }
            }

            const top = Math.max(0, upperDivider, rawTop - padY);
            const bottom = Math.min(stageH, lowerDivider, rawBottom + padY);
            const left = Math.max(0, rawLeft - padX);
            const right = Math.min(containerW, rawRight + padX);
            return {
                left,
                top,
                width: Math.max(2, right - left),
                height: Math.max(2, bottom - top),
            };
        });
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
        return Array.from(groups.values()).sort((a, b) => a.order - b.order);
    }, [headerRegions, productRegions.length, footerRegions, colors, t]);

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
                        {/* Header bands — one per parsed field. Legacy
                            receipts pass a single block-bbox without
                            kind; both render via the same path. Layout
                            applies padding + clamps it at the midpoint
                            of original gaps to horizontally-overlapping
                            neighbours, so side-by-side same-row bands
                            keep full padding and stacked bands don't
                            cross into each other. */}
                        {layoutSection(headerRegions, true).map((rect, i) => {
                            if (!rect) return null;
                            const s = headerBandStyle(headerRegions[i].kind, colors, t);
                            return (
                                <View
                                    key={`h-${i}`}
                                    pointerEvents="none"
                                    style={[
                                        styles.overlay,
                                        rect,
                                        {
                                            borderColor: s.colour,
                                            backgroundColor: `${s.colour}1A`,
                                        },
                                    ]}
                                />
                            );
                        })}
                        {/* Per-product green band + #N badge to the
                            left. UNPADDED — adjacent product bands
                            touch by construction (parser walls); any
                            extra padding would bleed into neighbours
                            and make the row text unreadable. */}
                        {productRegions.map((r, i) => {
                            if (!onPageOne(r)) return null;
                            const rect = toDisplayRectRaw(r);
                            if (!rect) return null;
                            const BADGE_W = 26;
                            const BADGE_GAP = 4;
                            const badgeLeft =
                                rect.left >= BADGE_W + BADGE_GAP
                                    ? rect.left - BADGE_W - BADGE_GAP
                                    : 2;
                            const badgeTop = rect.top + rect.height / 2 - 9;
                            return (
                                <React.Fragment key={i}>
                                    <View
                                        pointerEvents="none"
                                        style={[
                                            styles.overlay,
                                            rect,
                                            {
                                                borderColor: colors.success,
                                                backgroundColor: `${colors.success}1A`,
                                            },
                                        ]}
                                    />
                                    <View
                                        pointerEvents="none"
                                        style={[
                                            styles.bandBadge,
                                            {
                                                top: badgeTop,
                                                left: badgeLeft,
                                                backgroundColor: colors.success,
                                            },
                                        ]}
                                    >
                                        <Text style={styles.bandBadgeText}>
                                            #{i + 1}
                                        </Text>
                                    </View>
                                </React.Fragment>
                            );
                        })}
                        {/* Footer bands — same layout rules as header.
                            Coloured per kind so the user can tell
                            total / date-time / receipt № at a glance.
                            Legacy block-bbox renders orange. */}
                        {layoutSection(footerRegions, true).map((rect, i) => {
                            if (!rect) return null;
                            const s = footerBandStyle(footerRegions[i].kind, colors, t);
                            return (
                                <View
                                    key={`f-${i}`}
                                    pointerEvents="none"
                                    style={[
                                        styles.overlay,
                                        rect,
                                        {
                                            borderColor: s.colour,
                                            backgroundColor: `${s.colour}1A`,
                                        },
                                    ]}
                                />
                            );
                        })}
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
                                colour={colors.success}
                                title={t('receiptPhoto.bands.products')}
                                body={t('receiptPhoto.explainer.productsBody')}
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
}: {
    colour: string;
    label: string;
    styles: ReturnType<typeof makeStyles>;
}) {
    return (
        <View style={styles.legendChip}>
            <View style={[styles.legendDot, { backgroundColor: colour }]} />
            <Text style={styles.legendLabel}>{label}</Text>
        </View>
    );
}

function ExplainerRow({
    colour,
    title,
    body,
    styles,
}: {
    colour: string;
    title: string;
    body: string;
    styles: ReturnType<typeof makeStyles>;
}) {
    return (
        <View style={styles.explainerRow}>
            <View style={[styles.explainerDot, { backgroundColor: colour }]} />
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
            paddingHorizontal: 24,
        },
        modalCard: {
            backgroundColor: c.cardBackground,
            borderRadius: 16,
            padding: 20,
            gap: 14,
        },
        modalTitle: {
            fontSize: 16,
            fontWeight: '700',
            color: c.textPrimary,
            textAlign: 'center',
        },
        modalBody: {
            fontSize: 13,
            lineHeight: 19,
            color: c.textSecondary,
        },
        modalLegendList: {
            gap: 12,
            marginTop: 4,
        },
        explainerRow: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 10,
        },
        explainerDot: {
            width: 12,
            height: 12,
            borderRadius: 6,
            marginTop: 4,
        },
        explainerTitle: {
            fontSize: 14,
            fontWeight: '700',
            color: c.textPrimary,
        },
        explainerBody: {
            fontSize: 12,
            color: c.textSecondary,
            marginTop: 2,
            lineHeight: 17,
        },
        modalCloseBtn: {
            backgroundColor: c.primary,
            borderRadius: 10,
            paddingVertical: 12,
            alignItems: 'center',
            marginTop: 6,
        },
        modalCloseText: {
            fontSize: 14,
            fontWeight: '700',
            color: c.onPrimary,
        },
    });
