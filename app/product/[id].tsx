import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Image, TextInput, Modal, Dimensions } from 'react-native';
import { SkeletonBox } from '../../components/SkeletonBox';
import { ProductImage } from '../../components/ProductImage';
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../config/api';
import Svg, { Line, Circle, Polygon, Text as SvgText } from 'react-native-svg';
import { useTheme, type AppTheme } from '../../constants/theme';
import { useDisplayMode } from '../../contexts/DisplayPreferenceContext';
import { useTranslation } from 'react-i18next';
import { formatDate, formatEuro } from '../../utils/formatCurrency';

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

interface Store {
    id: number;
    chainId: number;
    name: string;
    address: string;
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
}

interface Category {
    id: number;
    name: string;
    parentCategoryId: number | null;
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
/** Right-padding reserved for an externally-drawn price label that sits
 *  to the right of the dashed extension line. Both the mini chart and the
 *  modal chart overlay a React Native Text at the last-point Y using this
 *  reserved space. */
const CHART_LABEL_MARGIN = 48;

function computeChartPadding(reserveLabelSpace: boolean) {
    return {
        top: 10,
        bottom: 18,
        left: 10,
        right: reserveLabelSpace ? CHART_LABEL_MARGIN : 10,
    };
}

/**
 * Mirror the Y-axis math from PriceChartSvg so callers can overlay native
 * text labels at the precise Y of the last data point's regular and promo
 * prices. We can't rely on react-native-svg's SvgText for this — text-
 * anchor + strikethrough combined with the 48-px label margin hit platform
 * clipping/rendering quirks. RN Text anchored to `right` + fixed top in
 * an absolutely-positioned overlay is rock-solid by comparison.
 */
const SCALE_PAD_RATIO = 0.12;

function computeLastPointYs(
    data: PricePoint[],
    height: number,
    reserveLabelSpace: boolean
): { priceY: number; promoY: number | null } | null {
    if (!data.length) return null;
    const padding = computeChartPadding(reserveLabelSpace);
    const chartH = height - padding.top - padding.bottom;
    const allPriceValues: number[] = [];
    for (const d of data) {
        if (d.price !== null && d.price !== undefined) allPriceValues.push(Number(d.price));
        if (d.promoPrice !== null && d.promoPrice !== undefined) allPriceValues.push(Number(d.promoPrice));
    }
    const minPrice = Math.min(...allPriceValues);
    const maxPrice = Math.max(...allPriceValues);
    const range = maxPrice - minPrice;
    const paddedMin = range === 0 ? minPrice : minPrice - range * SCALE_PAD_RATIO;
    const paddedRange = range === 0 ? 1 : range * (1 + 2 * SCALE_PAD_RATIO);
    const ypos = (v: number) =>
        range === 0
            ? padding.top + chartH / 2
            : padding.top + chartH - ((v - paddedMin) / paddedRange) * chartH;
    const last = data[data.length - 1];
    return {
        priceY: ypos(Number(last.price)),
        promoY:
            last.promoPrice !== null && last.promoPrice !== undefined
                ? ypos(Number(last.promoPrice))
                : null,
    };
}

function PriceChartSvg({
    data,
    width,
    height,
    colors,
    reserveLabelSpace = false,
    activePtIndex = null,
    isModal = false,
}: {
    data: PricePoint[];
    width: number;
    height: number;
    colors: AppTheme;
    /** Reserve horizontal padding on the right so the caller can overlay a
     *  price label aligned with the dashed extension line. Affects layout
     *  math only; no label is drawn inside the SVG. */
    reserveLabelSpace?: boolean;
    activePtIndex?: number | null;
    isModal?: boolean;
}) {
    if (!data.length) return null;

    const padding = computeChartPadding(isModal ? false : reserveLabelSpace);
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
        const x = data.length === 1
            ? padding.left + chartW / 2
            : padding.left + (i / (data.length - 1)) * chartW;
        const priceY = ypos(Number(d.price));
        const promoY = d.promoPrice !== null && d.promoPrice !== undefined
            ? ypos(Number(d.promoPrice))
            : null;
        return { x, priceY, promoY, date: d.date };
    });

    // Closed polygon between the two series. Top edge: regular price line.
    // Bottom edge (reversed): promoY where defined, priceY where not —
    // so the fill collapses to zero-height at points without promo,
    // "tapering" into neighbors without a discount.
    const hasAnyPromo = points.some(p => p.promoY !== null);
    const topEdge = points.map(p => `${p.x},${p.priceY}`);
    const bottomEdge = [...points]
        .reverse()
        .map(p => `${p.x},${p.promoY ?? p.priceY}`);
    const fillPolygonPoints = [...topEdge, ...bottomEdge].join(' ');

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

    // Modal-specific: min promo reference line
    const promoPrices = data
        .filter(d => d.promoPrice !== null && d.promoPrice !== undefined)
        .map(d => Number(d.promoPrice));
    const minPromoPrice = promoPrices.length > 0 ? Math.min(...promoPrices) : null;

    return (
        <Svg width={width} height={height}>
            {/* Discount fill — only render if at least one point has promo */}
            {hasAnyPromo && (
                <Polygon
                    points={fillPolygonPoints}
                    fill={colors.primary}
                    fillOpacity={0.18}
                    stroke="none"
                />
            )}

            {/* Single-point dual-price vertical connector (degenerate fill) */}
            {points.length === 1 && points[0].promoY !== null && (
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

            {/* Promo line — only drawn between consecutive points that BOTH
                have a promoPrice. Where promo is missing on either side,
                the line effectively terminates into the fill polygon's
                tapering edge. */}
            {points.length > 1 &&
                points.map((p, i) => {
                    if (i === 0) return null;
                    const prev = points[i - 1];
                    if (prev.promoY === null || p.promoY === null) return null;
                    return (
                        <Line
                            key={`pl-${i}`}
                            x1={prev.x}
                            y1={prev.promoY}
                            x2={p.x}
                            y2={p.promoY}
                            stroke={colors.primary}
                            strokeWidth={1.5}
                        />
                    );
                })}

            {/* Dashed extensions from last point to the right edge */}
            <Line
                x1={last.x}
                y1={last.priceY}
                x2={width - padding.right}
                y2={last.priceY}
                stroke={colors.textSecondary}
                strokeWidth={1.25}
                strokeDasharray="3,2"
            />
            {last.promoY !== null && (
                <Line
                    x1={last.x}
                    y1={last.promoY}
                    x2={width - padding.right}
                    y2={last.promoY}
                    stroke={colors.primary}
                    strokeWidth={1.25}
                    strokeDasharray="3,2"
                />
            )}

            {/* Modal: min promo reference line */}
            {isModal && minPromoPrice !== null && (
                <>
                    <Line
                        x1={padding.left}
                        y1={ypos(minPromoPrice)}
                        x2={width - padding.right}
                        y2={ypos(minPromoPrice)}
                        stroke={colors.primary}
                        strokeWidth={0.75}
                        strokeDasharray="3,3"
                        strokeOpacity={0.5}
                    />
                    <SvgText
                        x={padding.left + 3}
                        y={ypos(minPromoPrice) - 3}
                        fontSize={8}
                        fill={colors.primary}
                        fillOpacity={0.7}
                    >
                        Min
                    </SvgText>
                </>
            )}

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
            ) : (
                <>
                    {/* Mini chart dots — simple r=2.5 for all */}
                    {points.map((p, i) => (
                        <Circle
                            key={`dot-r-${i}`}
                            cx={p.x}
                            cy={p.priceY}
                            r={2.5}
                            fill={colors.textSecondary}
                        />
                    ))}
                    {points.map((p, i) =>
                        p.promoY !== null ? (
                            <Circle
                                key={`dot-p-${i}`}
                                cx={p.x}
                                cy={p.promoY}
                                r={2.5}
                                fill={colors.primary}
                            />
                        ) : null
                    )}
                </>
            )}

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
            ) : (
                // Mini chart: single last-date label
                <SvgText
                    x={last.x}
                    y={height - 3}
                    fontSize={9}
                    fill={colors.textMuted}
                    textAnchor="middle"
                >
                    {shortDate(last.date)}
                </SvgText>
            )}
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
    const data = preparePriceData(prices, MINI_CHART_MAX_POINTS);

    if (!data.length) {
        return (
            <View style={styles.chartEmpty}>
                <Ionicons name="analytics-outline" size={20} color={colors.border} />
            </View>
        );
    }

    const ys = computeLastPointYs(data, MINI_CHART_HEIGHT, true)!;
    const lastRow = data[data.length - 1];
    const rawPrice = Number(lastRow.price);
    const rawPromo =
        lastRow.promoPrice !== null && lastRow.promoPrice !== undefined
            ? Number(lastRow.promoPrice)
            : null;
    const lastPriceY = ys.priceY;
    const lastPromoY = ys.promoY;

    // Approximate line-height for the RN Text label (fontSize 11 × ~1.35).
    // Used to shift the top so the text baseline sits roughly at lastPriceY.
    const LABEL_LINE = 15;

    return (
        <TouchableOpacity
            style={styles.chartContainer}
            activeOpacity={0.7}
            onPress={onTap}
            disabled={!onTap}
        >
            <View style={{ width: MINI_CHART_WIDTH, height: MINI_CHART_HEIGHT, position: 'relative' }}>
                <PriceChartSvg
                    data={data}
                    width={MINI_CHART_WIDTH}
                    height={MINI_CHART_HEIGHT}
                    colors={colors}
                    reserveLabelSpace
                />
                {rawPromo !== null ? (
                    <>
                        <Text
                            style={[
                                styles.chartOverlayLabel,
                                {
                                    top: lastPriceY - LABEL_LINE / 2,
                                    color: colors.textMuted,
                                    textDecorationLine: 'line-through',
                                },
                            ]}
                        >
                            {formatEuro(rawPrice)}
                        </Text>
                        <Text
                            style={[
                                styles.chartOverlayLabel,
                                {
                                    top: (lastPromoY ?? lastPriceY) - LABEL_LINE / 2,
                                    color: colors.textPrimary,
                                    fontWeight: '700',
                                },
                            ]}
                        >
                            {formatEuro(rawPromo)}
                        </Text>
                    </>
                ) : (
                    <Text
                        style={[
                            styles.chartOverlayLabel,
                            {
                                top: lastPriceY - LABEL_LINE / 2,
                                color: colors.textPrimary,
                                fontWeight: '600',
                            },
                        ]}
                    >
                        {formatEuro(rawPrice)}
                    </Text>
                )}
            </View>
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
    const padding = computeChartPadding(false);
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
    const [storeProducts, setStoreProducts] = useState<StoreProduct[]>([]);
    const [allChains, setAllChains] = useState<Chain[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedChainId, setSelectedChainId] = useState<number | null>(null);
    const [stores, setStores] = useState<Store[]>([]);
    const [selectedStoreId, setSelectedStoreId] = useState<number | null>(null);
    const [showStorePicker, setShowStorePicker] = useState(false);
    const [storeSearch, setStoreSearch] = useState('');
    const [priceCache, setPriceCache] = useState<{ [key: string]: PricePoint[] }>({});
    const [categories, setCategories] = useState<Category[]>([]);
    const [chartModalSp, setChartModalSp] = useState<StoreProduct | null>(null);
    const { mode, ready: prefReady } = useDisplayMode();

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
            return c ? [c] : [];
        });
    }, [allChains, storeProducts]);

    const filteredStoreProducts = useMemo(() => {
        if (!selectedChainId) return storeProducts;
        return storeProducts.filter(sp => sp.chainId === selectedChainId);
    }, [storeProducts, selectedChainId]);

    const hasProductsInChain = (chainId: number) => {
        return storeProducts.some(sp => sp.chainId === chainId);
    };

    const filteredStores = useMemo(() => {
        if (!storeSearch) return stores;
        const q = storeSearch.toLowerCase();
        return stores.filter(s => s.name.toLowerCase().includes(q) || s.address.toLowerCase().includes(q));
    }, [stores, storeSearch]);

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

                // Auto-select first chain that has products
                const firstChain = spData.find((sp: StoreProduct) => sp.chainId);
                if (firstChain) {
                    setSelectedChainId(firstChain.chainId);
                }

                // Fetch category breadcrumb
                if (prodData.categoryId) {
                    const catRes = await fetch(`${API_BASE_URL}/api/categories/${prodData.categoryId}`);
                    const catData = await catRes.json();
                    if (catData.parentCategoryId) {
                        const parentRes = await fetch(`${API_BASE_URL}/api/categories/${catData.parentCategoryId}`);
                        const parentData = await parentRes.json();
                        setCategories([parentData, catData]);
                    } else {
                        setCategories([catData]);
                    }
                }
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [id, mode, prefReady]);

    // Fetch stores when chain changes
    useEffect(() => {
        if (!selectedChainId) return;
        const fetchStores = async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/api/stores/chain/${selectedChainId}`);
                const data = await res.json();
                setStores(Array.isArray(data) ? data : []);
                setSelectedStoreId(null);
                setShowStorePicker(false);
            } catch {}
        };
        fetchStores();
    }, [selectedChainId]);

    // Fetch price history for visible store products
    useEffect(() => {
        const fetchPrices = async () => {
            for (const sp of filteredStoreProducts) {
                const cacheKey = selectedStoreId
                    ? `${sp.id}-${selectedStoreId}`
                    : `${sp.id}-all`;

                if (priceCache[cacheKey]) continue;

                try {
                    const url = selectedStoreId
                        ? `${API_BASE_URL}/api/prices/store-product/${sp.id}/store/${selectedStoreId}/history`
                        : `${API_BASE_URL}/api/prices/store-product/${sp.id}/history`;
                    const res = await fetch(url);
                    const data = await res.json();
                    setPriceCache(prev => ({ ...prev, [cacheKey]: Array.isArray(data) ? data : [] }));
                } catch {
                    setPriceCache(prev => ({ ...prev, [cacheKey]: [] }));
                }
            }
        };
        if (filteredStoreProducts.length > 0) fetchPrices();
    }, [filteredStoreProducts, selectedStoreId]);

    const getPricesForSp = (spId: number): PricePoint[] => {
        const cacheKey = selectedStoreId ? `${spId}-${selectedStoreId}` : `${spId}-all`;
        return priceCache[cacheKey] || [];
    };

    if (loading) return (
        <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, gap: 16 }}>
            <View style={{ alignItems: 'center', gap: 12, paddingVertical: 8 }}>
                <SkeletonBox width={160} height={160} borderRadius={12} />
                <SkeletonBox width={220} height={18} borderRadius={8} />
                <SkeletonBox width={140} height={13} borderRadius={6} />
            </View>
            <View style={{ backgroundColor: colors.cardBackground, borderRadius: 12, padding: 16, gap: 10 }}>
                <SkeletonBox width={120} height={13} borderRadius={6} />
                {Array.from({ length: 4 }).map((_, i) => (
                    <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <SkeletonBox width={32} height={32} borderRadius={16} />
                        <View style={{ flex: 1, gap: 6 }}>
                            <SkeletonBox width={140} height={12} borderRadius={5} />
                            <SkeletonBox width={80} height={11} borderRadius={5} />
                        </View>
                        <SkeletonBox width={60} height={16} borderRadius={5} />
                    </View>
                ))}
            </View>
        </ScrollView>
    );
    if (!product) return <Text style={styles.centered}>Produktas nerastas</Text>;

    const breadcrumb = categories.map(c => c.name).join(' → ');

    return (
        <>
            <Stack.Screen options={{
                title: product.name,
                headerBackTitle: 'Atgal',
                headerStyle: { backgroundColor: colors.cardBackground },
                headerShadowVisible: false,
            }} />
                <ScrollView style={styles.container} stickyHeaderIndices={[1]}>
                {/* Header */}
                <View style={styles.header}>
                    <View style={styles.headerImageContainer}>
                        <ProductImage
                            uris={product.imageUrls}
                            imageStyle={styles.headerImage}
                            placeholderStyle={styles.headerImagePlaceholder}
                            emojiStyle={styles.headerImageEmoji}
                        />
                    </View>
                    <Text style={styles.productName}>{product.name}</Text>
                    {breadcrumb ? <Text style={styles.breadcrumb}>{breadcrumb}</Text> : null}
                    {filteredStoreProducts.length > 0 && (
                        <Text style={styles.amountRange}>
                            {(() => {
                                const amounts = storeProducts.map(sp => parseFloat(sp.amount));
                                const units = storeProducts.map(sp => sp.unit);
                                const min = Math.min(...amounts);
                                const max = Math.max(...amounts);
                                const formatAmt = (val: number) => {
                                    const unit = units[0] || 'g';
                                    if (unit === 'g' && val >= 1000) return `${val / 1000} kg`;
                                    return `${val} ${unit}`;
                                };
                                return min === max ? formatAmt(min) : `${formatAmt(min)} – ${formatAmt(max)}`;
                            })()}
                        </Text>
                    )}
                </View>

                {/* Chain tabs */}
                <View style={styles.tabsWrapper}>
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.tabsContainer}
                    >
                        {chains.map(chain => {
                            const hasProducts = hasProductsInChain(chain.id);
                            const isSelected = selectedChainId === chain.id;
                            return (
                                <TouchableOpacity
                                    key={chain.id}
                                    style={[
                                        styles.chainTab,
                                        isSelected && styles.chainTabActive,
                                        !hasProducts && styles.chainTabDisabled,
                                    ]}
                                    onPress={() => {
                                        if (hasProducts) setSelectedChainId(chain.id);
                                    }}
                                    disabled={!hasProducts}
                                >
                                    <Image
                                        source={{ uri: chain.logoUrl }}
                                        style={[styles.chainLogo, !hasProducts && styles.chainLogoDisabled]}
                                        resizeMode="contain"
                                    />
                                    {!hasProducts && (
                                        <View style={styles.unavailableBadge}>
                                            <Text style={styles.unavailableText}>—</Text>
                                        </View>
                                    )}
                                </TouchableOpacity>
                            );
                        })}
                    </ScrollView>
                </View>

                {/* Store dropdown */}
                <View style={styles.dropdownSection}>
                    <TouchableOpacity
                        style={styles.dropdown}
                        onPress={() => setShowStorePicker(!showStorePicker)}
                    >
                        <Ionicons name="storefront-outline" size={18} color={colors.textPrimary} />
                        <Text style={styles.dropdownText} numberOfLines={1}>
                            {selectedStoreId
                                ? stores.find(s => s.id === selectedStoreId)?.name || t('product.fallbackStore')
                                : t('product.allStores')}
                        </Text>
                        <Ionicons name={showStorePicker ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textSecondary} />
                    </TouchableOpacity>

                    {showStorePicker && (
                        <View style={styles.storePickerContainer}>
                            <View style={styles.searchInputContainer}>
                                <Ionicons name="search" size={16} color={colors.textMuted} />
                                <TextInput
                                    style={styles.searchTextInput}
                                    placeholder={t('product.searchStorePlaceholder')}
                                    placeholderTextColor={colors.textMuted}
                                    value={storeSearch}
                                    onChangeText={setStoreSearch}
                                    autoFocus
                                />
                                {storeSearch.length > 0 && (
                                    <TouchableOpacity onPress={() => setStoreSearch('')}>
                                        <Ionicons name="close-circle" size={16} color={colors.textMuted} />
                                    </TouchableOpacity>
                                )}
                            </View>
                            <TouchableOpacity
                                style={[styles.storeOption, !selectedStoreId && styles.storeOptionActive]}
                                onPress={() => { setSelectedStoreId(null); setShowStorePicker(false); }}
                            >
                                <Text style={[styles.storeOptionText, !selectedStoreId && styles.storeOptionTextActive]}>
                                    {t('product.allStores')}
                                </Text>
                            </TouchableOpacity>
                            <ScrollView style={styles.storeList} nestedScrollEnabled={true}>
                                {filteredStores.map(item => (
                                    <TouchableOpacity
                                        key={item.id}
                                        style={[styles.storeOption, selectedStoreId === item.id && styles.storeOptionActive]}
                                        onPress={() => { setSelectedStoreId(item.id); setShowStorePicker(false); }}
                                    >
                                        <Text style={[styles.storeOptionText, selectedStoreId === item.id && styles.storeOptionTextActive]}>
                                            {item.name}
                                        </Text>
                                        <Text style={styles.storeAddress} numberOfLines={1}>{item.address}</Text>
                                    </TouchableOpacity>
                                ))}
                            </ScrollView>
                        </View>
                    )}
                </View>

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
                        const amountStr = sp.unit === 'g' && amt >= 1000
                            ? `${amt / 1000} kg`
                            : `${amt} ${sp.unit}`;

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
                                        <Text style={styles.spAmount}>{amountStr}</Text>
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
                            </View>
                        );
                    })
                )}
                <View style={{ height: 40 }} />
            </ScrollView>

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

    // Header
    header: {
        backgroundColor: c.cardBackground,
        alignItems: 'center',
        paddingVertical: 24,
        paddingHorizontal: 16,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
    },
    headerImageContainer: {
        width: 160,
        height: 160,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 16,
    },
    headerImage: { width: '100%', height: '100%' },
    productName: {
        fontSize: 20,
        fontWeight: '700',
        color: c.textPrimary,
        textAlign: 'center',
        marginBottom: 4,
    },
    breadcrumb: {
        fontSize: 12,
        color: c.textMuted,
        textAlign: 'center',
        marginBottom: 4,
    },
    amountRange: {
        fontSize: 14,
        color: c.textSecondary,
        marginTop: 4,
    },

    // Chain tabs
    tabsWrapper: {
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
        zIndex: 10,
    },
    tabsContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
    },
    chainTab: {
        width: 64,
        height: 44,
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: c.border,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.cardBackground,
        position: 'relative',
    },
    chainTabActive: {
        borderColor: c.primary,
        backgroundColor: c.primaryMuted,
    },
    chainTabDisabled: {
        opacity: 0.4,
        backgroundColor: c.surfaceSubtle,
    },
    chainLogo: {
        width: 48,
        height: 28,
    },
    chainLogoDisabled: {
        opacity: 0.5,
    },
    unavailableBadge: {
        position: 'absolute',
        top: -6,
        right: -6,
        backgroundColor: c.error,
        borderRadius: 8,
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    unavailableText: {
        color: c.textInverse,
        fontSize: 10,
        fontWeight: '700',
    },

    // Dropdown
    dropdownSection: {
        paddingHorizontal: 16,
        paddingTop: 12,
    },
    dropdown: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: c.cardBackground,
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 11,
        gap: 8,
        borderWidth: 1,
        borderColor: c.border,
    },
    dropdownText: {
        flex: 1,
        fontSize: 14,
        color: c.textPrimary,
    },
    storePickerContainer: {
        backgroundColor: c.cardBackground,
        borderRadius: 10,
        marginTop: 8,
        borderWidth: 1,
        borderColor: c.border,
        maxHeight: 260,
        overflow: 'hidden',
    },
    searchInputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 8,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
    },
    searchInput: { flex: 1 },
    searchPlaceholder: { fontSize: 13, color: c.textMuted },
    storeList: { maxHeight: 200 },
    storeOption: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderBottomWidth: 0.5,
        borderBottomColor: c.borderSubtle,
    },
    storeOptionActive: {
        backgroundColor: c.primaryMuted,
    },
    storeOptionText: {
        fontSize: 13,
        color: c.textPrimary,
    },
    storeOptionTextActive: {
        color: c.primary,
        fontWeight: '600',
    },
    storeAddress: {
        fontSize: 11,
        color: c.textMuted,
        marginTop: 2,
    },

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
    headerImagePlaceholder: {
        width: 120,
        height: 120,
        borderRadius: 12,
        backgroundColor: c.surfaceMuted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerImageEmoji: {
        fontSize: 56,
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
    // Overlay price label anchored to the right of the mini chart, at the
    // Y of the last data point. Uses native Text so strikethrough renders
    // reliably and text can't clip at the SVG edge like SvgText did.
    chartOverlayLabel: {
        position: 'absolute',
        right: 4,
        fontSize: 11,
        lineHeight: 15,
        minWidth: CHART_LABEL_MARGIN - 6,
        textAlign: 'right',
    },
    // Modal-scale version of the same overlay — larger font for the full
    // chart view. Same anchoring pattern.
    chartOverlayLabelLarge: {
        position: 'absolute',
        right: 6,
        fontSize: 14,
        lineHeight: 20,
        minWidth: CHART_LABEL_MARGIN - 6,
        textAlign: 'right',
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
    searchTextInput: {
        flex: 1,
        fontSize: 13,
        color: c.textPrimary,
        paddingVertical: 0,
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
});