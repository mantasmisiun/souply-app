import React, {
    forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
    type ReactNode,
} from 'react';
import { View, Pressable, StyleSheet, Platform, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    runOnJS, useAnimatedStyle, useSharedValue, withSpring,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    useTheme, useResolvedScheme, spacing, radius, withAlpha, type AppTheme,
} from '../constants/theme';

/**
 * DockedGlassSheet — ONE frosted-glass panel that IS a floating bottom bar and
 * grows upward into a sheet. The reusable, artifact-free replacement for the
 * old two-layer (tab-bar + separately-mounted GlassStageSheet) dock.
 *
 * Why one panel (2026-07 research): stacking two BlurViews over the same pixels
 * BRIGHTENS (blur compositing), animating a BlurView's opacity POPS, and two
 * independently-computed edges MISALIGN. All three vanish when there is a
 * single glass surface whose only animated property is HEIGHT.
 *
 * Architecture:
 *  · A bottom-pinned CLIP (`overflow:'hidden'`) whose HEIGHT is the single
 *    animated value (one shared value, spring-snapped). Its glass/tint/border/
 *    shadow are CONSTANT — collapsing just makes the clip shorter, it never
 *    fades. Corner radius is identical top and bottom at every height, so the
 *    bar and the expanded sheet share one silhouette.
 *  · A fixed-size inner PANEL (height = expanded), bottom-anchored, laid out
 *    ONCE: the glass fill, the sheet CONTENT (above the bar row), the BAR ROW
 *    pinned at the bottom. The clip reveals the bottom `h` of it — content
 *    never reflows, the BlurView never resizes (no per-frame re-blur).
 *  · One Pan over the whole panel. Because the bar row (its tab buttons) lives
 *    INSIDE this component, a drag and a tab tap coexist with zero cross-tree
 *    plumbing: vertical travel drives the sheet, a tap falls through.
 *
 * `sheet` omitted → a plain glass bar (fixed height, no pill, no gesture) —
 * the normal tab bar on every screen with no dock.
 */

const PILL_W = 40;
const PILL_H = 5;
// A slim glass strip above the bar row holding the grabber pill — so the pill
// sits ABOVE the tab buttons, never overlapping (and stealing) their taps.
const PEEK = 14;
const SNAP_SPRING = { damping: 30, stiffness: 280, mass: 0.9, overshootClamping: true } as const;

export interface DockedSheetControls {
    expand(): void;
    collapse(): void;
    /** Current visible panel height (px) — for external drag bridges. */
    height(): number;
    dragBegin(): void;
    dragTo(height: number): void;
    dragEnd(velocityY: number): void;
}

interface SheetSpec {
    /** Sheet body, laid out once at its natural height above the bar row. */
    content: ReactNode;
    /** Known content height (px). Drives the expanded snap. */
    contentHeight: number;
    /** Settled stage callback (0 collapsed → 1 expanded). */
    onStageChange?: (stage: 0 | 1) => void;
    /** Drag in progress (true on grab, false on release). */
    onActiveChange?: (active: boolean) => void;
}

interface Props {
    /** Pinned at the panel bottom — the tab buttons, or a session header. */
    barRow: ReactNode;
    /** Height of `barRow`. */
    barRowHeight: number;
    /** Optional expandable sheet. Omit for a plain bar. */
    sheet?: SheetSpec;
    colors?: AppTheme;
    /** Report the panel's collapsed (bar) height for scroll-clearance. */
    onBarHeight?: (h: number) => void;
    /** A scrollable behind the bar whose scroll must yield to this sheet's Pan
     *  — the Pan `blocksExternalGesture`s it so a drag starting on the bar
     *  expands the sheet instead of letting the list steal the scroll. */
    blockScrollRef?: { current: unknown } | null;
}

function clamp(v: number, lo: number, hi: number) {
    'worklet';
    return Math.max(lo, Math.min(hi, v));
}

