import React, {
    forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
    type ReactNode,
} from 'react';
import {
    View, Pressable, StyleSheet, Platform, Dimensions,
    type LayoutChangeEvent, type StyleProp, type ViewStyle,
} from 'react-native';
import {
    Gesture, GestureDetector, ScrollView as GHScrollView, State,
} from 'react-native-gesture-handler';
import Animated, {
    runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useDerivedValue,
    useSharedValue, withSpring,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    useTheme, useResolvedScheme, spacing, radius, withAlpha, type AppTheme,
} from '../constants/theme';
import { concentricRadius, displayCornerRadius } from '../utils/displayCorners';

/**
 * DockedGlassSheet — ONE frosted-glass panel that IS a floating bottom bar and
 * grows upward into a sheet, through STANDARD detents:
 *
 *   stage 0  collapsed — just the bar row (+ a pill).
 *   stage 1  MEDIUM   — 50 % of the screen (iOS/Material medium detent).
 *   stage 2  FULL     — the panel goes SOLID (glass → opaque), its bottom
 *                       corners square and its left/right edges expand to the
 *                       screen edges; the internal list scroll switches on.
 *
 * The detents are FIXED fractions of the screen — the content's size never
 * dictates the height. `sheet.maxStage` picks how far it may open: 1 = medium
 * only (the tab-bar basket chooser), 2 = full (the session list sheet).
 *
 * Scroll HANDOFF (industry standard): below full, an upward drag on the list
 * EXPANDS the sheet (scroll disabled); the list only scrolls once it is at
 * full and you keep dragging up. A downward drag at full with the list at its
 * top collapses the sheet.
 *
 * Single-glass rationale (2026-07 research): two stacked BlurViews brighten and
 * opacity-animating a BlurView pops — so the glass recipe here is CONSTANT and
 * only HEIGHT (and, at full, a solid-backdrop fade) animates.
 */

const SCREEN_H = Dimensions.get('window').height;
const SCREEN_W = Dimensions.get('window').width;
const MEDIUM_FRACTION = 0.5;   // stage-1 detent — the standard medium height.
const PEEK = 14;               // slim pill strip above the bar row.
const FLOAT_MARGIN = spacing.lg;
// Collapsed, the floating dock is a touch NARROWER than when raised — the glass
// tucks in by COLLAPSED_INSET on each side. Raising it (→ medium) widens the
// glass back out to FLOAT_MARGIN, WITHOUT moving the bar-row content: the tab
// icons live in a fixed BAR_CONTENT_W strip centred on screen, so the extra
// width is added purely as empty glass on the left/right. (Applies to the
// floating tab-bar / chooser dock; the full-screen session sheet is unaffected.)
const COLLAPSED_INSET = 18;
const COLLAPSED_MARGIN = FLOAT_MARGIN + COLLAPSED_INSET;
const BAR_CONTENT_W = SCREEN_W - 2 * COLLAPSED_MARGIN;
const PILL_W = 40;
const PILL_H = 5;
const SNAP_SPRING = { damping: 30, stiffness: 280, mass: 0.9, overshootClamping: true } as const;

const AnimatedScroll = Animated.createAnimatedComponent(GHScrollView);

function clamp(v: number, lo: number, hi: number) {
    'worklet';
    return Math.max(lo, Math.min(hi, v));
}

export interface DockedSheetControls {
    /** Open to the medium detent (stage 1). */
    expand(): void;
    collapse(): void;
    /** Snap to an explicit stage index (clamped). */
    snapTo(stage: number): void;
    height(): number;
}

interface SheetSpec {
    content: ReactNode;
    /** How far the sheet may open: 1 = medium only, 2 = full. Default 2. */
    maxStage?: 1 | 2;
    onStageChange?: (stage: number) => void;
    onActiveChange?: (active: boolean) => void;
    contentContainerStyle?: StyleProp<ViewStyle>;
}

