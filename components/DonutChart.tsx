import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import Animated, {
    Easing,
    runOnJS,
    useAnimatedProps,
    useSharedValue,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { formatEuro } from '../utils/formatCurrency';
import { useTheme } from '../constants/theme';

const AnimatedPath = Animated.createAnimatedComponent(Path);

export interface DonutSlice {
    label: string;
    value: number;
    color: string;
    logoUri?: string | null;
    /** Background colour for the center logo tile when this slice is selected. */
    brandColor?: string;
}

interface Props {
    data: DonutSlice[];
    size?: number;
    thickness?: number;
    emptyColor?: string;
    selectedIndex?: number | null;
    onSelect?: (index: number | null) => void;
    cardBackground?: string;
    /**
     * Label shown under the center value when no slice is selected.
     * Defaults to t('donut.total') ("Iš viso"). Callers that show a
     * filtered subset (e.g. "Top 5") should override.
     */
    defaultCenterLabel?: string;
}

function polarToCartesian(cx: number, cy: number, r: number, deg: number) {
    'worklet';
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
    'worklet';
    const s = polarToCartesian(cx, cy, r, startDeg);
    const e = polarToCartesian(cx, cy, r, endDeg);
    const large = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

const GAP = 3;
// Extra SVG space on each side so the thicker selected arc (thickness+8 → +4px outward)
// never clips. Disc View stays at size×size as a sibling, not a parent of the SVG.
const OVERFLOW = 8;
const ANIM_DURATION = 320;

// Approximate height of the text block (centerValue lineHeight + centerSub + marginTop).
const TEXT_BLOCK_H = 20 + 1 + 12; // ~33px

type Segment = { path: string; color: string; dataIndex: number | null };

interface UnifiedSlice {
    label: string;
    color: string;
    prevSweep: number;
    currSweep: number;
}

/**
 * Animated arc rendered during data transitions. Each instance owns its
 * own `useAnimatedProps` worklet that reads the shared `progress` value
 * and the captured `allSlices` snapshot to compute start angle (prefix
 * sum of preceding interpolated sweeps) + sweep, then emits the SVG `d`.
 */
function AnimatedArc({
    sliceIndex,
    allSlices,
    progress,
    cx,
    cy,
    r,
    thickness,
}: {
    sliceIndex: number;
    allSlices: UnifiedSlice[];
    progress: SharedValue<number>;
    cx: number;
    cy: number;
    r: number;
    thickness: number;
}) {
    const slice = allSlices[sliceIndex];
    const animatedProps = useAnimatedProps(() => {
        const t = progress.value;
        let startDeg = 0;
        for (let j = 0; j < sliceIndex; j++) {
            const s = allSlices[j];
            startDeg += s.prevSweep + (s.currSweep - s.prevSweep) * t;
        }
        const sweep = slice.prevSweep + (slice.currSweep - slice.prevSweep) * t;
        const arcStart = startDeg + GAP / 2;
        const arcEnd = startDeg + sweep - GAP / 2;
        if (arcEnd <= arcStart || sweep < 0.5) {
            return { d: '' };
        }
        return { d: arcPath(cx, cy, r, arcStart, arcEnd) };
    });
    return (
        <AnimatedPath
            animatedProps={animatedProps}
            stroke={slice.color}
            strokeWidth={thickness}
            fill="none"
            strokeLinecap="round"
        />
    );
}

export function DonutChart({
    data,
    size = 200,
    thickness = 28,
    emptyColor,
    selectedIndex,
    onSelect,
    cardBackground,
    defaultCenterLabel,
}: Props) {
    const { t } = useTranslation();
    const colors = useTheme();
    const resolvedEmptyColor = emptyColor ?? colors.surfaceMuted;
    const resolvedCardBackground = cardBackground ?? colors.cardBackground;
    const svgSize = size + OVERFLOW * 2;
    const cx = svgSize / 2;
    const cy = svgSize / 2;
    const r = (size - thickness) / 2;
    const total = data.reduce((s, d) => s + d.value, 0);

    // Slice morph animation between top-N states. `prevDataRef` holds the
    // snapshot we're animating FROM; while `animating` is true we render
    // the union of prev+curr slices as AnimatedPaths, each interpolating
    // its arc between the two configurations.
    const prevDataRef = useRef<DonutSlice[]>([]);
    const [animating, setAnimating] = useState(false);
    const progress = useSharedValue(1);

    const finishAnimation = useCallback(() => {
        prevDataRef.current = data;
        setAnimating(false);
    }, [data]);

    useEffect(() => {
        const prev = prevDataRef.current;
        // First render: no animation, just record current.
        if (prev.length === 0) {
            prevDataRef.current = data;
            return;
        }
        // Same shape: nothing to animate. Use length+labels as identity.
        const sameShape =
            prev.length === data.length &&
            prev.every((s, i) => s.label === data[i].label && s.value === data[i].value);
        if (sameShape) return;
        // Skip the morph for the single-slice / empty edge cases — they
        // render as a full circle / grey ring which doesn't decompose into
        // separate paths.
        if (data.length < 2 || prev.length < 2) {
            prevDataRef.current = data;
            return;
        }
        progress.value = 0;
        setAnimating(true);
        progress.value = withTiming(
            1,
            { duration: ANIM_DURATION, easing: Easing.inOut(Easing.cubic) },
            (finished) => {
                if (finished) runOnJS(finishAnimation)();
            },
        );
    }, [data, finishAnimation, progress]);

    // Unified ordered slice list used while animating. Order: take prev
    // ordering, then append any labels that appear only in curr. Slices
    // missing from one side get a 0-sweep on that side so they grow or
    // shrink in/out of existence smoothly.
    const unifiedSlices = useMemo<UnifiedSlice[]>(() => {
        if (!animating) return [];
        const prev = prevDataRef.current;
        const prevTotal = prev.reduce((s, x) => s + x.value, 0) || 1;
        const currTotal = total || 1;
        const labels: string[] = [];
        const seen = new Set<string>();
        prev.forEach(s => { if (!seen.has(s.label)) { labels.push(s.label); seen.add(s.label); } });
        data.forEach(s => { if (!seen.has(s.label)) { labels.push(s.label); seen.add(s.label); } });
        return labels.map(label => {
            const prevSlice = prev.find(s => s.label === label);
            const currSlice = data.find(s => s.label === label);
            return {
                label,
                color: (currSlice ?? prevSlice)!.color,
                prevSweep: prevSlice ? (prevSlice.value / prevTotal) * 360 : 0,
                currSweep: currSlice ? (currSlice.value / currTotal) * 360 : 0,
            };
        });
    }, [animating, data, total]);

    // Static segments for the non-animating render path (and edge cases).
    const segments: Segment[] = [];
    if (total === 0) {
        segments.push({
            path: `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r}`,
            color: resolvedEmptyColor,
            dataIndex: null,
        });
    } else if (data.length === 1) {
        segments.push({
            path: `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r}`,
            color: data[0].color,
            dataIndex: 0,
        });
    } else {
        let angle = 0;
        data.forEach((slice, i) => {
            const sweep = (slice.value / total) * 360;
            const start = angle + GAP / 2;
            const end = angle + sweep - GAP / 2;
            if (end > start) {
                segments.push({ path: arcPath(cx, cy, r, start, end), color: slice.color, dataIndex: i });
            }
            angle += sweep;
        });
    }

    const anySelected = selectedIndex !== null && selectedIndex !== undefined;
    const selectedSlice = anySelected && selectedIndex! < data.length ? data[selectedIndex!] : null;
    const centerValue = selectedSlice ? selectedSlice.value : total;
    const centerLabel = selectedSlice
        ? selectedSlice.label
        : (defaultCenterLabel ?? t('donut.total'));
    const displayLabel = centerLabel.length > 14 ? centerLabel.slice(0, 13) + '…' : centerLabel;

    const holeRadius = r - thickness / 2 - 4;

    // Logo sits above the text block inside the hole, outside the centerLabel flow so it
    // never shifts the text position — the amount always renders identically to the total state.
    const LOGO_SIZE = 28;
    const logoTop = cy - TEXT_BLOCK_H / 2 - LOGO_SIZE - 4;
    const logoLeft = cx - LOGO_SIZE / 2;

    return (
        <View style={{ width: svgSize, height: svgSize, alignItems: 'center', justifyContent: 'center' }}>
            {/* Shadow disc — sibling of SVG so its borderRadius never clips the arcs */}
            <View style={[
                styles.disc,
                { width: size, height: size, borderRadius: size / 2, backgroundColor: resolvedCardBackground, position: 'absolute' },
            ]} />

            <Svg width={svgSize} height={svgSize}>
                {animating
                    ? unifiedSlices.map((slice, i) => (
                        <AnimatedArc
                            key={slice.label}
                            sliceIndex={i}
                            allSlices={unifiedSlices}
                            progress={progress}
                            cx={cx}
                            cy={cy}
                            r={r}
                            thickness={thickness}
                        />
                    ))
                    : segments.map((seg, i) => {
                        const isSelected = seg.dataIndex !== null && seg.dataIndex === selectedIndex;
                        return (
                            <Path
                                key={i}
                                d={seg.path}
                                stroke={seg.color}
                                strokeWidth={isSelected ? thickness + 8 : thickness}
                                fill="none"
                                strokeLinecap="round"
                                onPress={seg.dataIndex !== null && onSelect ? () => {
                                    Haptics.selectionAsync();
                                    const idx = seg.dataIndex as number;
                                    onSelect(selectedIndex === idx ? null : idx);
                                } : undefined}
                            />
                        );
                    })}

                {/* Tap center hole to deselect */}
                {!animating && anySelected && onSelect && (
                    <Circle cx={cx} cy={cy} r={holeRadius} fill="transparent" onPress={() => { Haptics.selectionAsync(); onSelect(null); }} />
                )}
            </Svg>

            {/* Logo floats above the text block without affecting its layout */}
            {selectedSlice?.logoUri && (
                <View pointerEvents="none" style={{
                    position: 'absolute', top: logoTop, left: logoLeft,
                    width: LOGO_SIZE, height: LOGO_SIZE, borderRadius: 6, overflow: 'hidden',
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: selectedSlice.brandColor ?? 'transparent',
                }}>
                    <Image
                        source={{ uri: selectedSlice.logoUri }}
                        style={{ width: LOGO_SIZE * 0.7, height: LOGO_SIZE * 0.7 }}
                        resizeMode="contain"
                    />
                </View>
            )}

            {/* Center label — always identical structure: amount + sub-label.
                Sub-label is hidden (opacity 0) when the logo is shown, but still takes up
                its natural height so the amount renders at the exact same position as in
                the total (unselected) state — same font context, same pixel position. */}
            <View pointerEvents="none" style={styles.centerLabel}>
                <Text style={[styles.centerValue, { color: colors.textPrimary }]}>{formatEuro(centerValue)}</Text>
                <Text style={[styles.centerSub, { color: colors.textSecondary }, selectedSlice?.logoUri ? { opacity: 0 } : null]}>
                    {displayLabel}
                </Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    disc: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 8,
        elevation: 6,
    },
    centerLabel: {
        position: 'absolute',
        alignItems: 'center',
    },
    centerValue: {
        fontSize: 16,
        fontWeight: '700',
        lineHeight: 20,
    },
    centerSub: {
        fontSize: 10,
        marginTop: 1,
    },
});
