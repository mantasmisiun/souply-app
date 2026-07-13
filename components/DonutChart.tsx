import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import Animated, {
    Easing,
    interpolateColor,
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
import { ChainLogoChip } from './ChainLogoChip';
import { chainIdByName } from '../utils/chainBrandName';

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

/**
 * One slice's endpoints in BOTH configurations, matched by label. Angles are
 * absolute (degrees from 12 o'clock), so each arc interpolates its own start +
 * sweep independently — no shared prefix-sum. That's what lets slices SLIDE to
 * new positions on a reorder and grow/shrink in place on enter/exit, instead of
 * morphing in a fixed order and snapping at the end.
 */
interface UnifiedSlice {
    label: string;
    prevStart: number;
    prevSweep: number;
    currStart: number;
    currSweep: number;
    prevColor: string;
    currColor: string;
}

/**
 * Animated arc rendered during data transitions. Interpolates its OWN absolute
 * start, sweep and colour between the prev and curr layouts — fully independent
 * of the other arcs. At t=1 it lands exactly on the static (value-sorted)
 * layout, so the animating→static handoff is seamless (no snap).
 */
function AnimatedArc({
    slice,
    progress,
    cx,
    cy,
    r,
    thickness,
}: {
    slice: UnifiedSlice;
    progress: SharedValue<number>;
    cx: number;
    cy: number;
    r: number;
    thickness: number;
}) {
    const animatedProps = useAnimatedProps(() => {
        const t = progress.value;
        const start = slice.prevStart + (slice.currStart - slice.prevStart) * t;
        const sweep = slice.prevSweep + (slice.currSweep - slice.prevSweep) * t;
        const stroke = interpolateColor(t, [0, 1], [slice.prevColor, slice.currColor]);
        // A slot that fills (almost) the whole ring — the 1↔N endpoints — draws
        // as a seamless full circle (no gap), matching the static single-slice
        // render so the animation start/end has no notch pop.
        if (sweep >= 360 - GAP) {
            return { d: `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r}`, stroke };
        }
        const arcStart = start + GAP / 2;
        const arcEnd = start + sweep - GAP / 2;
        if (arcEnd <= arcStart || sweep < 0.5) {
            return { d: '', stroke };
        }
        return { d: arcPath(cx, cy, r, arcStart, arcEnd), stroke };
    });
    return (
        <AnimatedPath
            animatedProps={animatedProps}
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

    // STICKY SLOT ORDER. Once a label appears it keeps its angular position for
    // the life of the component. This is deliberate: a value-sorted ring
    // reshuffles every month, and re-sorting a RING can't animate cleanly —
    // to trade angular slots two wedges must either overlap (cross) or jump.
    // Stable slots make every transition a pure grow/shrink (+ enter/exit) —
    // "one constricts, the others expand" — with no overlap and no snap, and
    // 1↔N falls out for free. Selection + the value-sorted legend are unaffected
    // (they use the caller's data order via dataIndexByLabel below).
    const orderRef = useRef<string[]>([]);
    const order = orderRef.current.slice();
    {
        const known = new Set(order);
        for (const s of data) if (!known.has(s.label)) { order.push(s.label); known.add(s.label); }
    }
    orderRef.current = order;
    const orderedData = order
        .map((l) => data.find((s) => s.label === l))
        .filter((s): s is DonutSlice => !!s);
    const dataIndexByLabel = new Map<string, number>();
    data.forEach((s, i) => dataIndexByLabel.set(s.label, i));

    // Slice morph animation. `prevDataRef` holds the (sticky-ordered) snapshot
    // we're animating FROM; while `animating` is true we render every slot as an
    // AnimatedPath interpolating its arc between the two configurations.
    const prevDataRef = useRef<DonutSlice[]>([]);
    // Signature of the target we last STARTED animating toward — so an
    // incidental re-render mid-morph doesn't restart it from 0.
    const startedSigRef = useRef<string>('');
    const [animating, setAnimating] = useState(false);
    const progress = useSharedValue(1);

    const finishAnimation = useCallback(() => {
        prevDataRef.current = orderedData;
        setAnimating(false);
    }, [orderedData]);

    useEffect(() => {
        const prev = prevDataRef.current;
        // First render: no animation, just record current.
        if (prev.length === 0) {
            prevDataRef.current = orderedData;
            return;
        }
        // Same shape (same labels + values, order-independent): nothing to do.
        const prevByLabel = new Map(prev.map((s) => [s.label, s.value]));
        const sameShape =
            prev.length === orderedData.length &&
            orderedData.every((s) => prevByLabel.get(s.label) === s.value);
        if (sameShape) return;
        // Already animating toward this exact target → don't restart from 0.
        const sig = orderedData.map((s) => `${s.label}:${s.value}`).join('|');
        if (startedSigRef.current === sig) return;
        // To / from an EMPTY ring is a discrete state (grey ring) — snap.
        const prevTotal = prev.reduce((s, x) => s + x.value, 0);
        if (prevTotal <= 0 || total <= 0) {
            prevDataRef.current = orderedData;
            return;
        }
        startedSigRef.current = sig;
        progress.value = 0;
        setAnimating(true);
        progress.value = withTiming(
            1,
            { duration: ANIM_DURATION, easing: Easing.inOut(Easing.cubic) },
            (finished) => {
                if (finished) runOnJS(finishAnimation)();
            },
        );
    }, [orderedData, total, finishAnimation, progress]);

    // Unified slice list used while animating. Laid out by PREFIX SUM in the
    // sticky order, so both sides share one order → the ring stays contiguous
    // (no overlap) throughout, and at t=1 it equals the static layout (no snap).
    // A slot absent on one side keeps 0 sweep there → grows from / shrinks to a
    // zero-width arc in its own slot while neighbours reflow to fill.
    const unifiedSlices = useMemo<UnifiedSlice[]>(() => {
        if (!animating) return [];
        const prev = prevDataRef.current;
        const prevTotal = prev.reduce((s, x) => s + x.value, 0) || 1;
        const currTotal = orderedData.reduce((s, x) => s + x.value, 0) || 1;
        const prevByLabel = new Map(prev.map((s) => [s.label, s]));
        const currByLabel = new Map(orderedData.map((s) => [s.label, s]));
        let prevAcc = 0;
        let currAcc = 0;
        const out: UnifiedSlice[] = [];
        for (const label of order) {
            const p = prevByLabel.get(label);
            const c = currByLabel.get(label);
            if (!p && !c) continue; // seen once, absent from both now
            const prevSweep = p ? (p.value / prevTotal) * 360 : 0;
            const currSweep = c ? (c.value / currTotal) * 360 : 0;
            out.push({
                label,
                prevStart: prevAcc,
                prevSweep,
                currStart: currAcc,
                currSweep,
                prevColor: (p ?? c)!.color,
                currColor: (c ?? p)!.color,
            });
            prevAcc += prevSweep;
            currAcc += currSweep;
        }
        return out;
    }, [animating, order, orderedData]);

    // Static segments for the non-animating render path (and edge cases).
    const segments: Segment[] = [];
    if (total === 0) {
        segments.push({
            path: `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r}`,
            color: resolvedEmptyColor,
            dataIndex: null,
        });
    } else if (orderedData.length === 1) {
        segments.push({
            path: `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r}`,
            color: orderedData[0].color,
            dataIndex: dataIndexByLabel.get(orderedData[0].label) ?? 0,
        });
    } else {
        // Render in the sticky slot order; map each slice back to the caller's
        // data index so selection + legend stay aligned.
        let angle = 0;
        orderedData.forEach((slice) => {
            const sweep = (slice.value / total) * 360;
            const start = angle + GAP / 2;
            const end = angle + sweep - GAP / 2;
            if (end > start) {
                segments.push({
                    path: arcPath(cx, cy, r, start, end),
                    color: slice.color,
                    dataIndex: dataIndexByLabel.get(slice.label) ?? null,
                });
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
                    ? unifiedSlices.map((slice) => (
                        <AnimatedArc
                            key={slice.label}
                            slice={slice}
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

            {/* Selected chain's badge — the same baked map-pin asset as everywhere
                else. Floats above the text block without affecting its layout. */}
            {selectedSlice?.logoUri && (
                <View pointerEvents="none" style={{ position: 'absolute', top: logoTop, left: logoLeft }}>
                    <ChainLogoChip chainId={chainIdByName(selectedSlice.label) ?? 0} name={selectedSlice.label} size={LOGO_SIZE} />
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