interface Props {
    barRow: ReactNode;
    barRowHeight: number;
    sheet?: SheetSpec;
    colors?: AppTheme;
    onBarHeight?: (h: number) => void;
    /** Reports the COLLAPSED dock's top edge as a distance from the screen
     *  bottom (bottom margin + bar height). Screens pad by this so their last
     *  item clears the floating bar; it stays correct as the bar height / inset
     *  change (T2 compact dock, session vs tab bar). Peek is excluded so the
     *  value doesn't jump when a chooser appears. */
    onCollapsedClearance?: (px: number) => void;
    /** A scrollable behind the bar whose scroll must yield to this sheet's Pan. */
    blockScrollRef?: { current: unknown } | null;
}

export const DockedGlassSheet = forwardRef<DockedSheetControls, Props>(function DockedGlassSheet({
    barRow, barRowHeight, sheet, colors: colorsProp, onBarHeight, onCollapsedClearance, blockScrollRef,
}, ref) {
    const themed = useTheme();
    const colors = colorsProp ?? themed;
    const isDark = useResolvedScheme() === 'dark';
    const insets = useSafeAreaInsets();
    const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);

    const hasSheet = sheet != null;
    const maxStage = sheet?.maxStage ?? 2;
    const dockAtLast = hasSheet && maxStage >= 2;
    const peek = hasSheet ? PEEK : 0;

    // ── STANDARD detents (fixed, content-independent) ─────────────────────────
    const collapsedH = barRowHeight + peek;
    const mediumH = Math.max(Math.round(SCREEN_H * MEDIUM_FRACTION), collapsedH + 160);
    const fullH = SCREEN_H - insets.top;

    // Distance from the screen bottom to the TOP of the collapsed dock (bottom
    // margin + bar height, peek excluded for stability). Published so screens
    // can pad their scroll content to clear the floating bar.
    const collapsedClearance =
        insets.bottom + spacing.sm + (dockAtLast ? 0 : COLLAPSED_INSET) + barRowHeight;
    useEffect(() => { onCollapsedClearance?.(collapsedClearance); }, [collapsedClearance, onCollapsedClearance]);
    const snaps = useMemo(
        () => (!hasSheet ? [collapsedH]
            : maxStage >= 2 ? [collapsedH, mediumH, fullH]
            : [collapsedH, mediumH]),
        [hasSheet, maxStage, collapsedH, mediumH, fullH],
    );
    const lastIdx = snaps.length - 1;

    const h = useSharedValue(collapsedH);
    const startH = useSharedValue(collapsedH);
    const snapsSV = useSharedValue(snaps);
    useEffect(() => { snapsSV.value = snaps; }, [snaps, snapsSV]);

    const draggingRef = useRef(false);
    const draggingSV = useSharedValue(false);
    const stageRef = useRef(0);
    const [stage, setStageState] = useState(0);

    const onStageChange = sheet?.onStageChange;
    const onActiveChange = sheet?.onActiveChange;
    const setStageJS = useCallback((s: number) => {
        stageRef.current = s;
        setStageState(s);
        onStageChange?.(s);
    }, [onStageChange]);
    const setActiveJS = useCallback((a: boolean) => {
        draggingRef.current = a;
        onActiveChange?.(a);
    }, [onActiveChange]);

    const springTo = useCallback((idx: number) => {
        const i = Math.max(0, Math.min(idx, snapsSV.value.length - 1));
        h.value = withSpring(snapsSV.value[i], SNAP_SPRING);
    }, [h, snapsSV]);

    // Re-settle to the current stage if the detents change (bar height measured,
    // rotation) without a drag in flight.
    useEffect(() => {
        if (draggingRef.current) return;
        const i = Math.min(stageRef.current, snaps.length - 1);
        h.value = withSpring(snaps[i], SNAP_SPRING);
    }, [snaps, h]);

    // ── Content scroll (only at the last detent) ──────────────────────────────
    const scrollRef = useRef<any>(null);
    const scrollY = useSharedValue(0);
    const onScroll = useAnimatedScrollHandler((e) => { scrollY.value = e.contentOffset.y; });
    // Leaving the last stage resets scroll to top so the next open starts clean.
    useEffect(() => {
        if (stage < lastIdx) scrollRef.current?.scrollTo?.({ y: 0, animated: false });
    }, [stage, lastIdx]);

    const snapEnd = useCallback((velocityY: number) => {
        'worklet';
        const sn = snapsSV.value;
        const cur = h.value;
        let idx = 0, best = 1e9;
        for (let i = 0; i < sn.length; i++) { const d = Math.abs(sn[i] - cur); if (d < best) { best = d; idx = i; } }
        if (velocityY < -500 && idx < sn.length - 1) idx++;
        else if (velocityY > 500 && idx > 0) idx--;
        h.value = withSpring(sn[idx], { ...SNAP_SPRING, velocity: -velocityY });
        draggingSV.value = false;
        runOnJS(setStageJS)(idx);
        runOnJS(setActiveJS)(false);
    }, [h, snapsSV, draggingSV, setStageJS, setActiveJS]);

    useImperativeHandle(ref, (): DockedSheetControls => ({
        expand: () => { setStageJS(1); springTo(1); },
        collapse: () => { setStageJS(0); springTo(0); },
        snapTo: (idx) => { const i = Math.max(0, Math.min(idx, snaps.length - 1)); setStageJS(i); springTo(i); },
        height: () => h.value,
    }), [setStageJS, springTo, snaps.length, h]);

    // ── One worklet-driven pan (scroll-aware handoff) ─────────────────────────
    const grabY = useSharedValue(0);
    const grabX = useSharedValue(0);
    const pan = useMemo(() => {
        let g = Gesture.Pan()
            .enabled(hasSheet)
            .manualActivation(true)
            .simultaneousWithExternalGesture(scrollRef)
            .onBegin((e) => { 'worklet'; grabY.value = e.absoluteY; grabX.value = e.absoluteX; })
            .onTouchesMove((e, sm) => {
                'worklet';
                if (e.state === State.ACTIVE) return;
                const t = e.allTouches[0];
                if (!t) return;
                const dy = t.absoluteY - grabY.value;
                const dx = t.absoluteX - grabX.value;
                if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) { sm.fail(); return; }
                if (Math.abs(dy) < 4) return;                    // taps stay taps
                if (Math.abs(dy) <= Math.abs(dx) * 1.5) return;  // not vertical-dominant
                const sn = snapsSV.value;
                if (sn.length <= 1) { sm.fail(); return; }
                const atFull = h.value >= sn[sn.length - 1] - 2;
                // Below full: the sheet always owns the drag (scroll is off).
                // At full: the list owns UPWARD drags; a downward drag at the
                // list's top collapses the sheet.
                if (!atFull || (dy > 0 && scrollY.value <= 1)) sm.activate();
                else sm.fail();
            })
            .onStart(() => {
                'worklet';
                startH.value = h.value;
                draggingSV.value = true;
                runOnJS(setActiveJS)(true);
            })
            .onUpdate((e) => {
                'worklet';
                const sn = snapsSV.value;
                const lo = sn[0], hi = sn[sn.length - 1];
                let nh = startH.value - e.translationY;
                if (nh > hi) { startH.value = hi + e.translationY; nh = hi; }
                else if (nh < lo) { startH.value = lo + e.translationY; nh = lo; }
                h.value = nh;
            })
            .onEnd((e) => { 'worklet'; snapEnd(e.velocityY); })
            .onFinalize((_e, success) => {
                'worklet';
                if (success) return;
                draggingSV.value = false;
                runOnJS(setActiveJS)(false);
            });
        if (blockScrollRef) g = g.blocksExternalGesture(blockScrollRef as never);
        return g;
    }, [hasSheet, snapEnd, h, startH, snapsSV, scrollY, draggingSV, grabX, grabY, setActiveJS, blockScrollRef]);

    // ── Dock-to-full progress (0 floating → 1 edge-to-edge solid) ─────────────
    const dockP = useDerivedValue(() => {
        if (!dockAtLast) return 0;
        const sn = snapsSV.value;
        const last = sn[sn.length - 1];
        const prev = sn.length > 1 ? sn[sn.length - 2] : last;
        return clamp((h.value - prev) / Math.max(1, last - prev), 0, 1);
    });
    // 0 collapsed → 1 raised, for the floating tab-bar / chooser dock. Drives the
    // narrow-collapsed → wide-raised glass tween (the session sheet uses dockP).
    const raiseP = useDerivedValue(() => {
        if (dockAtLast) return 0;
        const sn = snapsSV.value;
        const lo = sn[0];
        const hi = sn.length > 1 ? sn[sn.length - 1] : lo;
        return hi > lo ? clamp((h.value - lo) / (hi - lo), 0, 1) : 0;
    });
    const cornerR = concentricRadius(insets.bottom, spacing.sm);
    const displayR = displayCornerRadius(insets.bottom);

    // ── Animated styles ───────────────────────────────────────────────────────
    // Dock morph animates the EDGES directly (left/right/bottom/bottom-radius)
    // so the content keeps its normal side padding — a scaleX morph would need
    // a counter-scale that renders content full-width and clips off the padding.
    const clipStyle = useAnimatedStyle(() => {
        const base: Record<string, unknown> = { height: h.value };
        if (dockAtLast) {
            const p = dockP.value;
            const m = FLOAT_MARGIN * (1 - p);
            const r = Math.round(cornerR + (displayR - cornerR) * p);
            base.left = m;
            base.right = m;
            base.bottom = insets.bottom + spacing.sm * (1 - p);
            base.borderBottomLeftRadius = r;
            base.borderBottomRightRadius = r;
        } else {
            // Collapsed the glass is inset by COLLAPSED_INSET on all three free
            // edges (left/right/bottom); raising grows it back out EQUALLY on the
            // sides AND downward. The centred, bottom-fixed bar content never
            // moves (see barRowStyle counter-offsets).
            const p = raiseP.value;
            const m = COLLAPSED_MARGIN + (FLOAT_MARGIN - COLLAPSED_MARGIN) * p;
            base.left = m;
            base.right = m;
            base.bottom = insets.bottom + spacing.sm + COLLAPSED_INSET * (1 - p);
        }
        return base;
    });
    // Bar-row (tab icons) held at a fixed screen box: width BAR_CONTENT_W and a
    // left/bottom offset that counter-animates the clip's own left/bottom so the
    // icons' screen x AND y stay constant at every detent — the glass grows
    // around them. Full-width for the session sheet (dockAtLast).
    const barRowStyle = useAnimatedStyle(() => {
        if (dockAtLast) return { left: 0, right: 0, bottom: 0 };
        const p = raiseP.value;
        const m = COLLAPSED_MARGIN + (FLOAT_MARGIN - COLLAPSED_MARGIN) * p;
        return { left: COLLAPSED_MARGIN - m, width: BAR_CONTENT_W, bottom: COLLAPSED_INSET * p };
    });
    // The separator + content sit just above the bar row. Because the bar row is
    // counter-offset (COLLAPSED_INSET·raiseP) to stay screen-fixed while the clip
    // bottom grows down, they must carry the SAME offset — otherwise they drift
    // down over the tab icons on drag. So they anchor to the icons, not the clip.
    const barTopStyle = useAnimatedStyle(() => ({
        bottom: barRowHeight + (dockAtLast ? 0 : COLLAPSED_INSET * raiseP.value),
    }));
    const solidStyle = useAnimatedStyle(() => ({ opacity: dockAtLast ? dockP.value : 0 }));
    const sepStyle = useAnimatedStyle(() => {
        const sn = snapsSV.value;
        const lo = sn[0], hi = sn[sn.length - 1];
        return { opacity: hi > lo ? clamp((h.value - lo) / Math.min(70, hi - lo), 0, 1) : 0 };
    });

    const onExpandTap = useCallback(() => {
        if (stageRef.current === 0) { setStageJS(1); springTo(1); }
        else { setStageJS(0); springTo(0); }
    }, [setStageJS, springTo]);

    const scrollEnabled = hasSheet && dockAtLast && stage === lastIdx;

    const panel = (
        <Animated.View
            style={[
                styles.clip,
                { borderRadius: cornerR },
                // Non-dock: fixed floating margins. Dock: left/right/bottom come
                // from clipStyle and animate to the screen edges at full.
                !dockAtLast && styles.clipFloat,
                !dockAtLast && { bottom: insets.bottom + spacing.sm },
                clipStyle,
            ]}
            pointerEvents={hasSheet ? 'auto' : 'box-none'}
        >
            {/* CONSTANT GLASS (blur + tint) + a SOLID backdrop that fades in at
                the full detent. */}
            <BlurView
                pointerEvents="none"
                intensity={isDark ? 40 : 55}
                tint={isDark ? 'dark' : 'light'}
                experimentalBlurMethod="dimezisBlurView"
                style={styles.glassFill}
            />
            <View pointerEvents="none" style={[styles.glassFill, styles.tint]} />
            {dockAtLast && (
                <Animated.View pointerEvents="none" style={[styles.glassFill, styles.solid, solidStyle]} />
            )}
            <View pointerEvents="none" style={styles.rim} />

            {/* CONTENT — Find-My reveal: pinned below the pill, above the bar
                row; a ScrollView that only scrolls at the full detent. */}
            {hasSheet && (
                <Animated.View style={[styles.contentClip, { top: peek }, barTopStyle]} pointerEvents="box-none">
                    <AnimatedScroll
                        ref={scrollRef}
                        style={StyleSheet.absoluteFill}
                        contentContainerStyle={sheet!.contentContainerStyle}
                        scrollEnabled={scrollEnabled}
                        showsVerticalScrollIndicator={scrollEnabled}
                        onScroll={onScroll}
                        scrollEventThrottle={16}
                        bounces={false}
                        overScrollMode="never"
                    >
                        {sheet!.content}
                    </AnimatedScroll>
                </Animated.View>
            )}

            {hasSheet && (
                <Animated.View pointerEvents="none" style={[styles.separator, barTopStyle, sepStyle]} />
            )}

            {/* BAR ROW — pinned at the bottom; held to a fixed centred strip so
                the tab icons don't shift as the glass widens on raise. */}
            <Animated.View
                style={[styles.barRow, { height: barRowHeight }, barRowStyle]}
                onLayout={(e: LayoutChangeEvent) => onBarHeight?.(e.nativeEvent.layout.height)}
                pointerEvents="box-none"
            >
                {barRow}
            </Animated.View>

            {/* Grabber pill — rides the clip's top edge. */}
            {hasSheet && (
                <View style={styles.pillWrap} pointerEvents="box-none">
                    <Pressable hitSlop={{ top: 12, bottom: 4, left: 28, right: 28 }} onPress={onExpandTap}>
                        <View style={styles.pill} />
                    </Pressable>
                </View>
            )}
        </Animated.View>
    );

    return (
        <View style={styles.wrap} pointerEvents="box-none">
            {hasSheet ? <GestureDetector gesture={pan}>{panel}</GestureDetector> : panel}
        </View>
    );
});

