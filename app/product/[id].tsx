import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Modal, Dimensions, ActivityIndicator } from 'react-native';
import { SkeletonBox } from '../../components/SkeletonBox';
import { ProductImage } from '../../components/ProductImage';
import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useLocalSearchParams, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../config/api';
import Svg, { Line, Circle, Polygon, Text as SvgText } from 'react-native-svg';
import { useTheme, type AppTheme } from '../../constants/theme';
import { useDisplayMode } from '../../contexts/DisplayPreferenceContext';
import { useTranslation } from 'react-i18next';
import { formatDate, formatEuro } from '../../utils/formatCurrency';
import { ChainFilterBar } from '../../components/ChainFilterBar';
import { ChainLogoStrip } from '../../components/ChainLogoStrip';
import { getChainMiniLogoUrl } from '../../utils/chainBrandName';
import { addProductToBasket } from '../../utils/basketUtils';
import { useBasketState } from '../../state/basketState';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import AmountPickerModal from '../../components/AmountPickerModal';
import { QuantityControl } from '../../components/QuantityControl';
import { resolveCanonicalStep, resolveDisplayUnit } from '../../utils/canonicalStep';

type Styles = ReturnType<typeof makeStyles>;

interface StoreProduct {
    id: number;
    productId: number;
    chainId: number;
    storeProductName: string;
    brandName: string | null;
    amount: string;
    unit: string;
    isWeighable: number;
    chainName: string;
    logoUrl: string;
    imageUrl: string | null;
}

interface PricePoint {
    price: number;
    promoPrice: number | null;
    date: string;
    storeName?: string;
    isFallback: number;
}

interface Chain {
    id: number;
    name: string;
    logoUrl: string;
}

interface Product {
    id: number;
    name: string;
    imageUrls: (string | null | undefined)[] | string | null;
    categoryId: number;
    minAmount: number | null;
    maxAmount: number | null;
    unit: string | null;
    hasWeighable: boolean;
    canonicalUnit: string | null;
    canonicalStep: number | null;
    canonicalFamily: 'fluid' | 'count' | null;
}

const MINI_CHART_WIDTH = 140;
const MINI_CHART_HEIGHT = 64;
const MINI_CHART_MAX_POINTS = 6;

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const MODAL_CHART_HEIGHT = 260;
// Modal chart's min width fits the card (screen width minus outer padding)
// so very short histories don't look squished. Longer histories grow the
// SVG width horizontally, and the parent ScrollView handles the overflow.
const MODAL_CHART_MIN_WIDTH = SCREEN_WIDTH - 80;

/**
 * Normalize/filter prices into a rendering-ready sequence:
 *   - Prefer non-fallback rows when ANY exist; otherwise use fallbacks
 *     (so freshly-scraped SPs that have never had a real receipt still
 *     show something instead of the empty state).
 *   - Sort ascending by date (left = old, right = new).
 *   - Optionally cap to the last N points (mini chart).
 */
function preparePriceData(prices: PricePoint[], maxPoints?: number): PricePoint[] {
    if (!prices.length) return [];
    const nonFallback = prices.filter(p => !p.isFallback);
    const base = nonFallback.length > 0 ? nonFallback : prices;
    const sorted = [...base].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    if (maxPoints && sorted.length > maxPoints) return sorted.slice(-maxPoints);
    return sorted;
}

type RangeKey = '1M' | '3M' | '6M' | 'all';

function filterByRange(data: PricePoint[], key: RangeKey): PricePoint[] {
    if (key === 'all') return data;
    const months = key === '1M' ? 1 : key === '3M' ? 3 : 6;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    return data.filter(p => new Date(p.date) >= cutoff);
}

const shortDate = (d: string) =>
    formatDate(d, { month: 'short', day: 'numeric' });

/**
 * Dual-series price chart. Regular price line in muted gray, promo price
 * line in primary (pink), with the area between them filled at low opacity
 * to signal the discount band. Points without a promoPrice render only on
 * the regular line, so the fill polygon "pinches" at those x-positions —
 * visually taking the user's hint that "we don't know exactly when the
 * discount started/ended, just draw back to neighbouring points without
 * discount".
 *
 * Edge case: a single data point that has BOTH price and promoPrice
 * renders as two dots vertically connected by a thin primary-color line
 * (the degenerate fill polygon). Dashed extensions run from each series'
 * last point to the right edge.
 *
 * API:
 *   - data: sorted-asc, already-filtered PricePoint[]
 *   - width/height: SVG canvas size
 *   - Returns just the SVG; the caller decides how to position price
 *     labels / tap targets around it.
 */
// Modal chart uses wider left padding to fit Y-axis price labels ("9,99 €").
// Must be kept in sync with the padding used in ModalChart's hit-test math.
const MODAL_CHART_PADDING = { top: 14, bottom: 18, left: 46, right: 10 };

// Mini chart: compact padding (no labels/dates) + MINI_TAIL px reserved on
// the right so dashed extension ticks are visible beyond the last data point.
const MINI_CHART_PAD = { top: 8, bottom: 8, left: 8, right: 8 };
const MINI_TAIL = 18;

const SCALE_PAD_RATIO = 0.12;

