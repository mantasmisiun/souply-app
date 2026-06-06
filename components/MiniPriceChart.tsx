import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Line, Circle, Polygon, Text as SvgText } from 'react-native-svg';
import { useTheme, type AppTheme } from '../constants/theme';

export interface PricePoint {
    price: number;
    promoPrice: number | null;
    date: string;
    storeName?: string;
    isFallback: number;
}

export type RangeKey = '1M' | '3M' | '6M' | 'all';

export function preparePriceData(prices: PricePoint[], maxPoints?: number): PricePoint[] {
    if (!prices.length) return [];
    const nonFallback = prices.filter(p => !p.isFallback);
    const base = nonFallback.length > 0 ? nonFallback : prices;
    const sorted = [...base].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    if (maxPoints && sorted.length > maxPoints) return sorted.slice(-maxPoints);
    return sorted;
}

export function filterByRange(data: PricePoint[], key: RangeKey): PricePoint[] {
    if (key === 'all') return data;
    const months = key === '1M' ? 1 : key === '3M' ? 3 : 6;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    return data.filter(p => new Date(p.date) >= cutoff);
}

const MODAL_CHART_PADDING = { top: 14, bottom: 18, left: 46, right: 10 };
const MINI_CHART_PAD = { top: 8, bottom: 8, left: 8, right: 8 };
const MINI_TAIL = 18;
const SCALE_PAD_RATIO = 0.12;

const MINI_CHART_WIDTH = 140;
const MINI_CHART_HEIGHT = 64;
const MINI_CHART_MAX_POINTS = 6;

