import React, { useEffect, useState } from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import Svg, { Line, Path as SvgPath } from 'react-native-svg';
import { formatEuro } from '../utils/formatCurrency';
import { useTheme, useResolvedScheme } from '../constants/theme';

export interface BarSlice {
    label: string;
    total: number;
    month?: string; // "YYYY-MM" — used to detect and highlight the current month
}

interface Props {
    data: BarSlice[];
    color: string;
    height?: number;
}

const PAGE_SIZE = 6;
const BAR_GAP = 12;
const MAX_BAR_WIDTH = 56; // cap so bars don't grow absurdly wide on tablets
const CALLOUT_H = 22;     // vertical room above bars for value labels
const CORNER_R = 5;
const GRID_FRACTIONS = [0.25, 0.5, 0.75, 1.0];

function roundedTopPath(x: number, barTop: number, barBottom: number, w: number): string {
    const h = barBottom - barTop;
    if (h <= 0) return '';
    const r = Math.min(CORNER_R, h / 2);
    return [
        `M ${x},${barBottom}`,
        `L ${x},${barTop + r}`,
        `Q ${x},${barTop} ${x + r},${barTop}`,
        `L ${x + w - r},${barTop}`,
        `Q ${x + w},${barTop} ${x + w},${barTop + r}`,
        `L ${x + w},${barBottom}`,
        'Z',
    ].join(' ');
}

export function BarChart({ data, color, height = 140 }: Props) {
    const themeColors = useTheme();
    const scheme = useResolvedScheme();
    // Non-current bars at 65% on a dark background mix to a muddy pink;
    // bump opacity in dark mode so the tinted bars stay readable.
    const inactiveBarOpacity = scheme === 'dark' ? 0.85 : 0.65;
    const [windowStart, setWindowStart] = useState(() => Math.max(0, data.length - PAGE_SIZE));
    const [containerWidth, setContainerWidth] = useState(0);

    useEffect(() => {
        setWindowStart(Math.max(0, data.length - PAGE_SIZE));
    }, [data.length]);

    const currentMonth = new Date().toISOString().slice(0, 7);
    const hasNav = data.length > PAGE_SIZE;
    const canBack = windowStart > 0;
    const canForward = windowStart + PAGE_SIZE < data.length;

    const visible = data.slice(windowStart, windowStart + PAGE_SIZE);
    const max = Math.max(...visible.map(d => d.total), 0.01);

    // Fill the measured container width; cap individual bar width for aesthetics
    const barWidth = containerWidth > 0
        ? Math.min(MAX_BAR_WIDTH, Math.floor((containerWidth + BAR_GAP) / PAGE_SIZE - BAR_GAP))
        : 30;
    const totalWidth = PAGE_SIZE * (barWidth + BAR_GAP) - BAR_GAP;

    // Self-size to the `height` prop; the carousel measures the resulting
    // container height and animates the card to match it.
    const effectiveBarHeight = height;

    const svgHeight = CALLOUT_H + effectiveBarHeight;
    const barBottom = CALLOUT_H + effectiveBarHeight;

    return (
        <View
            style={styles.container}
            onLayout={e => {
                setContainerWidth(e.nativeEvent.layout.width);
            }}
        >
            {hasNav && (
                <View style={styles.navRow}>
                    <TouchableOpacity
                        onPress={() => setWindowStart(w => Math.max(0, w - 1))}
                        disabled={!canBack}
                        style={styles.navBtn}
                        hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
                    >
                        <Text style={[styles.navArrow, { color: themeColors.textSecondary }, !canBack && styles.navArrowDisabled]}>‹</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        onPress={() => setWindowStart(w => Math.min(data.length - PAGE_SIZE, w + 1))}
                        disabled={!canForward}
                        style={styles.navBtn}
                        hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
                    >
                        <Text style={[styles.navArrow, { color: themeColors.textSecondary }, !canForward && styles.navArrowDisabled]}>›</Text>
                    </TouchableOpacity>
                </View>
            )}

            {containerWidth > 0 && (
                <>
                    {/* SVG: grid lines + bars only — no SVG text (font metrics vary by platform) */}
                    <View style={{ width: totalWidth, height: svgHeight }}>
                        <Svg width={totalWidth} height={svgHeight}>
                            {GRID_FRACTIONS.map(f => {
                                const y = CALLOUT_H + effectiveBarHeight * (1 - f);
                                return (
                                    <Line
                                        key={f}
                                        x1={0} y1={y} x2={totalWidth} y2={y}
                                        stroke={themeColors.borderSubtle}
                                        strokeWidth={1}
                                    />
                                );
                            })}
                            {visible.map((bar, i) => {
                                const barH = Math.max((bar.total / max) * effectiveBarHeight * 0.9, bar.total > 0 ? 6 : 0);
                                const barTop = barBottom - barH;
                                const x = i * (barWidth + BAR_GAP);
                                const path = roundedTopPath(x, barTop, barBottom, barWidth);
                                if (!path) return null;
                                const isCurrent = bar.month === currentMonth;
                                return (
                                    <SvgPath
                                        key={i}
                                        d={path}
                                        fill={color}
                                        opacity={isCurrent ? 1 : inactiveBarOpacity}
                                    />
                                );
                            })}
                        </Svg>

                        {/* RN Text overlay for value labels — correct € kerning on all platforms */}
                        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                            {visible.map((bar, i) => {
                                if (!bar.total) return null;
                                const isCurrent = bar.month === currentMonth;
                                const barH = Math.max((bar.total / max) * effectiveBarHeight * 0.9, 6);
                                const barTop = barBottom - barH;
                                const x = i * (barWidth + BAR_GAP);
                                const fontSize = isCurrent ? 11 : 9;
                                return (
                                    <Text
                                        key={i}
                                        numberOfLines={1}
                                        style={{
                                            position: 'absolute',
                                            left: x,
                                            width: barWidth,
                                            top: barTop - fontSize - 6,
                                            fontSize,
                                            fontWeight: isCurrent ? '600' : '400',
                                            color: isCurrent ? color : themeColors.textSecondary,
                                            textAlign: 'center',
                                        }}
                                    >
                                        {formatEuro(bar.total)}
                                    </Text>
                                );
                            })}
                        </View>
                    </View>

                    {/* Month labels */}
                    <View style={[styles.labels, { width: totalWidth }]}>
                        {visible.map((bar, i) => {
                            const isCurrent = bar.month === currentMonth;
                            return (
                                <Text
                                    key={i}
                                    style={[
                                        styles.label,
                                        { color: themeColors.textMuted, width: barWidth + BAR_GAP },
                                        isCurrent && { color, fontWeight: '700' },
                                    ]}
                                >
                                    {bar.label}
                                </Text>
                            );
                        })}
                    </View>
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { alignSelf: 'stretch' },
    navRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: 4,
        marginBottom: 4,
    },
    navBtn: { padding: 4 },
    navArrow: { fontSize: 22, fontWeight: '500' },
    navArrowDisabled: { opacity: 0.3 },
    labels: { flexDirection: 'row', marginTop: 6, alignSelf: 'center' },
    label: { fontSize: 11, textAlign: 'center' },
});