const makeStyles = (c: AppTheme, isDark: boolean) => StyleSheet.create({
    wrap: {
        position: 'absolute', left: 0, right: 0, bottom: 0,
        paddingHorizontal: FLOAT_MARGIN,
    },
    clip: {
        position: 'absolute',
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: c.outlineVariant,
        ...(isDark
            ? { shadowColor: '#000000', shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 16 }
            : { shadowColor: '#5A2233', shadowOpacity: 0.28, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 16 }),
    },
    // Non-dock floating side margins (dock animates left/right in clipStyle).
    clipFloat: { left: FLOAT_MARGIN, right: FLOAT_MARGIN },
    glassFill: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: Platform.OS === 'android' ? undefined : 'transparent',
    },
    tint: { backgroundColor: withAlpha(c.surfaceContainer, isDark ? 0.62 : 0.6) },
    solid: { backgroundColor: c.pageBackground },
    rim: {
        ...StyleSheet.absoluteFillObject,
        borderTopWidth: 1.2,
        borderTopColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.9)',
    },
    contentClip: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
    separator: {
        position: 'absolute', left: spacing.lg, right: spacing.lg,
        height: StyleSheet.hairlineWidth, backgroundColor: c.outlineVariant,
    },
    barRow: { position: 'absolute', bottom: 0, justifyContent: 'center' },
    pillWrap: {
        position: 'absolute', top: 0, left: 0, right: 0,
        alignItems: 'center', paddingTop: 5,
    },
    pill: {
        width: PILL_W, height: PILL_H, borderRadius: radius.pill,
        backgroundColor: c.border,
    },
});