export function PriceChartSvg({
    data,
    width,
    height,
    colors,
    activePtIndex = null,
    isModal = false,
    shortDate,
    formatEuro,
}: {
    data: PricePoint[];
    width: number;
    height: number;
    colors: AppTheme;
    activePtIndex?: number | null;
    isModal?: boolean;
    shortDate?: (d: string) => string;
    formatEuro?: (v: number) => string;
}) {
    if (!data.length) return null;

    const padding = isModal ? MODAL_CHART_PADDING : MINI_CHART_PAD;
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const allPriceValues: number[] = [];
    for (const d of data) {
        if (d.price !== null && d.price !== undefined) allPriceValues.push(Number(d.price));
        if (d.promoPrice !== null && d.promoPrice !== undefined) allPriceValues.push(Number(d.promoPrice));
    }
    const minPrice = Math.min(...allPriceValues);
    const maxPrice = Math.max(...allPriceValues);
    const range = maxPrice - minPrice;

    // Mini chart baselines at 0 so a small dip reads small against the full
    // price (overall perspective of the discount); the modal keeps its zoomed
    // auto-scale to show fine variation.
    const zeroBased = !isModal;
    let lo: number;
    let hi: number;
    if (zeroBased) {
        lo = 0;
        hi = maxPrice > 0 ? maxPrice * 1.12 : 1;
    } else if (range === 0) {
        lo = minPrice - 0.5;
        hi = minPrice + 0.5;
    } else {
        lo = minPrice - range * SCALE_PAD_RATIO;
        hi = maxPrice + range * SCALE_PAD_RATIO;
    }
    const span = hi - lo || 1;
    const ypos = (v: number) => padding.top + chartH - ((v - lo) / span) * chartH;

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

    const hasAnyPromo = points.some(p => p.promoY !== null);
    const topEdge = points.map(p => `${p.x},${p.priceY}`);
    const bottomFwd: string[] = [];
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const prev = i > 0 ? points[i - 1] : null;
        if (p.promoY !== null) {
            if (prev === null || prev.promoY === null)
                bottomFwd.push(`${p.x},${p.priceY}`);
            bottomFwd.push(`${p.x},${p.promoY}`);
        } else {
            if (prev !== null && prev.promoY !== null)
                bottomFwd.push(`${p.x},${prev.promoY}`);
            bottomFwd.push(`${p.x},${p.priceY}`);
        }
    }
    const fillPolygonPoints = [...topEdge, ...bottomFwd.reverse()].join(' ');

    const last = points[points.length - 1];
    const lastIdx = points.length - 1;

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
            {isModal && hasAnyPromo && (
                <Polygon points={fillPolygonPoints} fill={colors.primary} fillOpacity={0.18} stroke="none" />
            )}
            {isModal && points.length === 1 && points[0].promoY !== null && (
                <Line x1={points[0].x} y1={points[0].priceY} x2={points[0].x} y2={points[0].promoY!}
                    stroke={colors.primary} strokeOpacity={0.5} strokeWidth={1.5} />
            )}
            {!isModal && points.length === 1 && (
                <>
                    <Line x1={points[0].x} y1={points[0].priceY} x2={width - padding.right} y2={points[0].priceY}
                        stroke={colors.textSecondary} strokeWidth={1.5} />
                    {points[0].promoY !== null && (
                        <Line x1={points[0].x} y1={points[0].promoY} x2={width - padding.right} y2={points[0].promoY}
                            stroke={colors.primary} strokeWidth={1.5} />
                    )}
                </>
            )}
            {points.length > 1 && points.map((p, i) => {
                if (i === 0) return null;
                const prev = points[i - 1];
                return <Line key={`rl-${i}`} x1={prev.x} y1={prev.priceY} x2={p.x} y2={p.priceY}
                    stroke={colors.textSecondary} strokeWidth={1.5} />;
            })}
            {points.length > 1 && points.map((p, i) => {
                if (i === 0) return null;
                const prev = points[i - 1];
                if (prev.promoY === null || p.promoY === null) return null;
                return <Line key={`pl-${i}`} x1={prev.x} y1={prev.promoY} x2={p.x} y2={p.promoY}
                    stroke={colors.primary} strokeWidth={1.5} />;
            })}
            {!isModal && points.map((p, i) => {
                const prevHasPromo = i > 0 && points[i - 1].promoY !== null;
                const nextHasPromo = i < points.length - 1 && points[i + 1].promoY !== null;
                const isPromoStart = p.promoY !== null && !prevHasPromo;
                const isPromoEnd = p.promoY !== null && i < points.length - 1 && !nextHasPromo;
                const elems: React.ReactNode[] = [];
                if (isPromoStart) elems.push(
                    <Line key={`promo-open-${i}`} x1={p.x} y1={p.priceY} x2={p.x} y2={p.promoY!}
                        stroke={colors.primary} strokeWidth={1} strokeDasharray="2,2" strokeOpacity={0.65} />
                );
                if (isPromoEnd) {
                    const next = points[i + 1];
                    elems.push(
                        <Line key={`promo-ext-${i}`} x1={p.x} y1={p.promoY!} x2={next.x} y2={p.promoY!}
                            stroke={colors.primary} strokeWidth={1.5} strokeOpacity={0.7} />,
                        <Line key={`promo-close-${i}`} x1={next.x} y1={p.promoY!} x2={next.x} y2={next.priceY}
                            stroke={colors.primary} strokeWidth={1} strokeDasharray="2,2" strokeOpacity={0.65} />,
                    );
                }
                return elems.length > 0 ? <React.Fragment key={`promo-boundary-${i}`}>{elems}</React.Fragment> : null;
            })}
            {(isModal || points.length > 1) && (
                <>
                    <Line x1={last.x} y1={last.priceY} x2={width - padding.right} y2={last.priceY}
                        stroke={colors.textSecondary} strokeWidth={1.25} />
                    {last.promoY !== null && (
                        <Line x1={last.x} y1={last.promoY} x2={width - padding.right} y2={last.promoY}
                            stroke={colors.primary} strokeWidth={1.25} />
                    )}
                </>
            )}
            {isModal && range > 0 && formatEuro && (
                <>
                    <Line x1={padding.left} y1={ypos(maxPrice)} x2={width - padding.right} y2={ypos(maxPrice)}
                        stroke={colors.textMuted} strokeWidth={0.5} strokeDasharray="2,3" strokeOpacity={0.45} />
                    <SvgText x={padding.left - 4} y={ypos(maxPrice) + 3.5} fontSize={9} fill={colors.textMuted} textAnchor="end">
                        {formatEuro(maxPrice)}
                    </SvgText>
                    <Line x1={padding.left} y1={ypos(minPrice)} x2={width - padding.right} y2={ypos(minPrice)}
                        stroke={colors.textMuted} strokeWidth={0.5} strokeDasharray="2,3" strokeOpacity={0.45} />
                    <SvgText x={padding.left - 4} y={ypos(minPrice) + 3.5} fontSize={9} fill={colors.textMuted} textAnchor="end">
                        {formatEuro(minPrice)}
                    </SvgText>
                </>
            )}
            {isModal && points.map((p, i) => {
                const prevHasPromo = i > 0 && points[i - 1].promoY !== null;
                const nextHasPromo = i < points.length - 1 && points[i + 1].promoY !== null;
                const isPromoStart = p.promoY !== null && !prevHasPromo;
                const isPromoEnd = p.promoY !== null && i < points.length - 1 && !nextHasPromo;
                const elems: React.ReactNode[] = [];
                if (isPromoStart) elems.push(
                    <Line key={`promo-open-${i}`} x1={p.x} y1={p.priceY} x2={p.x} y2={p.promoY!}
                        stroke={colors.primary} strokeWidth={1} strokeDasharray="2,2" strokeOpacity={0.65} />
                );
                if (isPromoEnd) {
                    const next = points[i + 1];
                    elems.push(
                        <Line key={`promo-ext-${i}`} x1={p.x} y1={p.promoY!} x2={next.x} y2={p.promoY!}
                            stroke={colors.primary} strokeWidth={1.5} strokeOpacity={0.7} />,
                        <Line key={`promo-close-${i}`} x1={next.x} y1={p.promoY!} x2={next.x} y2={next.priceY}
                            stroke={colors.primary} strokeWidth={1} strokeDasharray="2,2" strokeOpacity={0.65} />,
                    );
                }
                return elems.length > 0 ? <React.Fragment key={`promo-boundary-${i}`}>{elems}</React.Fragment> : null;
            })}
            {isModal && (
                <>
                    {points.map((p, i) => {
                        if (activePtIndex !== null && i === activePtIndex) return null;
                        if (i === lastIdx && activePtIndex === null) return (
                            <React.Fragment key={`dot-r-${i}`}>
                                <Circle cx={p.x} cy={p.priceY} r={5} fill="transparent" stroke={colors.textSecondary} strokeWidth={1.5} strokeOpacity={0.4} />
                                <Circle cx={p.x} cy={p.priceY} r={3} fill={colors.textSecondary} />
                            </React.Fragment>
                        );
                        return <Circle key={`dot-r-${i}`} cx={p.x} cy={p.priceY} r={2.5} fill={colors.textSecondary} />;
                    })}
                    {points.map((p, i) => {
                        if (p.promoY === null) return null;
                        if (activePtIndex !== null && i === activePtIndex) return null;
                        if (i === lastIdx && activePtIndex === null) return (
                            <React.Fragment key={`dot-p-${i}`}>
                                <Circle cx={p.x} cy={p.promoY} r={5} fill="transparent" stroke={colors.primary} strokeWidth={1.5} strokeOpacity={0.4} />
                                <Circle cx={p.x} cy={p.promoY} r={3} fill={colors.primary} />
                            </React.Fragment>
                        );
                        return <Circle key={`dot-p-${i}`} cx={p.x} cy={p.promoY} r={2.5} fill={colors.primary} />;
                    })}
                    {activePtIndex !== null && (
                        <>
                            <Line x1={points[activePtIndex].x} y1={padding.top} x2={points[activePtIndex].x} y2={height - padding.bottom}
                                stroke={colors.textSecondary} strokeWidth={1} strokeDasharray="3,3" strokeOpacity={0.5} />
                            <Circle cx={points[activePtIndex].x} cy={points[activePtIndex].priceY} r={4} fill={colors.textSecondary} />
                            {points[activePtIndex].promoY !== null && (
                                <Circle cx={points[activePtIndex].x} cy={points[activePtIndex].promoY!} r={4} fill={colors.primary} />
                            )}
                        </>
                    )}
                </>
            )}
            {isModal && shortDate && modalTickIndices.map((idx, tickPos) => {
                const p = points[idx];
                const isFirst = tickPos === 0;
                const isLast = tickPos === modalTickIndices.length - 1;
                const anchor = isFirst ? 'start' : isLast ? 'end' : 'middle';
                return (
                    <SvgText key={`date-${idx}`} x={p.x} y={height - 3} fontSize={9}
                        fill={colors.textMuted} textAnchor={anchor}>
                        {shortDate(p.date)}
                    </SvgText>
                );
            })}
        </Svg>
    );
}

interface MiniPriceChartProps {
    prices: PricePoint[];
    onTap?: () => void;
    width?: number;
    height?: number;
}

export default function MiniPriceChart({ prices, onTap, width = MINI_CHART_WIDTH, height = MINI_CHART_HEIGHT }: MiniPriceChartProps) {
    const colors = useTheme();

    const allData = preparePriceData(prices);
    const recentData = filterByRange(allData, '3M');
    const data = (recentData.length > 0 ? recentData : allData).slice(-MINI_CHART_MAX_POINTS);

    if (!data.length) {
        return (
            <View style={[styles.empty, { width, height }]}>
                <Ionicons name="analytics-outline" size={20} color={colors.border} />
            </View>
        );
    }

    return (
        <TouchableOpacity style={[styles.container, { width, height }]} activeOpacity={0.7} onPress={onTap} disabled={!onTap}>
            <PriceChartSvg data={data} width={width} height={height} colors={colors} />
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    container: { overflow: 'hidden' },
    empty: { alignItems: 'center', justifyContent: 'center' },
});
