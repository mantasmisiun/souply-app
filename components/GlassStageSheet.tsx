import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, Dimensions, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector, ScrollView, State } from 'react-native-gesture-handler';
import Animated, {
    SlideOutDown, runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useDerivedValue,
    useSharedValue, withSpring, withTiming,
} from 'react-native-reanimated';
import { spacing, radius, type AppTheme } from '../constants/theme';
import { LiquidGlass } from './LiquidGlass';
import { concentricRadius, displayCornerRadius } from '../utils/displayCorners';

/**
 * FLOATING GLASS BAR↔SHEET (Find-My-style) — the reusable stage machinery
 * extracted from the results-map bottom sheet, so every bar-that-expands in
 * the app shares one implementation: a floating liquid-glass panel with a
 * grabber pill, a bottom-pinned action BAR that is always visible, and a BODY
 * that reveals as the sheet is dragged (or driven) through its snap stages.
 *
 * Architecture (all battle-tested on the map sheet):
 *  · TRANSFORM-ONLY drag — the body is laid out once at the tallest snap and
 *    slides inside a fixed clip; per-frame work is a matrix update plus a
 *    one-leaf-node resize of the glass frame. No Yoga relayout, no stutter.
 *  · The GLASS FRAME's bounds are the visible sheet rect every frame, so the
 *    native material's rim wraps all real edges and corner arcs.
 *  · One worklet-driven RNGH pan over the whole sheet: vertical-dominant
 *    drags move the sheet (taps and horizontal swipes pass through); at the
 *    last stage the body ScrollView owns upward drags until scrolled to top.
 *  · Optional `dockAtLast` (the map sheet): approaching the last snap morphs
 *    the float edge-to-edge via scaleX + counter-scale, with concentric
 *    corner growth and a solid backdrop fade. Off by default — a plain sheet
 *    tops out at its last snap, floating.
 *
 * The parent computes `snaps` (ascending heights, index 0 = the collapsed
 * bar) from the measurements this component reports (`onBarHeight`,
 * `onContentHeight`) plus its own knowledge (first card height, caps).
 */

const SCREEN_H = Dimensions.get('window').height;
const SCREEN_W = Dimensions.get('window').width;

/** Height of the grabber-pill area — include it in snap heights. */
export const SHEET_HANDLE_H = 30;

const AnimatedGHScrollView = Animated.createAnimatedComponent(ScrollView);

export interface GlassStageSheetRef {
    /** Animate to a stage (clamped). Same-stage calls re-snap (settle). */
    snapTo(stage: number): void;
}