export const DockedGlassSheet = forwardRef<DockedSheetControls, Props>(function DockedGlassSheet({
    barRow, barRowHeight, sheet, colors: colorsProp, onBarHeight, blockScrollRef,
}, ref) {
    const themed = useTheme();
    const colors = colorsProp ?? themed;
    const isDark = useResolvedScheme() === 'dark';
    const insets = useSafeAreaInsets();
    const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);

    const hasSheet = sheet != null;
    const contentHeight = sheet?.contentHeight ?? 0;
    const peek = hasSheet ? PEEK : 0;
    // Collapsed = bar row + a slim pill strip; expanded adds the content above.
    const collapsedH = barRowHeight + peek;
    const expandedH = barRowHeight + peek + contentHeight;

    // THE single source of truth. Collapsed = bar height; expanded = + content.
    const h = useSharedValue(collapsedH);
    const startH = useSharedValue(collapsedH);
    const collapsedSV = useSharedValue(collapsedH);
    const expandedSV = useSharedValue(expandedH);
    useEffect(() => {
        collapsedSV.value = collapsedH;
        expandedSV.value = expandedH;
    }, [collapsedH, expandedH, collapsedSV, expandedSV]);

    const draggingRef = useRef(false);
    const stageRef = useRef<0 | 1>(0);
    const [, force] = useState(0);

    const onStageChange = sheet?.onStageChange;
    const onActiveChange = sheet?.onActiveChange;
    const setStageJS = useCallback((s: 0 | 1) => {
        stageRef.current = s;
        onStageChange?.(s);
        force(n => n + 1); // re-render so pill/press logic reads the new stage
    }, [onStageChange]);
    const setActiveJS = useCallback((a: boolean) => {
        draggingRef.current = a;
        onActiveChange?.(a);
    }, [onActiveChange]);

    const springTo = useCallback((s: 0 | 1) => {
        h.value = withSpring(s === 1 ? expandedSV.value : collapsedSV.value, SNAP_SPRING);
    }, [h, expandedSV, collapsedSV]);

    // Re-settle when the measured heights change (chooser↔list swap, content
    // grew) — hold the current stage at the new geometry. No animation glass,
    // just the height spring.
    useEffect(() => {
        if (draggingRef.current) return;
        h.value = withSpring(stageRef.current === 1 ? expandedH : collapsedH, SNAP_SPRING);
    }, [expandedH, collapsedH, h]);

    const endDrag = useCallback((velocityY: number) => {
        'worklet';
        const lo = collapsedSV.value, hi = expandedSV.value;
        const projected = h.value - velocityY * 0.12; // up (‑vy) grows height
        const target = Math.abs(projected - hi) < Math.abs(projected - lo) ? hi : lo;
        h.value = withSpring(target, { ...SNAP_SPRING, velocity: -velocityY });
        runOnJS(setStageJS)(target === hi ? 1 : 0);
        runOnJS(setActiveJS)(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, (): DockedSheetControls => ({
        expand: () => { setStageJS(1); springTo(1); },
        collapse: () => { setStageJS(0); springTo(0); },
        height: () => h.value,
        dragBegin: () => { startH.value = h.value; setActiveJS(true); },
        dragTo: (nh) => { h.value = clamp(nh, collapsedSV.value, expandedSV.value); },
        dragEnd: (vy) => { endDrag(vy); },
    }), [setStageJS, springTo, endDrag, setActiveJS, h, startH, collapsedSV, expandedSV]);

    // Pan drives the sheet; vertical-dominant activates, taps + horizontal
    // swipes fall through to the bar-row buttons. It BLOCKS the list scrolling
    // behind the bar so a drag that starts on the bar can never leak into a
    // page scroll (or a scroll-then-handoff).
    const pan = useMemo(() => {
        let g = Gesture.Pan()
            .enabled(hasSheet)
            .activeOffsetY([-8, 8])
            .failOffsetX([-18, 18])
            .onStart(() => { 'worklet'; startH.value = h.value; runOnJS(setActiveJS)(true); })
            .onUpdate((e) => {
                'worklet';
                h.value = clamp(startH.value - e.translationY, collapsedSV.value, expandedSV.value);
            })
            .onEnd((e) => { 'worklet'; endDrag(e.velocityY); })
            .onFinalize((_e, success) => { 'worklet'; if (!success) runOnJS(setActiveJS)(false); });
        if (blockScrollRef) g = g.blocksExternalGesture(blockScrollRef as never);
        return g;
    }, [hasSheet, endDrag, h, startH, collapsedSV, expandedSV, setActiveJS, blockScrollRef]);

    const clipStyle = useAnimatedStyle(() => ({ height: h.value }));
    // Separator fades in over the first bit of expansion (never on the plain
    // collapsed bar).
    const sepStyle = useAnimatedStyle(() => {
        const lo = collapsedSV.value, hi = expandedSV.value;
        const p = hi > lo ? clamp((h.value - lo) / Math.min(70, hi - lo), 0, 1) : 0;
        return { opacity: p };
    });

    const onExpandTap = useCallback(() => {
        if (stageRef.current === 0) { setStageJS(1); springTo(1); }
        else { setStageJS(0); springTo(0); }
    }, [setStageJS, springTo]);

    const panel = (
        <Animated.View
            style={[styles.clip, { bottom: insets.bottom + spacing.sm }, clipStyle]}
            // When there's a sheet the panel must CAPTURE touches over its area
            // (drag anywhere on it) so they can't leak through to the list
            // behind — box-none let non-touchable content pass through and, with
            // blocksExternalGesture, deadlocked the drag. Plain bar stays
            // box-none (only its tab buttons are interactive).
            pointerEvents={hasSheet ? 'auto' : 'box-none'}
        >
            {/* CONSTANT GLASS — fills the clip; fixed recipe, never animated. */}
            <BlurView
                pointerEvents="none"
                intensity={isDark ? 40 : 55}
                tint={isDark ? 'dark' : 'light'}
                experimentalBlurMethod="dimezisBlurView"
                style={styles.glassFill}
            />
            <View pointerEvents="none" style={[styles.glassFill, styles.tint]} />
            <View pointerEvents="none" style={styles.rim} />

            {/* CONTENT — Find-My reveal: pinned below the pill (top: peek) and
                ABOVE the bar row (bottom: barRowHeight). It fills exactly the
                revealed gap, so as the sheet shrinks the TITLE stays put at the
                top and the rows clip from the BOTTOM (behind the bar). */}
            {hasSheet && (
                <View
                    style={[styles.contentClip, { top: peek, bottom: barRowHeight }]}
                    pointerEvents="box-none"
                >
                    <View style={{ height: contentHeight }} pointerEvents="box-none">
                        {sheet!.content}
                    </View>
                </View>
            )}

            {/* Thin separator between the sheet content and the bar row — fades
                in as the sheet opens. */}
            {hasSheet && (
                <Animated.View
                    pointerEvents="none"
                    style={[styles.separator, { bottom: barRowHeight }, sepStyle]}
                />
            )}

            {/* BAR ROW — always pinned at the bottom (tabs / session header). */}
            <View
                style={[styles.barRow, { height: barRowHeight }]}
                onLayout={(e: LayoutChangeEvent) => onBarHeight?.(e.nativeEvent.layout.height)}
                pointerEvents="box-none"
            >
                {barRow}
            </View>

            {/* Grabber pill — rides the clip's TOP edge (the reveal line): on the
                bar's top edge when collapsed, at the sheet's top when expanded.
                Tap toggles; drag is the panel Pan. */}
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
        paddingHorizontal: spacing.lg,
    },
    clip: {
        position: 'absolute', left: spacing.lg, right: spacing.lg,
        borderRadius: radius.xl,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: c.outlineVariant,
        // One constant lift shadow — never toggled (toggling it was what made
        // the strip below the bar flicker).
        ...(isDark
            ? { shadowColor: '#000000', shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 16 }
            : { shadowColor: '#5A2233', shadowOpacity: 0.28, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 16 }),
    },
    glassFill: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: Platform.OS === 'android' ? undefined : 'transparent',
    },
    tint: { backgroundColor: withAlpha(c.surfaceContainer, isDark ? 0.62 : 0.6) },
    rim: {
        ...StyleSheet.absoluteFillObject,
        borderTopWidth: 1.2,
        borderTopColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.9)',
        borderRadius: radius.xl,
    },
    contentClip: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
    separator: {
        position: 'absolute', left: spacing.lg, right: spacing.lg,
        height: StyleSheet.hairlineWidth, backgroundColor: c.outlineVariant,
    },
    barRow: { position: 'absolute', left: 0, right: 0, bottom: 0, justifyContent: 'center' },
    pillWrap: {
        position: 'absolute', top: 0, left: 0, right: 0,
        alignItems: 'center', paddingTop: 5,
    },
    pill: {
        width: PILL_W, height: PILL_H, borderRadius: radius.pill,
        backgroundColor: c.border,
    },
});