function PriceChartSvg({
    data,
    width,
    height,
    colors,
    activePtIndex = null,
    isModal = false,
}: {
    data: PricePoint[];
    width: number;
    height: number;
    colors: AppTheme;
    activePtIndex?: number | null;
    isModal?: boolean;
}) {
    if (!data.length) return null;

    const padding = isModal ? MODAL_CHART_PADDING : MINI_CHART_PAD;
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    // Y-axis min/max covers BOTH series combined so they share a scale.
    const allPriceValues: number[] = [];
    for (const d of data) {
        if (d.price !== null && d.price !== undefined) allPriceValues.push(Number(d.price));
        if (d.promoPrice !== null && d.promoPrice !== undefined) allPriceValues.push(Number(d.promoPrice));
    }
    const minPrice = Math.min(...allPriceValues);
    const maxPrice = Math.max(...allPriceValues);
    const range = maxPrice - minPrice;

    // Add 12% breathing room above and below so dots never sit flush
    // against the chart edges. Must match the same math in computeLastPointYs.
    const paddedMin = range === 0 ? minPrice : minPrice - range * SCALE_PAD_RATIO;
    const paddedRange = range === 0 ? 1 : range * (1 + 2 * SCALE_PAD_RATIO);
    const ypos = (v: number) => {
        if (range === 0) return padding.top + chartH / 2;
        return padding.top + chartH - ((v - paddedMin) / paddedRange) * chartH;
    };

    const points = data.map((d, i) => {
        const tail = isModal ? 0 : MINI_TAIL;
        const x = data.length === 1
            ? padding.left + (chartW - tail) / 2
            : padding.left + (i / (data.length - 1)) * (chartW - tail);
        const priceY = ypos(Number(d.price));
        const promoY = d.promoPrice !== null && d.promoPrice !== undefined
            ? ypos(Number(d.promoPrice))
            : null;
        return { x, priceY, promoY, date: d.date };
    });

    // Build fill polygon with explicit corner vertices at every promo
    // transition so the polygon makes right-angle turns instead of diagonal
    // interpolations:
    //   • promo start → insert (x, priceY) corner before (x, promoY) so the
    //     fill drops cleanly from the regular-price line (no phantom triangle)
    //   • promo end   → insert (nextX, prevPromoY) corner before (nextX, priceY)
    //     so the fill extends horizontally to the next scrape date (fills the
    //     rectangle bounded by the extension line + closing vertical)
    const hasAnyPromo = points.some(p => p.promoY !== null);
    const topEdge = points.map(p => `${p.x},${p.priceY}`);
    const bottomFwd: string[] = [];
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const prev = i > 0 ? points[i - 1] : null;
        if (p.promoY !== null) {
            if (prev === null || prev.promoY === null)
                bottomFwd.push(`${p.x},${p.priceY}`); // corner: open at regular price
            bottomFwd.push(`${p.x},${p.promoY}`);
        } else {
            if (prev !== null && prev.promoY !== null)
                bottomFwd.push(`${p.x},${prev.promoY}`); // corner: extend at prev promo level
            bottomFwd.push(`${p.x},${p.priceY}`);
        }
    }
    const fillPolygonPoints = [...topEdge, ...bottomFwd.reverse()].join(' ');

    const last = points[points.length - 1];
    const lastIdx = points.length - 1;

    // Modal-specific: compute x-axis date tick indices (up to 4)
    const modalTickIndices: number[] = [];
    if (isModal) {
        if (data.length <= 4) {
            for (let i = 0; i < data.length; i++) modalTickIndices.push(i);
        } else if (data.length <= 8) {
            const mid = Math.round((data.length - 1) / 2);
            modalTickIndices.push(0, mid, data.length - 1);
        } else {
            const t1 = Math.round((data.length - 1) / 3);
            const t2 = Math.round(((data.length - 1) * 2) / 3);
            modalTickIndices.push(0, t1, t2, data.length - 1);
        }
    }

    return (
        <Svg width={width} height={height}>
            {/* Discount fill — modal only; mini uses vertical bars instead */}
            {isModal && hasAnyPromo && (
                <Polygon
                    points={fillPolygonPoints}
                    fill={colors.primary}
                    fillOpacity={0.18}
                    stroke="none"
                />
            )}

            {/* Single-point dual-price vertical connector (degenerate fill) — modal only */}
            {isModal && points.length === 1 && points[0].promoY !== null && (
                <Line
                    x1={points[0].x}
                    y1={points[0].priceY}
                    x2={points[0].x}
                    y2={points[0].promoY!}
                    stroke={colors.primary}
                    strokeOpacity={0.5}
                    strokeWidth={1.5}
                />
            )}

            {/* Mini chart single-point: lines extend right from the data point only */}
            {!isModal && points.length === 1 && (
                <>
                    <Line
                        x1={points[0].x} y1={points[0].priceY}
                        x2={width - padding.right} y2={points[0].priceY}
                        stroke={colors.textSecondary} strokeWidth={1.5}
                    />
                    {points[0].promoY !== null && (
                        <Line
                            x1={points[0].x} y1={points[0].promoY}
                            x2={width - padding.right} y2={points[0].promoY}
                            stroke={colors.primary} strokeWidth={1.5}
                        />
                    )}
                </>
            )}

            {/* Regular price line — continuous across all points */}
            {points.length > 1 &&
                points.map((p, i) => {
                    if (i === 0) return null;
                    const prev = points[i - 1];
                    return (
                        <Line
                            key={`rl-${i}`}
                            x1={prev.x}
                            y1={prev.priceY}
                            x2={p.x}
                            y2={p.priceY}
                            stroke={colors.textSecondary}
                            strokeWidth={1.5}
                        />
                    );
                })}

            {/* Promo line — consecutive pairs only (both modal and mini) */}
            {points.length > 1 &&
                points.map((p, i) => {
                    if (i === 0) return null;
                    const prev = points[i - 1];
                    if (prev.promoY === null || p.promoY === null) return null;
                    return (
                        <Line
                            key={`pl-${i}`}
                            x1={prev.x} y1={prev.promoY}
                            x2={p.x} y2={p.promoY}
                            stroke={colors.primary}
                            strokeWidth={1.5}
                        />
                    );
                })}

            {/* Mini promo boundaries — same logic as modal */}
            {!isModal && points.map((p, i) => {
                const prevHasPromo = i > 0 && points[i - 1].promoY !== null;
                const nextHasPromo = i < points.length - 1 && points[i + 1].promoY !== null;
                const isPromoStart = p.promoY !== null && !prevHasPromo;
                const isPromoEnd   = p.promoY !== null && i < points.length - 1 && !nextHasPromo;
                const elems: React.ReactNode[] = [];

                if (isPromoStart) {
                    elems.push(
                        <Line key={`promo-open-${i}`}
                            x1={p.x} y1={p.priceY} x2={p.x} y2={p.promoY!}
                            stroke={colors.primary} strokeWidth={1}
                            strokeDasharray="2,2" strokeOpacity={0.65}
                        />
                    );
                }

                if (isPromoEnd) {
                    const next = points[i + 1];
                    elems.push(
                        <Line key={`promo-ext-${i}`}
                            x1={p.x} y1={p.promoY!} x2={next.x} y2={p.promoY!}
                            stroke={colors.primary} strokeWidth={1.5}
                            strokeOpacity={0.7}
                        />,
                        <Line key={`promo-close-${i}`}
                            x1={next.x} y1={p.promoY!} x2={next.x} y2={next.priceY}
                            stroke={colors.primary} strokeWidth={1}
                            strokeDasharray="2,2" strokeOpacity={0.65}
                        />
                    );
                }

                return elems.length > 0 ? <React.Fragment key={`promo-boundary-${i}`}>{elems}</React.Fragment> : null;
            })}

            {/* Solid extensions from last point to the right edge (multi-point only) */}
            {(isModal || points.length > 1) && (
                <>
                    <Line
                        x1={last.x}
                        y1={last.priceY}
                        x2={width - padding.right}
                        y2={last.priceY}
                        stroke={colors.textSecondary}
                        strokeWidth={1.25}
                    />
                    {last.promoY !== null && (
                        <Line
                            x1={last.x}
                            y1={last.promoY}
                            x2={width - padding.right}
                            y2={last.promoY}
                            stroke={colors.primary}
                            strokeWidth={1.25}
                        />
                    )}
                </>
            )}

            {/* Modal: Y-axis min/max reference lines + value labels */}
            {isModal && range > 0 && (
                <>
                    <Line x1={padding.left} y1={ypos(maxPrice)} x2={width - padding.right} y2={ypos(maxPrice)}
                        stroke={colors.textMuted} strokeWidth={0.5} strokeDasharray="2,3" strokeOpacity={0.45} />
                    <SvgText x={padding.left - 4} y={ypos(maxPrice) + 3.5}
                        fontSize={9} fill={colors.textMuted} textAnchor="end">
                        {formatEuro(maxPrice)}
                    </SvgText>
                    <Line x1={padding.left} y1={ypos(minPrice)} x2={width - padding.right} y2={ypos(minPrice)}
                        stroke={colors.textMuted} strokeWidth={0.5} strokeDasharray="2,3" strokeOpacity={0.45} />
                    <SvgText x={padding.left - 4} y={ypos(minPrice) + 3.5}
                        fontSize={9} fill={colors.textMuted} textAnchor="end">
                        {formatEuro(minPrice)}
                    </SvgText>
                </>
            )}

            {/* Modal: promo period boundaries */}
            {isModal && points.map((p, i) => {
                const prevHasPromo = i > 0 && points[i - 1].promoY !== null;
                const nextHasPromo = i < points.length - 1 && points[i + 1].promoY !== null;
                const isPromoStart = p.promoY !== null && !prevHasPromo;
                const isPromoEnd   = p.promoY !== null && i < points.length - 1 && !nextHasPromo;
                const elems: React.ReactNode[] = [];

                // Opening: dashed vertical drop from regular → promo price
                if (isPromoStart) {
                    elems.push(
                        <Line key={`promo-open-${i}`}
                            x1={p.x} y1={p.priceY} x2={p.x} y2={p.promoY!}
                            stroke={colors.primary} strokeWidth={1}
                            strokeDasharray="2,2" strokeOpacity={0.65}
                        />
                    );
                }

                // Closing: horizontal extension to next scrape date + vertical return to regular
                if (isPromoEnd) {
                    const next = points[i + 1];
                    elems.push(
                        <Line key={`promo-ext-${i}`}
                            x1={p.x} y1={p.promoY!} x2={next.x} y2={p.promoY!}
                            stroke={colors.primary} strokeWidth={1.5}
                            strokeOpacity={0.7}
                        />,
                        <Line key={`promo-close-${i}`}
                            x1={next.x} y1={p.promoY!} x2={next.x} y2={next.priceY}
                            stroke={colors.primary} strokeWidth={1}
                            strokeDasharray="2,2" strokeOpacity={0.65}
                        />
                    );
                }

                return elems.length > 0 ? <React.Fragment key={`promo-boundary-${i}`}>{elems}</React.Fragment> : null;
            })}

            {/* Dots */}
            {isModal ? (
                <>
                    {/* Regular price dots — modal style */}
                    {points.map((p, i) => {
                        if (activePtIndex !== null && i === activePtIndex) return null; // drawn later
                        if (i === lastIdx && activePtIndex === null) {
                            // Last dot: outer ring + inner filled
                            return (
                                <React.Fragment key={`dot-r-${i}`}>
                                    <Circle cx={p.x} cy={p.priceY} r={5} fill="transparent" stroke={colors.textSecondary} strokeWidth={1.5} strokeOpacity={0.4} />
                                    <Circle cx={p.x} cy={p.priceY} r={3} fill={colors.textSecondary} />
                                </React.Fragment>
                            );
                        }
                        return <Circle key={`dot-r-${i}`} cx={p.x} cy={p.priceY} r={2.5} fill={colors.textSecondary} />;
                    })}
                    {/* Promo price dots — modal style */}
                    {points.map((p, i) => {
                        if (p.promoY === null) return null;
                        if (activePtIndex !== null && i === activePtIndex) return null; // drawn later
                        if (i === lastIdx && activePtIndex === null) {
                            return (
                                <React.Fragment key={`dot-p-${i}`}>
                                    <Circle cx={p.x} cy={p.promoY} r={5} fill="transparent" stroke={colors.primary} strokeWidth={1.5} strokeOpacity={0.4} />
                                    <Circle cx={p.x} cy={p.promoY} r={3} fill={colors.primary} />
                                </React.Fragment>
                            );
                        }
                        return <Circle key={`dot-p-${i}`} cx={p.x} cy={p.promoY} r={2.5} fill={colors.primary} />;
                    })}
                    {/* Crosshair */}
                    {activePtIndex !== null && (
                        <>
                            <Line
                                x1={points[activePtIndex].x}
                                y1={padding.top}
                                x2={points[activePtIndex].x}
                                y2={height - padding.bottom}
                                stroke={colors.textSecondary}
                                strokeWidth={1}
                                strokeDasharray="3,3"
                                strokeOpacity={0.5}
                            />
                            <Circle cx={points[activePtIndex].x} cy={points[activePtIndex].priceY} r={4} fill={colors.textSecondary} />
                            {points[activePtIndex].promoY !== null && (
                                <Circle cx={points[activePtIndex].x} cy={points[activePtIndex].promoY!} r={4} fill={colors.primary} />
                            )}
                        </>
                    )}
                </>
            ) : null}

            {/* Date labels */}
            {isModal ? (
                // Modal: evenly-spaced date ticks
                modalTickIndices.map((idx, tickPos) => {
                    const p = points[idx];
                    const isFirst = tickPos === 0;
                    const isLast = tickPos === modalTickIndices.length - 1;
                    const anchor = isFirst ? 'start' : isLast ? 'end' : 'middle';
                    return (
                        <SvgText
                            key={`date-${idx}`}
                            x={p.x}
                            y={height - 3}
                            fontSize={9}
                            fill={colors.textMuted}
                            textAnchor={anchor}
                        >
                            {shortDate(p.date)}
                        </SvgText>
                    );
                })
            ) : null}
        </Svg>
    );
}

