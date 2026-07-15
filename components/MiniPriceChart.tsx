import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Line, Circle, Polygon, Text as SvgText } from 'react-native-svg';
import { useTheme, type AppTheme } from '../constants/theme';

export interface PricePoint {
    price: number;
    promoPrice: number | null;
    /** Promo expiry (ISO). Null/absent = treated as still active (receipt-observed promos). */
    promoEnd?: string | null;
    /** Synthetic carry-in point (month view): drawn, but never date-labelled. */
    virtual?: boolean;
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
const SCALE_PAD_RATIO = 0.12;

/**
 * TIME-scaled x axis, domain [first point date, NOW]. The chart is aware of the
 * current date: points sit at their true positions in elapsed time, so stale data
 * drifts left and the gap between the last scrape and today is real, visible
 * space — the regular price extends across it, and an expired promo can end at
 * its actual promoEnd date. Exported so the chart modals' touch hit-testing uses
 * the exact same positions the SVG draws.
 */
export function timeXPositions(
    data: { date: string }[],
    chartW: number,
    padLeft: number,
    domain?: { start: number; end: number },
): number[] {
    const end = domain?.end ?? Date.now();
    const times = data.map(d => new Date(d.date).getTime());
    const start = domain?.start ?? (times.length ? Math.min(times[0], end) : end);
    const tSpan = Math.max(end - start, 60_000); // guard: single just-scraped point
    return times.map(t => padLeft + ((Math.min(Math.max(t, start), end) - start) / tSpan) * chartW);
}

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
    window: win,
    yMax,
    pointDateLabels = false,
}: {
    data: PricePoint[];
    width: number;
    height: number;
    colors: AppTheme;
    activePtIndex?: number | null;
    isModal?: boolean;
    shortDate?: (d: string) => string;
    formatEuro?: (v: number) => string;
    /** MONTH view: fixed time domain [start, end] (end pre-clamped to now). */
    window?: { start: number; end: number };
    /** Fixed y-scale top (all-time max) — bottom pins to 0. */
    yMax?: number;
    /** Label every real point with its (rotated) date under the axis. */
    pointDateLabels?: boolean;
}) {
    if (!data.length) return null;

    const padding = isModal ? (pointDateLabels ? { top: 14, bottom: 34, left: 0, right: 0 } : MODAL_CHART_PADDING) : MINI_CHART_PAD;
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
    if (yMax != null && yMax > 0) {
        // Month view: identical scale on every month — top is the all-time max,
        // bottom is 0 — so navigating months compares like-for-like.
        lo = 0;
        hi = yMax * 1.05;
    } else if (zeroBased) {
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

    const xs = timeXPositions(data, chartW, padding.left, win);
    const points = data.map((d, i) => {
        const priceY = ypos(Number(d.price));
        const promoY = d.promoPrice !== null && d.promoPrice !== undefined
            ? ypos(Number(d.promoPrice))
            : null;
        return { x: xs[i], priceY, promoY, date: d.date };
    });

    const hasAnyPromo = points.some(p => p.promoY !== null);
    const last = points[points.length - 1];
    const lastIdx = points.length - 1;
    const rightEdge = width - padding.right;

    // Date-aware promo expiry for the LAST point (bounded by the window's end in
    // month view): drives both the extension rendering and the fill's right border.
    const lastRaw = data[data.length - 1];
    const endBound = win?.end ?? Date.now();
    const lastPromoExpired = last.promoY !== null && lastRaw?.promoEnd != null &&
        new Date(lastRaw.promoEnd).getTime() < endBound;
    let promoDotX = last.x;
    if (lastPromoExpired && lastRaw?.promoEnd) {
        const endX = timeXPositions([...data, { date: lastRaw.promoEnd }], chartW, padding.left, win)[data.length];
        promoDotX = Math.max(last.x, Math.min(endX, rightEdge - 2.5));
    }

    // PROMO FILL — one polygon per promo RUN, spanning the run's full extent:
    // bordered by the regular line on top, the promo line on the bottom, the
    // dashed promo-start on the left and its END on the right — the dashed
    // boundary at the next point (row-driven end), the promoEnd dash (date-driven
    // end), or the chart's right edge while the promo is ongoing.
    const promoFills: string[] = [];
    let runStart: number | null = null;
    for (let i = 0; i <= points.length; i++) {
        const inRun = i < points.length && points[i].promoY !== null;
        if (inRun && runStart === null) runStart = i;
        if (!inRun && runStart !== null) {
            const runEnd = i - 1;
            const isLastRun = runEnd === lastIdx;
            const xEnd = !isLastRun
                ? points[runEnd + 1].x
                : lastPromoExpired ? promoDotX : rightEdge;
            const topYEnd = !isLastRun ? points[runEnd + 1].priceY : points[runEnd].priceY;
            const top: string[] = [];
            for (let k = runStart; k <= runEnd; k++) top.push(`${points[k].x},${points[k].priceY}`);
            top.push(`${xEnd},${topYEnd}`);
            const bottom: string[] = [`${xEnd},${points[runEnd].promoY}`];
            for (let k = runEnd; k >= runStart; k--) bottom.push(`${points[k].x},${points[k].promoY}`);
            promoFills.push([...top, ...bottom].join(' '));
            runStart = null;
        }
    }

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
            {isModal && hasAnyPromo && promoFills.map((pts, i) => (
                <Polygon key={`pfill-${i}`} points={pts} fill={colors.primary} fillOpacity={0.18} stroke="none" />
            ))}
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
            {(isModal || points.length > 1) && (() => {
                const promoExpired = lastPromoExpired;
                const dotX = promoDotX;
                const promoLive = last.promoY !== null && !promoExpired;
                return (
                    <>
                        <Line x1={last.x} y1={last.priceY} x2={rightEdge} y2={last.priceY}
                            stroke={colors.textSecondary} strokeWidth={1.25} />
                        {promoLive && (
                            <Line x1={last.x} y1={last.promoY!} x2={rightEdge} y2={last.promoY!}
                                stroke={colors.primary} strokeWidth={1.25} />
                        )}
                        {last.promoY !== null && promoExpired && (
                            <>
                                {dotX > last.x && (
                                    <Line x1={last.x} y1={last.promoY} x2={dotX} y2={last.promoY}
                                        stroke={colors.primary} strokeWidth={1.25} />
                                )}
                                <Circle cx={dotX} cy={last.promoY} r={2.5} fill={colors.primary} />
                                <Line x1={dotX} y1={last.promoY} x2={dotX} y2={last.priceY}
                                    stroke={colors.primary} strokeWidth={1} strokeDasharray="2,2" strokeOpacity={0.65} />
                                {pointDateLabels && lastRaw?.promoEnd != null && shortDate && (
                                    // The promo's END is a real event on the axis: continue the
                                    // dashed line down to the baseline and date-label it like a
                                    // data point.
                                    <>
                                        <Line x1={dotX} y1={Math.max(last.priceY, last.promoY)} x2={dotX} y2={height - padding.bottom}
                                            stroke={colors.primary} strokeWidth={0.8} strokeDasharray="2,2" strokeOpacity={0.5} />
                                        <SvgText x={dotX} y={height - padding.bottom + 12} fontSize={8.5}
                                            fill={colors.primary} textAnchor="end"
                                            transform={`rotate(-45, ${dotX}, ${height - padding.bottom + 12})`}>
                                            {shortDate(lastRaw.promoEnd)}
                                        </SvgText>
                                    </>
                                )}
                            </>
                        )}
                    </>
                );
            })()}
            {isModal && !pointDateLabels && range > 0 && formatEuro && (
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
                        if (i === lastIdx && activePtIndex === null && !pointDateLabels) return (
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
                        if (i === lastIdx && activePtIndex === null && !pointDateLabels) return (
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
            {isModal && shortDate && !pointDateLabels && modalTickIndices.map((idx, tickPos) => {
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
            {pointDateLabels && (
                // Muted baseline marking ZERO — the month view's y-scale bottoms at 0,
                // and the axis line makes that edge legible.
                <Line x1={padding.left} y1={height - padding.bottom} x2={rightEdge} y2={height - padding.bottom}
                    stroke={colors.textMuted} strokeWidth={0.75} strokeOpacity={0.5} />
            )}
            {isModal && shortDate && pointDateLabels && points.map((p, i) => {
                // MONTH view: every real point carries its date, rotated 45° so a burst
                // of scrapes within a few days doesn't overlap. Carry-in points are
                // synthetic (virtual) and stay unlabelled.
                if (data[i]?.virtual) return null;
                const lx = p.x;
                const ly = height - padding.bottom + 12;
                // Drop-line from the point down to its date — EVERY price point gets one,
                // discount or not. Starts at the LOWER of the pair (promo sits below).
                const fromY = Math.max(p.priceY, p.promoY ?? p.priceY);
                return (
                    <React.Fragment key={`pdate-${i}`}>
                        <Line x1={lx} y1={fromY} x2={lx} y2={height - padding.bottom}
                            stroke={colors.textMuted} strokeWidth={0.8} strokeDasharray="2,2" strokeOpacity={0.6} />
                        <SvgText x={lx} y={ly} fontSize={8.5}
                            fill={colors.textMuted} textAnchor="end"
                            transform={`rotate(-45, ${lx}, ${ly})`}>
                            {shortDate(p.date)}
                        </SvgText>
                    </React.Fragment>
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
    // Quick-glance window: the mini chart shows only the LAST MONTH of movement.
    // With no in-window points, the latest known price still renders — as a single
    // (possibly old) point whose flat extension to today reads "stable since then";
    // the full history lives in the expanded modal.
    const recentData = filterByRange(allData, '1M');
    const raw = (recentData.length > 0 ? recentData : allData.slice(-1)).slice(-MINI_CHART_MAX_POINTS);
    // A LONE point renders as flat lines to today ("still valid") — which is only true
    // for the REGULAR price. Its promo, if date-expired, is dead and must not paint a
    // discount across the window (čiobreliai: the May 1,60 flat-lined through July).
    // Multi-point windows keep expired promos: the >1-point path ends them honestly
    // with the dot at promoEnd.
    const data = raw.map((pt, i) =>
        raw.length === 1 && i === 0 && pt.promoPrice != null &&
        pt.promoEnd != null && new Date(pt.promoEnd).getTime() < Date.now()
            ? { ...pt, promoPrice: null, promoEnd: null }
            : pt,
    );

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