type Props = {
    /** Ascending snap heights; [0] is the collapsed bar. A single entry
     *  renders a fixed (non-expandable) bar — the pill hides automatically. */
    snaps: number[];
    /** Stage to open at on mount (default 0 — collapsed). */
    initialStage?: number;
    onStageChange?: (stage: number) => void;
    /** Settled sheet height + float gap (for framing content above it). */
    onHeightChange?: (height: number) => void;
    /** Bottom-pinned bar content (always visible). Measured & reported. */
    bar: React.ReactNode;
    /** Body content, revealed by expansion, inside the sheet's ScrollView. */
    children?: React.ReactNode;
    contentContainerStyle?: StyleProp<ViewStyle>;
    onBarHeight?: (h: number) => void;
    onContentHeight?: (h: number) => void;
    colors: AppTheme;
    bottomInset: number;
    /** Map-sheet mode: the last snap docks edge-to-edge (scaleX morph,
     *  concentric corners, solid backdrop). */
    dockAtLast?: boolean;
    /** Slide out when unmounted (sheets that come and go, e.g. map results). */
    exitSlide?: boolean;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const GlassStageSheet = forwardRef<GlassStageSheetRef, Props>(function GlassStageSheet({
    snaps, initialStage = 0, onStageChange, onHeightChange,
    bar, children, contentContainerStyle, onBarHeight, onContentHeight,
    colors, bottomInset, dockAtLast = false, exitSlide = false,
}, ref) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [barH, setBarH] = useState(60);
    const [stage, setStage] = useState(initialStage);
    // Bumped on each user snap so the settle effect animates even to the SAME
    // stage (a small drag that releases back).
    const [settleTick, setSettleTick] = useState(0);

    const safeStage = Math.min(stage, snaps.length - 1);

    const height = useSharedValue(snaps[Math.min(initialStage, snaps.length - 1)]);
    // Declared BEFORE every worklet that captures it (a later `const` is still
    // in its temporal dead zone at worklet creation → undefined → crash).
    const snapsSV = useSharedValue<number[]>(snaps);
    useEffect(() => { snapsSV.value = snaps; }, [snaps, snapsSV]);
    const dragging = useRef(false);
    const draggingSV = useSharedValue(false);
    const snapsRef = useRef(snaps); snapsRef.current = snaps;
    const stageRef = useRef(safeStage); stageRef.current = safeStage;
    // Slide-in is driven by this shared value (NOT reanimated's `entering`
    // layout animation): a layout animation + an animated `height` on the same
    // node fight on Fabric — the entering snapshot pins the height.
    const slideY = useSharedValue(SCREEN_H * 0.85);
    useEffect(() => { slideY.value = withTiming(0, { duration: 260 }); }, [slideY]);

    // ── Last-stage DOCK progress (only meaningful when dockAtLast) ──────────
    // Finger DOWN → height-derived progress (tracks/reverses with the drag);
    // released → stagePSV, a timing the gesture SEEDS from the finger's final
    // progress, so the handoff is continuous in both directions.
    const stagePSV = useSharedValue(0);
    useEffect(() => {
        if (!dockAtLast) return;
        const atLast = snaps.length > 1 && safeStage === snaps.length - 1;
        stagePSV.value = withTiming(atLast ? 1 : 0, { duration: 240 });
    }, [safeStage, snaps.length, settleTick, stagePSV, dockAtLast]);
    const dockP = useDerivedValue(() => {
        if (!dockAtLast) return 0;
        const sn = snapsSV.value;
        const last = sn[sn.length - 1];
        const prev = sn.length > 1 ? sn[sn.length - 2] : last;
        const range = Math.max(1, last - prev);
        const hp = Math.min(1, Math.max(0, (height.value - prev) / range));
        let p = draggingSV.value ? hp : stagePSV.value;
        if (p > 0.995) p = 1;
        return p;
    });
    const bottomOffset = spacing.sm;

    // Dock mode lays the root out EDGE-TO-EDGE and scales down in x to the
    // floating width (the morph is transform-only); float mode just lays out
    // with margins — no scale, no counter-scale.
    const outerStyle = useAnimatedStyle(() => {
        if (!dockAtLast) {
            return { transform: [{ translateY: slideY.value - bottomOffset }] };
        }
        const p = dockP.value;
        const s = (SCREEN_W - 2 * spacing.sm * (1 - p)) / SCREEN_W;
        return {
            transform: [
                { translateY: slideY.value - bottomOffset * (1 - p) },
                { scaleX: s },
            ],
        };
    });
    const counterScaleStyle = useAnimatedStyle(() => {
        if (!dockAtLast) return {};
        const p = dockP.value;
        const s = (SCREEN_W - 2 * spacing.sm * (1 - p)) / SCREEN_W;
        return { transform: [{ scaleX: 1 / s }] };
    });
    // delta = how far the (fixed-size) glass panel + body slide DOWN as the
    // sheet collapses. One shared worklet drives both transforms.
    const bodyStyle = useAnimatedStyle(() => {
        const sn = snapsSV.value;
        return { transform: [{ translateY: sn[sn.length - 1] - height.value }] };
    });

    // ANIMATE to the current stage on a user action (snap / snapTo / release).
    // Reads snaps via ref so a measurement-only change does NOT re-fire here.
    useEffect(() => {
        if (dragging.current) return;
        if (uiSettled.current) { uiSettled.current = false; return; }
        const s = snapsRef.current;
        height.value = withTiming(s[Math.min(stageRef.current, s.length - 1)], { duration: 220 });
    }, [safeStage, settleTick, height]);

    // SETTLE INSTANTLY when measurements change the snap heights.
    useEffect(() => {
        if (dragging.current) return;
        height.value = snaps[Math.min(stageRef.current, snaps.length - 1)];
    }, [snaps, height]);

    useEffect(() => { onHeightChange?.(snaps[safeStage] + bottomOffset); }, [safeStage, snaps, onHeightChange, bottomOffset]);
    useEffect(() => { onStageChange?.(safeStage); }, [safeStage, onStageChange]);

    useImperativeHandle(ref, () => ({
        snapTo(idx: number) {
            const target = clamp(idx, 0, snapsRef.current.length - 1);
            if (target === stageRef.current) setSettleTick(t => t + 1);
            else setStage(target);
        },
    }), []);

    // ── SHEET-WIDE drag: one RNGH pan, worklet-driven (see map sheet) ────────
    const scrollY = useSharedValue(0);
    const onListScroll = useAnimatedScrollHandler((e) => { scrollY.value = e.contentOffset.y; });
    const startHSV = useSharedValue(0);
    const grabX = useSharedValue(0);
    const grabY = useSharedValue(0);
    const setDragging = (v: boolean) => { dragging.current = v; };
    const uiSettled = useRef(false);
    const settleFromUI = (idx: number) => {
        if (idx >= 0) { uiSettled.current = true; setStage(idx); }
        else setSettleTick(t => t + 1); // cancelled drag → animate back
    };
    const scrollRef = useRef<any>(null);
    const sheetGesture = useMemo(() => Gesture.Pan()
        .manualActivation(true)
        .simultaneousWithExternalGesture(scrollRef)
        .onBegin((e) => {
            'worklet';
            grabX.value = e.absoluteX;
            grabY.value = e.absoluteY;
        })
        .onTouchesMove((e, sm) => {
            'worklet';
            // ONLY an activation decision — once ACTIVE it is never re-judged
            // (failing mid-drag kills the gesture until a fresh touch).
            if (e.state === State.ACTIVE) return;
            const t = e.allTouches[0];
            if (!t) return;
            const dy = t.absoluteY - grabY.value;
            const dx = t.absoluteX - grabX.value;
            if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) { sm.fail(); return; }
            if (Math.abs(dy) < 4) return;                     // taps stay taps
            if (Math.abs(dy) <= Math.abs(dx) * 1.5) return;   // not vertical-dominant
            const sn = snapsSV.value;
            if (sn.length <= 1) { sm.fail(); return; }        // fixed bar — nothing to drag
            const atFull = height.value >= sn[sn.length - 1] - 2;
            if (!atFull || (dy > 0 && scrollY.value <= 1)) sm.activate();
            else sm.fail();                                    // at full, the list owns it
        })
        .onStart((e) => {
            'worklet';
            // Anchor at the ACTIVATION point (no pre-activation jump).
            startHSV.value = height.value + e.translationY;
            draggingSV.value = true;
            runOnJS(setDragging)(true);
        })
        .onUpdate((e) => {
            'worklet';
            const sn = snapsSV.value;
            const lo = sn[0], hi = sn[sn.length - 1];
            // RE-ANCHOR when the clamp engages so a direction reversal moves
            // immediately (the overshoot isn't swallowed).
            let h = startHSV.value - e.translationY;
            if (h > hi) { startHSV.value = hi + e.translationY; h = hi; }
            else if (h < lo) { startHSV.value = lo + e.translationY; h = lo; }
            height.value = h;
        })
        .onEnd((e) => {
            'worklet';
            // Snap to the nearest detent, nudged one stage by a flick.
            const sn = snapsSV.value;
            const h = height.value;
            let idx = 0, best = 1e9;
            for (let i = 0; i < sn.length; i++) { const d = Math.abs(sn[i] - h); if (d < best) { best = d; idx = i; } }
            if (e.velocityY < -500 && idx < sn.length - 1) idx++;
            else if (e.velocityY > 500 && idx > 0) idx--;
            height.value = withSpring(sn[idx], {
                velocity: -e.velocityY, damping: 30, stiffness: 280, mass: 0.8, overshootClamping: true,
            });
            // Seed the dock progress from the finger's FINAL position, then
            // ease to the landing stage — continuous in both directions.
            const last = sn[sn.length - 1];
            const prev = sn.length > 1 ? sn[sn.length - 2] : last;
            const hp = Math.min(1, Math.max(0, (h - prev) / Math.max(1, last - prev)));
            stagePSV.value = hp;
            stagePSV.value = withTiming(idx === sn.length - 1 ? 1 : 0, { duration: 240 });
            draggingSV.value = false;
            runOnJS(setDragging)(false);
            runOnJS(settleFromUI)(idx);
        })
        .onFinalize((_e, success) => {
            'worklet';
            if (success) return;
            const sn = snapsSV.value;
            const last = sn[sn.length - 1];
            const prev = sn.length > 1 ? sn[sn.length - 2] : last;
            stagePSV.value = Math.min(1, Math.max(0, (height.value - prev) / Math.max(1, last - prev)));
            draggingSV.value = false;
            runOnJS(setDragging)(false);
            runOnJS(settleFromUI)(-1);
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    , [height]);

    const maxSnap = snaps[snaps.length - 1];
    const listH = Math.max(0, maxSnap - SHEET_HANDLE_H - barH);
    const cornerR = concentricRadius(bottomInset, spacing.sm);
    const displayR = displayCornerRadius(bottomInset);
    const expandable = snaps.length > 1;

    // Dock-only draw styles (concentric bottom-corner growth + solid fade).
    const dockCornersStyle = useAnimatedStyle(() => {
        if (!dockAtLast) return {};
        const p = dockP.value;
        const r = Math.round(cornerR + (displayR - cornerR) * p);
        return { borderBottomLeftRadius: r, borderBottomRightRadius: r };
    });
    const glassFrameStyle = useAnimatedStyle(() => {
        const sn = snapsSV.value;
        const top = Math.max(0, sn[sn.length - 1] - height.value);
        if (!dockAtLast) return { top };
        const p = dockP.value;
        const r = Math.round(cornerR + (displayR - cornerR) * p);
        return { top, borderBottomLeftRadius: r, borderBottomRightRadius: r };
    });
    const solidBgStyle = useAnimatedStyle(() => ({ opacity: dockP.value }));

    // Float mode gets its side margins from LAYOUT; dock mode is laid out
    // edge-to-edge and scaled (so content there sits in an inset viewport).
    const rootPos = dockAtLast ? styles.rootDock : styles.rootFloat;
    const viewportInset = dockAtLast ? spacing.sm : 0;

    return (
        <GestureDetector gesture={sheetGesture}>
        <Animated.View
            exiting={exitSlide ? SlideOutDown.duration(240) : undefined}
            style={[styles.sheetRoot, rootPos, { height: maxSnap, borderRadius: cornerR }, outerStyle, dockCornersStyle]}
            pointerEvents="box-none"
        >
            {/* GLASS FRAME — sized to the VISIBLE sheet rect every frame; the
                material's rim wraps all real edges. Radii on the glass itself. */}
            <Animated.View style={[styles.glassFrame, {
                borderTopLeftRadius: cornerR, borderTopRightRadius: cornerR,
                borderBottomLeftRadius: cornerR, borderBottomRightRadius: cornerR,
            }, glassFrameStyle]}>
                <LiquidGlass fallback="blur" style={[StyleSheet.absoluteFillObject, { borderRadius: cornerR }]} />
                {dockAtLast && (
                    <Animated.View
                        pointerEvents="none"
                        style={[StyleSheet.absoluteFillObject, { backgroundColor: colors.pageBackground }, solidBgStyle]}
                    />
                )}
            </Animated.View>

            {/* PANEL (handle host) — slides transform-only with the body. */}
            <Animated.View style={[styles.panel, { height: maxSnap }, bodyStyle]} pointerEvents="box-none">
                <View style={styles.handleArea}>
                    {expandable && <View style={styles.handle} />}
                </View>
            </Animated.View>

            {/* Counter-scale wrapper (identity in float mode). */}
            <Animated.View style={[StyleSheet.absoluteFillObject, counterScaleStyle]} pointerEvents="box-none">
                {/* Body viewport: root-fixed, ends at the bar's top edge. */}
                <View
                    style={[styles.viewport, { left: viewportInset, right: viewportInset, height: Math.max(0, maxSnap - barH) }]}
                    pointerEvents="box-none"
                >
                    <Animated.View style={bodyStyle}>
                        <AnimatedGHScrollView
                            ref={scrollRef}
                            style={[styles.list, { height: listH, marginTop: SHEET_HANDLE_H }]}
                            contentContainerStyle={contentContainerStyle}
                            showsVerticalScrollIndicator={expandable && safeStage === snaps.length - 1}
                            scrollEnabled={expandable && safeStage === snaps.length - 1}
                            bounces={false}
                            overScrollMode="never"
                            onScroll={onListScroll}
                            scrollEventThrottle={16}
                            onContentSizeChange={(_, h) => onContentHeight?.(h)}
                        >
                            {children}
                        </AnimatedGHScrollView>
                    </Animated.View>
                </View>

                {/* Bar: transparent overlay pinned to the root's bottom —
                    always over the same panel glass (no seam line). */}
                <View
                    style={[styles.barOverlay, { paddingHorizontal: viewportInset }]}
                    onLayout={e => { setBarH(e.nativeEvent.layout.height); onBarHeight?.(e.nativeEvent.layout.height); }}
                >
                    {bar}
                </View>
            </Animated.View>
        </Animated.View>
        </GestureDetector>
    );
});

const makeStyles = (c: AppTheme) => StyleSheet.create({
    sheetRoot: {
        position: 'absolute', bottom: 0,
        overflow: 'hidden', // rounds the visible bottom cut of the sliding panel
    },
    // Dock mode: laid out edge-to-edge (docked geometry); the float look comes
    // from the root's scaleX + translateY (transform-only morph).
    rootDock: { left: 0, right: 0 },
    // Float mode: real margins — no scale involved.
    rootFloat: { left: spacing.sm, right: spacing.sm },
    // The glass frame — bottom-pinned; `top` (+ dock radii) animate with the
    // drag so its bounds = the visible sheet rect. Android rides the same
    // frame: the blur fallback gets a tinted body + hairline for contrast.
    glassFrame: {
        position: 'absolute', left: 0, right: 0, bottom: 0, overflow: 'hidden',
        backgroundColor: Platform.OS === 'android' ? c.cardBackground + 'F2' : 'transparent',
        ...(Platform.OS === 'android'
            ? { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(120,120,128,0.24)' as const }
            : null),
    },
    panel: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
    viewport: { position: 'absolute', top: 0, overflow: 'hidden' },
    barOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0 },
    handleArea: { height: SHEET_HANDLE_H, alignItems: 'center', justifyContent: 'center' },
    handle: { width: 44, height: 5, borderRadius: radius.pill, backgroundColor: c.border },
    list: { flexGrow: 0 },
});