function MiniPriceChart({
    prices,
    colors,
    styles,
    onTap,
}: {
    prices: PricePoint[];
    colors: AppTheme;
    styles: Styles;
    onTap?: () => void;
}) {
    // Show last 3 months — recent enough to reflect current trends; fall back
    // to all available data if nothing exists within that window.
    const allData = preparePriceData(prices);
    const recentData = filterByRange(allData, '3M');
    const data = (recentData.length > 0 ? recentData : allData).slice(-MINI_CHART_MAX_POINTS);

    if (!data.length) {
        return (
            <View style={styles.chartEmpty}>
                <Ionicons name="analytics-outline" size={20} color={colors.border} />
            </View>
        );
    }

    return (
        <TouchableOpacity
            style={styles.chartContainer}
            activeOpacity={0.7}
            onPress={onTap}
            disabled={!onTap}
        >
            <PriceChartSvg
                data={data}
                width={MINI_CHART_WIDTH}
                height={MINI_CHART_HEIGHT}
                colors={colors}
            />
        </TouchableOpacity>
    );
}

function ModalChart({
    prices,
    colors,
    styles,
}: {
    prices: PricePoint[];
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}) {
    const { t } = useTranslation();
    const [rangeKey, setRangeKey] = useState<RangeKey>('all');
    const [crosshairIndex, setCrosshairIndex] = useState<number | null>(null);
    const crosshairTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const allData = useMemo(() => preparePriceData(prices), [prices]);
    const data = useMemo(() => filterByRange(allData, rangeKey), [allData, rangeKey]);

    const chartWidth = MODAL_CHART_MIN_WIDTH;

    // Compute point X positions for gesture hit-testing (must match PriceChartSvg math)
    const padding = MODAL_CHART_PADDING;
    const chartW = chartWidth - padding.left - padding.right;
    const pointXs = useMemo(() => data.map((_, i) =>
        data.length === 1
            ? padding.left + chartW / 2
            : padding.left + (i / (data.length - 1)) * chartW
    ), [data, chartW]);

    const handleChartTouch = (x: number) => {
        if (!pointXs.length) return;
        let nearest = 0, minDist = Infinity;
        pointXs.forEach((px, i) => { const d = Math.abs(px - x); if (d < minDist) { minDist = d; nearest = i; } });
        setCrosshairIndex(nearest);
        if (crosshairTimer.current) clearTimeout(crosshairTimer.current);
        crosshairTimer.current = setTimeout(() => setCrosshairIndex(null), 3000);
    };

    // Show crosshair point or last point
    const displayIndex = crosshairIndex ?? (data.length > 0 ? data.length - 1 : null);
    const displayPt = displayIndex !== null ? data[displayIndex] : null;

    const RANGE_LABELS: Record<RangeKey, string> = { '1M': '1M', '3M': '3M', '6M': '6M', 'all': t('product.rangeAll') };

    if (data.length === 0) {
        return (
            <View style={styles.chartModalEmpty}>
                <Text style={styles.chartModalEmptyText}>{t('product.noDataForPeriod')}</Text>
            </View>
        );
    }

    return (
        <>
            {/* Price display row */}
            {displayPt && (
                <View style={styles.chartPriceDisplay}>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                        {displayPt.promoPrice !== null && displayPt.promoPrice !== undefined ? (
                            <>
                                <Text style={styles.chartDisplayPromo}>
                                    {formatEuro(Number(displayPt.promoPrice))}
                                </Text>
                                <Text style={styles.chartDisplayStrike}>
                                    {formatEuro(Number(displayPt.price))}
                                </Text>
                            </>
                        ) : (
                            <Text style={styles.chartDisplayPrice}>
                                {formatEuro(Number(displayPt.price))}
                            </Text>
                        )}
                    </View>
                    <Text style={styles.chartDisplayDate}>{shortDate(displayPt.date)}</Text>
                </View>
            )}

            {/* Range pills */}
            <View style={styles.rangePills}>
                {(['1M', '3M', '6M', 'all'] as RangeKey[]).map(key => (
                    <TouchableOpacity
                        key={key}
                        style={[styles.rangePill, rangeKey === key && styles.rangePillActive]}
                        onPress={() => { setRangeKey(key); setCrosshairIndex(null); }}
                    >
                        <Text style={[styles.rangePillText, rangeKey === key && styles.rangePillTextActive]}>
                            {RANGE_LABELS[key]}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>

            {/* Chart */}
            <View style={{ width: chartWidth, height: MODAL_CHART_HEIGHT }}>
                <PriceChartSvg
                    data={data}
                    width={chartWidth}
                    height={MODAL_CHART_HEIGHT}
                    colors={colors}
                    isModal={true}
                    activePtIndex={crosshairIndex}
                />
                <View
                    style={{ position: 'absolute', top: 0, left: 0, width: chartWidth, height: MODAL_CHART_HEIGHT }}
                    onStartShouldSetResponder={() => true}
                    onMoveShouldSetResponder={() => true}
                    onResponderGrant={e => handleChartTouch(e.nativeEvent.locationX)}
                    onResponderMove={e => handleChartTouch(e.nativeEvent.locationX)}
                />
            </View>

            {/* Legend */}
            <View style={styles.chartModalFooter}>
                <View style={styles.chartModalLegend}>
                    <View style={styles.chartModalLegendItem}>
                        <View style={[styles.chartModalLegendDot, { backgroundColor: colors.textSecondary }]} />
                        <Text style={styles.chartModalLegendLabel}>{t('product.regularPrice')}</Text>
                    </View>
                    <View style={styles.chartModalLegendItem}>
                        <View style={[styles.chartModalLegendDot, { backgroundColor: colors.primary }]} />
                        <Text style={styles.chartModalLegendLabel}>{t('product.promoPrice')}</Text>
                    </View>
                </View>
            </View>
        </>
    );
}

export default function ProductDetailScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { id } = useLocalSearchParams<{ id: string }>();
    const [product, setProduct] = useState<Product | null>(null);
    const [categoryParts, setCategoryParts] = useState<string[]>([]);
    const [storeProducts, setStoreProducts] = useState<StoreProduct[]>([]);
    const [allChains, setAllChains] = useState<Chain[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedChainId, setSelectedChainId] = useState<number | null>(null);
    const [priceCache, setPriceCache] = useState<{ [key: string]: PricePoint[] }>({});
    const [chartModalSp, setChartModalSp] = useState<StoreProduct | null>(null);
    const [isAdding, setIsAdding] = useState(false);
    const [basketQuantity, setBasketQuantity] = useState(0);
    const [amountModalVisible, setAmountModalVisible] = useState(false);
    const { mode, ready: prefReady } = useDisplayMode();
    const { draftBasketId, setDraftBasketId } = useBasketState();
    const { bottom: bottomInset } = useSafeAreaInsets();
    const draftBasketIdRef = useRef(draftBasketId);
    useEffect(() => { draftBasketIdRef.current = draftBasketId; }, [draftBasketId]);

    useEffect(() => {
        fetch(`${API_BASE_URL}/api/chains`)
            .then(r => r.json())
            .then(data => setAllChains(Array.isArray(data) ? data : []))
            .catch(() => {});
    }, []);

    // Get chains for tabs: use DB-sourced logos from /api/chains as the base,
    // filled in by storeProducts for any chain the API hasn't returned yet.
    const chains = useMemo(() => {
        const chainMap = new Map<number, Chain>();
        allChains.forEach(c => chainMap.set(c.id, c));
        storeProducts.forEach(sp => {
            if (!chainMap.has(sp.chainId)) {
                chainMap.set(sp.chainId, { id: sp.chainId, name: sp.chainName, logoUrl: sp.logoUrl });
            }
        });
        return [1, 2, 3, 4, 5].flatMap(id => {
            const c = chainMap.get(id);
            const hasProducts = storeProducts.some(sp => sp.chainId === id);
            return c && hasProducts ? [c] : [];
        });
    }, [allChains, storeProducts]);

    const filteredStoreProducts = useMemo(() => {
        if (!selectedChainId) return storeProducts;
        return storeProducts.filter(sp => sp.chainId === selectedChainId);
    }, [storeProducts, selectedChainId]);

    // Fetch product and store products
    useEffect(() => {
        if (!prefReady) return; // wait for AsyncStorage-backed mode load
        const fetchData = async () => {
            setLoading(true);
            try {
                // In base mode, the SP fetch returns the whole cluster
                // (head + all variants) so chain tabs + the list below show
                // every variant side-by-side. In sku mode it's exactly this
                // Product's SPs, same as pre-Phase-1.
                const [prodRes, spRes] = await Promise.all([
                    fetch(`${API_BASE_URL}/api/products/${id}`),
                    fetch(`${API_BASE_URL}/api/store-products/product/${id}?mode=${mode}`),
                ]);
                const prodData = await prodRes.json();
                const spData = await spRes.json();
                setProduct(prodData);
                setStoreProducts(Array.isArray(spData) ? spData : []);
                if (prodData?.categoryId) {
                    fetch(`${API_BASE_URL}/api/categories/${prodData.categoryId}/path`)
                        .then(r => r.json())
                        .then(({ path }) => {
                            if (typeof path === 'string') setCategoryParts(path.split(' > '));
                        })
                        .catch(() => {});
                }
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [id, mode, prefReady]);

    // Fetch price history for visible store products
    useEffect(() => {
        const fetchPrices = async () => {
            for (const sp of filteredStoreProducts) {
                const cacheKey = `${sp.id}-all`;
                if (priceCache[cacheKey]) continue;
                try {
                    const res = await fetch(`${API_BASE_URL}/api/prices/store-product/${sp.id}/history`);
                    const data = await res.json();
                    setPriceCache(prev => ({ ...prev, [cacheKey]: Array.isArray(data) ? data : [] }));
                } catch {
                    setPriceCache(prev => ({ ...prev, [cacheKey]: [] }));
                }
            }
        };
        if (filteredStoreProducts.length > 0) fetchPrices();
    }, [filteredStoreProducts]);

    const getPricesForSp = (spId: number): PricePoint[] => priceCache[`${spId}-all`] || [];

    const BAR_HEIGHT = 64;

    const fetchBasketQty = useCallback(() => {
        const bid = useBasketState.getState().draftBasketId;
        if (!bid) { setBasketQuantity(0); return; }
        fetch(`${API_BASE_URL}/api/baskets/${bid}/items`)
            .then(r => r.json())
            .then((items: any[]) => {
                if (!Array.isArray(items)) return;
                const found = items.find((i: any) => i.productId === Number(id));
                setBasketQuantity(found ? parseFloat(found.quantity) : 0);
            })
            .catch(() => {});
    }, [id]);

    useFocusEffect(useCallback(() => { fetchBasketQty(); }, [fetchBasketQty]));

    const handleAdd = useCallback(() => {
        if (!product || isAdding) return;
        const hasRange = product.minAmount !== null && product.maxAmount !== null
            && product.minAmount !== product.maxAmount;
        if (hasRange || !!product.hasWeighable) {
            setAmountModalVisible(true);
            return;
        }
        const qty = resolveCanonicalStep(product);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setIsAdding(true);
        addProductToBasket(product.id, draftBasketId, setDraftBasketId, qty, mode)
            .then(result => { if (result.success) setBasketQuantity(qty); })
            .finally(() => setIsAdding(false));
    }, [product, isAdding, draftBasketId, mode]);

    const handleDecrement = useCallback(() => {
        if (!product) return;
        const step = resolveCanonicalStep(product);
        const newQty = Math.round((basketQuantity - step) / step) * step;
        const bid = draftBasketIdRef.current;
        if (newQty <= 0) {
            setBasketQuantity(0);
            if (!bid) return;
            fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async (all: any[]) => {
                const found = Array.isArray(all) ? all.find((i: any) => i.productId === product.id) : null;
                if (found) await fetch(`${API_BASE_URL}/api/basket-items/${found.id}`, { method: 'DELETE' });
                const remaining = Array.isArray(all) ? all.filter((i: any) => i.id !== found?.id) : [];
                if (remaining.length === 0) {
                    await fetch(`${API_BASE_URL}/api/baskets/${bid}`, { method: 'DELETE' });
                    setDraftBasketId(null);
                }
            }).catch(() => {});
        } else {
            setBasketQuantity(newQty);
            if (!bid) return;
            fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async (all: any[]) => {
                const found = Array.isArray(all) ? all.find((i: any) => i.productId === product.id) : null;
                if (found) await fetch(`${API_BASE_URL}/api/basket-items/${found.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ quantity: newQty }),
                });
            }).catch(() => {});
        }
    }, [product, basketQuantity, setDraftBasketId]);

    const handleIncrement = useCallback(() => {
        if (!product) return;
        const step = resolveCanonicalStep(product);
        const newQty = Math.round((basketQuantity + step) / step) * step;
        const bid = draftBasketIdRef.current;
        setBasketQuantity(newQty);
        if (!bid) return;
        fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async (all: any[]) => {
            const found = Array.isArray(all) ? all.find((i: any) => i.productId === product.id) : null;
            if (found) await fetch(`${API_BASE_URL}/api/basket-items/${found.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: newQty }),
            });
        }).catch(() => {});
    }, [product, basketQuantity]);

    if (loading) return (
        <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, gap: 10 }}>
            <View style={{ backgroundColor: colors.cardBackground, borderRadius: 12, padding: 16, gap: 10 }}>
                {Array.from({ length: 4 }).map((_, i) => (
                    <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <SkeletonBox width={52} height={52} borderRadius={8} />
                        <View style={{ flex: 1, gap: 6 }}>
                            <SkeletonBox width={140} height={12} borderRadius={5} />
                            <SkeletonBox width={80} height={11} borderRadius={5} />
                            <SkeletonBox width={60} height={13} borderRadius={5} />
                        </View>
                        <SkeletonBox width={MINI_CHART_WIDTH} height={MINI_CHART_HEIGHT} borderRadius={6} />
                    </View>
                ))}
            </View>
        </ScrollView>
    );
    if (!product) return <Text style={styles.centered}>Produktas nerastas</Text>;

    return (
        <>
            <Stack.Screen options={{
                headerBackTitle: 'Atgal',
                headerStyle: { backgroundColor: colors.cardBackground },
                headerShadowVisible: false,
                headerTitle: () => (
                    <View style={styles.navHeaderWrap}>
                        <Text style={styles.navTitle} numberOfLines={1}>{product.name}</Text>
                        {categoryParts.length > 0 && (
                            <View style={styles.navBreadcrumb}>
                                {categoryParts.map((part, i) => (
                                    <React.Fragment key={i}>
                                        {i > 0 && <Text style={styles.navBreadcrumbSep}>›</Text>}
                                        <Text style={styles.navBreadcrumbPart} numberOfLines={1}>{part}</Text>
                                    </React.Fragment>
                                ))}
                            </View>
                        )}
                    </View>
                ),
            }} />
            <ScrollView style={styles.container} stickyHeaderIndices={[0]} contentContainerStyle={{ paddingBottom: BAR_HEIGHT + 16 }}>
                {/* Chain filter */}
                <ChainFilterBar
                    chains={chains}
                    selectedId={selectedChainId}
                    onSelect={setSelectedChainId}
                    allLabel={t('product.allStores')}
                />

                {/* StoreProduct list */}
                {filteredStoreProducts.length === 0 ? (
                    <View style={styles.emptyContainer}>
                        <Ionicons name="alert-circle-outline" size={40} color={colors.border} />
                        <Text style={styles.emptyText}>{t('product.notAvailable')}</Text>
                    </View>
                ) : (
                    filteredStoreProducts.map(sp => {
                        const prices = getPricesForSp(sp.id);
                        const latestPrice = prices.length > 0
                            ? prices[prices.length - 1]
                            : null;
                        const amt = parseFloat(sp.amount);
                        const amountStr = !isNaN(amt) && sp.unit
                            ? sp.unit === 'g' && amt >= 1000
                                ? `${amt / 1000} kg`
                                : `${amt} ${sp.unit}`
                            : null;

                        return (
                            <View key={sp.id} style={styles.spCard}>
                                <View style={styles.spLeft}>
                                    <ProductImage
                                        uris={[sp.imageUrl]}
                                        imageStyle={styles.spImage}
                                        placeholderStyle={styles.spImagePlaceholder}
                                        emojiStyle={styles.spImageEmoji}
                                    />

                                    <View style={styles.spInfo}>
                                        <Text style={styles.spName} numberOfLines={2}>{sp.storeProductName}</Text>
                                        {amountStr ? <Text style={styles.spAmount}>{amountStr}</Text> : null}
                                        {latestPrice && (
                                            <View style={styles.priceRow}>
                                                <Text style={[
                                                    styles.spPrice,
                                                    latestPrice.promoPrice != null && styles.spPriceStrike,
                                                ]}>
                                                    {formatEuro(Number(latestPrice.price))}
                                                </Text>
                                                {latestPrice.promoPrice && (
                                                    <Text style={styles.spPromoPrice}>
                                                        {formatEuro(Number(latestPrice.promoPrice))}
                                                    </Text>
                                                )}
                                            </View>
                                        )}
                                    </View>
                                </View>
                                <View style={styles.spRight}>
                                    <MiniPriceChart
                                        prices={prices}
                                        colors={colors}
                                        styles={styles}
                                        onTap={() => setChartModalSp(sp)}
                                    />
                                </View>
                                <ChainLogoStrip
                                    chainLogos={[{ chainId: sp.chainId, logoUrl: getChainMiniLogoUrl(sp.chainId, sp.logoUrl) }]}
                                    style={{ position: 'absolute', top: 12, left: 12, transform: [{ scale: 0.7 }], transformOrigin: 'top left', backgroundColor: 'transparent', paddingHorizontal: 0, paddingVertical: 0, shadowOpacity: 0, elevation: 0 }}
                                />
                            </View>
                        );
                    })
                )}
                <View style={{ height: 40 }} />
            </ScrollView>

            {/* Sticky bottom add-to-basket bar */}
            <View style={[styles.addBar, { paddingBottom: bottomInset || 12 }]}>
                {basketQuantity > 0 ? (
                    <QuantityControl
                        quantity={basketQuantity}
                        onDecrement={handleDecrement}
                        onIncrement={handleIncrement}
                        unit={resolveDisplayUnit(product)}
                        size="large"
                        style={{ width: '100%' }}
                    />
                ) : (
                    <TouchableOpacity
                        style={[styles.addButton, isAdding && styles.addButtonDone]}
                        onPress={handleAdd}
                        disabled={isAdding}
                        activeOpacity={0.8}
                    >
                        {isAdding
                            ? <ActivityIndicator size="small" color="#fff" />
                            : <Ionicons name="cart-outline" size={20} color="#fff" />}
                        <Text style={styles.addButtonText}>{t('product.addToBasket')}</Text>
                    </TouchableOpacity>
                )}
            </View>

            <AmountPickerModal
                visible={amountModalVisible}
                productName={product.name}
                canonicalUnit={product.canonicalUnit}
                canonicalStep={product.canonicalStep}
                canonicalFamily={product.canonicalFamily}
                minAmount={product.minAmount ?? 0}
                maxAmount={product.maxAmount ?? 0}
                unit={product.unit ?? 'g'}
                isWeighable={!!product.hasWeighable}
                onCancel={() => setAmountModalVisible(false)}
                onConfirm={async (amount) => {
                    setAmountModalVisible(false);
                    setIsAdding(true);
                    const result = await addProductToBasket(product.id, draftBasketId, setDraftBasketId, amount, mode);
                    setIsAdding(false);
                    if (result.success) setBasketQuantity(amount);
                }}
            />

            <Modal
                visible={chartModalSp !== null}
                transparent
                animationType="fade"
                onRequestClose={() => setChartModalSp(null)}
            >
                <TouchableOpacity
                    style={styles.chartModalBackdrop}
                    activeOpacity={1}
                    onPress={() => setChartModalSp(null)}
                >
                    <TouchableOpacity
                        style={styles.chartModalCard}
                        activeOpacity={1}
                        onPress={() => {}}
                    >
                        <Text style={styles.chartModalTitle} numberOfLines={2}>
                            {chartModalSp?.storeProductName}
                        </Text>
                        <Text style={styles.chartModalSub}>{t('product.priceHistory')}</Text>
                        {chartModalSp && (() => {
                            const prices = getPricesForSp(chartModalSp.id);
                            const allData = preparePriceData(prices);
                            if (!allData.length) {
                                return (
                                    <View style={styles.chartModalEmpty}>
                                        <Ionicons name="analytics-outline" size={28} color={colors.border} />
                                        <Text style={styles.chartModalEmptyText}>{t('product.priceHistoryEmpty')}</Text>
                                    </View>
                                );
                            }
                            return <ModalChart prices={prices} colors={colors} styles={styles} />;
                        })()}
                    </TouchableOpacity>
                </TouchableOpacity>
            </Modal>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

    navHeaderWrap: { alignItems: 'flex-start' },
    navTitle: { fontSize: 16, fontWeight: '600', color: c.textPrimary },
    navBreadcrumb: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 1 },
    navBreadcrumbSep: { fontSize: 10, color: c.textMuted },
    navBreadcrumbPart: { fontSize: 11, color: c.textMuted, flexShrink: 1, minWidth: 16 },

    // StoreProduct cards
    spCard: {
        flexDirection: 'row',
        backgroundColor: c.cardBackground,
        marginHorizontal: 16,
        marginTop: 10,
        borderRadius: 12,
        padding: 12,
        elevation: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
    },
    spLeft: {
        flex: 1,
        flexDirection: 'row',
        gap: 10,
    },
    spImage: {
        width: 52,
        height: 52,
        borderRadius: 8,
    },
    spImagePlaceholder: {
        width: 52,
        height: 52,
        borderRadius: 8,
        backgroundColor: c.surfaceSubtle,
        alignItems: 'center',
        justifyContent: 'center',
    },
    spImageEmoji: {
        fontSize: 28,
        opacity: 0.4,
    },
    spInfo: {
        flex: 1,
        justifyContent: 'center',
    },
    spName: {
        fontSize: 13,
        color: c.textPrimary,
        fontWeight: '500',
        lineHeight: 18,
    },
    spAmount: {
        fontSize: 12,
        color: c.textMuted,
        marginTop: 2,
    },
    priceRow: {
        flexDirection: 'row',
        gap: 6,
        alignItems: 'center',
        marginTop: 3,
    },
    spPrice: {
        fontSize: 14,
        fontWeight: '700',
        color: c.textPrimary,
    },
    spPriceStrike: {
        textDecorationLine: 'line-through',
        color: c.textMuted,
        fontWeight: '400',
        fontSize: 12,
    },
    spPromoPrice: {
        fontSize: 14,
        fontWeight: '700',
        color: c.primary,
    },
    spRight: {
        justifyContent: 'center',
        alignItems: 'center',
    },

    // Chart
    chartContainer: {
        alignItems: 'center',
    },
    chartEmpty: {
        width: MINI_CHART_WIDTH,
        height: MINI_CHART_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    chartPrice: {
        fontSize: 11,
        color: c.primary,
        fontWeight: '600',
        marginTop: 2,
    },
    chartPriceStack: {
        alignItems: 'center',
        marginTop: 2,
        gap: 1,
    },
    chartPriceStrike: {
        fontSize: 10,
        color: c.textMuted,
        textDecorationLine: 'line-through',
    },
    chartPricePromo: {
        fontSize: 12,
        color: c.primary,
        fontWeight: '700',
    },
    // Chart modal (tap-to-expand)
    chartModalBackdrop: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    chartModalCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 16,
        padding: 20,
        width: '100%',
        maxWidth: 480,
    },
    chartModalTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: c.textPrimary,
    },
    chartModalSub: {
        fontSize: 12,
        color: c.textSecondary,
        marginTop: 2,
        marginBottom: 12,
    },
    chartModalEmpty: {
        height: MODAL_CHART_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
    },
    chartModalEmptyText: {
        fontSize: 13,
        color: c.textMuted,
    },
    chartModalFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 12,
    },
    chartModalLegend: {
        flexDirection: 'row',
        gap: 14,
    },
    chartModalLegendItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    chartModalLegendDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    chartModalLegendLabel: {
        fontSize: 12,
        color: c.textSecondary,
        fontWeight: '500',
    },
    chartModalPriceStack: {
        alignItems: 'flex-end',
    },
    chartModalLastPrice: {
        fontSize: 16,
        fontWeight: '700',
        color: c.primary,
    },

    // Empty
    emptyContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        padding: 48,
        gap: 12,
    },
    emptyText: {
        fontSize: 14,
        color: c.textMuted,
        textAlign: 'center',
    },

    // Range pills
    rangePills: {
        flexDirection: 'row',
        gap: 6,
        marginBottom: 10,
    },
    rangePill: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
        backgroundColor: c.softAccent,
    },
    rangePillActive: {
        backgroundColor: c.primary,
    },
    rangePillText: {
        fontSize: 12,
        fontWeight: '500',
        color: c.textSecondary,
    },
    rangePillTextActive: {
        color: c.onPrimary,
    },
    // Chart price display (above range pills)
    chartPriceDisplay: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: 8,
    },
    chartDisplayPrice: {
        fontSize: 22,
        fontWeight: '700',
        color: c.textPrimary,
    },
    chartDisplayPromo: {
        fontSize: 22,
        fontWeight: '700',
        color: c.primary,
    },
    chartDisplayStrike: {
        fontSize: 14,
        color: c.textMuted,
        textDecorationLine: 'line-through',
    },
    chartDisplayDate: {
        fontSize: 12,
        color: c.textMuted,
    },

    // Bottom add-to-basket bar
    addBar: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: c.cardBackground,
        borderTopWidth: 0.5,
        borderTopColor: c.border,
        paddingHorizontal: 16,
        paddingTop: 10,
    },
    addButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: c.primary,
        borderRadius: 12,
        paddingVertical: 14,
    },
    addButtonDone: {
        opacity: 0.75,
    },
    addButtonText: {
        fontSize: 15,
        fontWeight: '700',
        color: '#fff',
    },
});