import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, Dimensions, Platform, BackHandler, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector, ScrollView, State } from 'react-native-gesture-handler';
import Animated, {
    SlideOutDown, runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useDerivedValue,
    useSharedValue, withDelay, withRepeat, withSequence, withSpring, withTiming,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { spacing, radius, withAlpha, useResolvedScheme, type AppTheme } from '../constants/theme';
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
    /** Current sheet height (for external drag bridges: read at drag start). */
    currentHeight(): number;
    /** Externally-driven live drag: set the height directly (clamped to the
     *  snap range). Used by sibling surfaces (the tab bar under the basket
     *  dock) whose touches this sheet's own pan can never see. */
    dragTo(height: number): void;
    /** Finish an external drag: snap to the nearest detent (velocity-nudged,
     *  same rules as the sheet's own pan release). */
    dragEnd(velocityY: number): void;
}

/** One page of the in-sheet nav stack (Find-My: stores → store → plan). */
export interface SheetPage {
    key: string;
    content: React.ReactNode;
    /** Per-page contentContainerStyle (falls back to the sheet-level prop). */
    contentContainerStyle?: StyleProp<ViewStyle>;
}

/** Spec: max stack depth 3 (stores → store → plan). Slots are PRE-CREATED so
 *  every page's ScrollView ref participates in the pan gesture from mount —
 *  the gesture is memoed on [height] only and never re-created per page. */
export const SHEET_MAX_PAGES = 3;

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
    /** Body content, revealed by expansion, inside the sheet's ScrollView.
     *  Ignored when `pages` is set. */
    children?: React.ReactNode;
    contentContainerStyle?: StyleProp<ViewStyle>;
    /** IN-SHEET NAV STACK (2.0 Find-My): the body becomes a horizontal page
     *  stack; the LAST entry is the active page. Push/pop by changing the
     *  array — the slide (and any resulting snap-height change) animates.
     *  Max depth SHEET_MAX_PAGES. NEVER stack GlassStageSheet instances —
     *  this is the supported way to nest sheet content. */
    pages?: SheetPage[];
    /** Android hardware back pops one page while depth > 1 (the caller owns
     *  the stack state, so popping = the caller trimming `pages`). */
    onPopPage?: () => void;
    onBarHeight?: (h: number) => void;
    onContentHeight?: (h: number) => void;
    colors: AppTheme;
    bottomInset: number;
    /** Map-sheet mode: the last snap docks edge-to-edge (scaleX morph,
     *  concentric corners, solid backdrop). */
    dockAtLast?: boolean;
    /** Tap handler for the grabber-pill area (drags still pan the sheet —
     *  the sheet gesture only activates on vertical movement, so taps fall
     *  through to this). Use for tap-to-expand on collapsed bars. */
    onHandlePress?: () => void;
    /** MERGE-WITH-BAR-BELOW mode (basket dock): square bottom corners and no
     *  bottom border, so the sheet reads as one entity with a bar it sits
     *  flush against (that bar squares its top corners in return). */
    flushBottom?: boolean;
    /** Light top-highlight rim riding the sheet's top edge (pass the same
     *  color the bar below uses so the merged silhouette keeps ONE lit top
     *  border — on the sheet, not the bar). */
    topRimColor?: string;
    /** Slide out when unmounted (sheets that come and go, e.g. map results). */
    exitSlide?: boolean;
    /** Grabber-area height (default SHEET_HANDLE_H). Slim it down for sheets
     *  whose whole underlying bar is draggable (the basket dock) so the strip
     *  peeking above the bar stays minimal. Include it in snap heights. */
    handleH?: number;
    /** Corner radius override (default: concentric from the display corner).
     *  Pass the bar's radius when merging so top and bottom corners match. */
    cornerRadius?: number;
    /** Bottom-corner radius while flushBottom (default 0 = squared into the
     *  bar). Raise it when the sheet expands DOWN OVER the bar so the sheet's
     *  own bottom corners take over the bar's silhouette. */
    flushBottomRadius?: number;
    /** Fade the GLASS out as the sheet approaches its collapsed snap, leaving
     *  only the grabber pill visible — collapsed, the sheet adds NOTHING to
     *  the bar below it; dragging pulls the glass out from behind the bar. */
    fadeGlassNearCollapse?: boolean;
    /** Pill position inside the grabber area (default 'center'). 'bottom'
     *  rests the pill on the sheet's collapsed bottom edge — i.e. directly ON
     *  the bar below a docked sheet instead of floating above it. */
    handleAlign?: 'center' | 'bottom';
    /** Raise the GLASS bottom edge by this many px while the sheet's layout
     *  (and pill) extend deeper: a docked sheet tucks behind its bar without
     *  double-tinting it — the glass ends EXACTLY at the bar's top edge, so
     *  dragging reads as the bar itself expanding vertically. */
    glassBottomInset?: number;
    /** Fired (on the JS thread) when the sheet's OWN pan starts/ends — lets a
     *  docked host merge its bar the instant a pill-drag begins, not only when
     *  the sheet settles. Bar-originated drags use the imperative bridge. */
    onActiveChange?: (active: boolean) => void;
    /** DISCOVERABILITY HINT: while the sheet sits COLLAPSED (stage 0) the grabber
     *  pill turns pink (colors.primary) and pulses on a slow cadence, cueing that
     *  the bar expands. Off by default — opt in per sheet that wants the nudge. */
    pulseHint?: boolean;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const GlassStageSheet = forwardRef<GlassStageSheetRef, Props>(function GlassStageSheet({
    snaps, initialStage = 0, onStageChange, onHeightChange,
    bar, children, contentContainerStyle, onBarHeight, onContentHeight,
    colors, bottomInset, dockAtLast = false, exitSlide = false,
    pages, onPopPage, onHandlePress, flushBottom = false, topRimColor,
    handleH = SHEET_HANDLE_H, cornerRadius, flushBottomRadius = 0,
    fadeGlassNearCollapse = false, handleAlign = 'center', glassBottomInset = 0,
    onActiveChange, pulseHint = false,
}, ref) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const isDark = useResolvedScheme() === 'dark';
    const [barH, setBarH] = useState(60);
    const [stage, setStage] = useState(initialStage);
    // Bumped on each user snap so the settle effect animates even to the SAME
    // stage (a small drag that releases back).
    const [settleTick, setSettleTick] = useState(0);

    const safeStage = Math.min(stage, snaps.length - 1);

    const height = useSharedValue(snaps[Math.min(initialStage, snaps.length - 1)]);
    // Collapsed-stage discoverability pulse (opt-in via `pulseHint`) — see below.
    const pillPulse = useSharedValue(0);
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
    // Leaving the expanded stage resets the body scroll: scrolling is DISABLED
    // below the last stage, so a retained offset stranded the panel header
    // above the viewport on the next expansion ("the sheet has no title") with
    // no way to scroll back up.
    useEffect(() => {
        if (safeStage < snaps.length - 1) {
            [scrollRef, slotRef1, slotRef2].forEach(r => r.current?.scrollTo?.({ y: 0, animated: false }));
        }
         
    }, [safeStage, snaps.length]);
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
    // flushBottom sheets sit ON their bar — no float lift (the lift is the
    // gap the merge exists to remove).
    const bottomOffset = flushBottom ? 0 : spacing.sm;

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

    // SETTLE when measurements change the snap heights — INSTANT for plain
    // measurement drift, ANIMATED when the change was caused by a page
    // push/pop (the Find-My slide and the height morph run together).
    useEffect(() => {
        if (dragging.current) return;
        const target = snaps[Math.min(stageRef.current, snaps.length - 1)];
        if (pageAnimRef.current) {
            pageAnimRef.current = false;
            height.value = withTiming(target, { duration: 240 });
        } else {
            height.value = target;
        }
    }, [snaps, height]);

    useEffect(() => { onHeightChange?.(snaps[safeStage] + bottomOffset); }, [safeStage, snaps, onHeightChange, bottomOffset]);
    useEffect(() => { onStageChange?.(safeStage); }, [safeStage, onStageChange]);

    useImperativeHandle(ref, () => ({
        snapTo(idx: number) {
            const target = clamp(idx, 0, snapsRef.current.length - 1);
            if (target === stageRef.current) setSettleTick(t => t + 1);
            else setStage(target);
        },
        currentHeight() {
            return height.value;
        },
        dragTo(h: number) {
            if (!dragging.current) { dragging.current = true; draggingSV.value = true; }
            const sn = snapsRef.current;
            height.value = clamp(h, sn[0], sn[sn.length - 1]);
        },
        dragEnd(velocityY: number) {
            const sn = snapsRef.current;
            const h = height.value;
            let idx = 0, best = 1e9;
            for (let i = 0; i < sn.length; i++) { const d = Math.abs(sn[i] - h); if (d < best) { best = d; idx = i; } }
            if (velocityY < -500 && idx < sn.length - 1) idx++;
            else if (velocityY > 500 && idx > 0) idx--;
            height.value = withSpring(sn[idx], {
                velocity: -velocityY, damping: 30, stiffness: 280, mass: 0.8, overshootClamping: true,
            });
            dragging.current = false;
            draggingSV.value = false;
            settleFromUI(idx);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), []);

    // ── SHEET-WIDE drag: one RNGH pan, worklet-driven (see map sheet) ────────
    const scrollY = useSharedValue(0);
    const onListScroll = useAnimatedScrollHandler((e) => { scrollY.value = e.contentOffset.y; });
    const startHSV = useSharedValue(0);
    const grabX = useSharedValue(0);
    const grabY = useSharedValue(0);
    const onActiveChangeRef = useRef(onActiveChange); onActiveChangeRef.current = onActiveChange;
    const setDragging = (v: boolean) => { dragging.current = v; onActiveChangeRef.current?.(v); };
    const uiSettled = useRef(false);
    const settleFromUI = (idx: number) => {
        if (idx >= 0) { uiSettled.current = true; setStage(idx); }
        else setSettleTick(t => t + 1); // cancelled drag → animate back
    };
    const scrollRef = useRef<any>(null);

    // ── IN-SHEET PAGE STACK ──────────────────────────────────────────────────
    // The plain-children path is just a 1-page stack (slot 0), so there is ONE
    // body code path. Slots are fixed (SHEET_MAX_PAGES): every slot's scroll
    // ref + scrollY exists from mount, letting the pan gesture reference them
    // all statically (it is memoed on [height] and never re-created).
    const pageList: SheetPage[] = pages && pages.length > 0
        ? pages.slice(-SHEET_MAX_PAGES)
        : [{ key: '__root', content: children }];
    if (__DEV__ && pages && pages.length > SHEET_MAX_PAGES) {
        console.warn(`[GlassStageSheet] pages deeper than ${SHEET_MAX_PAGES}; showing the last ${SHEET_MAX_PAGES}`);
    }
    const depth = pageList.length - 1;
    // scrollRef doubles as slot 0 (the legacy single-scroll path).
    const slotRef1 = useRef<any>(null);
    const slotRef2 = useRef<any>(null);
    const slotRefs = [scrollRef, slotRef1, slotRef2];
    const scrollY1 = useSharedValue(0);
    const scrollY2 = useSharedValue(0);
    const onListScroll1 = useAnimatedScrollHandler((e) => { scrollY1.value = e.contentOffset.y; });
    const onListScroll2 = useAnimatedScrollHandler((e) => { scrollY2.value = e.contentOffset.y; });
    // The gesture gates on the ACTIVE page's scroll offset.
    const depthIndexSV = useSharedValue(depth);
    useEffect(() => { depthIndexSV.value = depth; }, [depth, depthIndexSV]);
    // Horizontal slide between pages — animated on push/pop (Find-My).
    const depthSV = useSharedValue(depth);
    const mountedRef = useRef(false);
    // Per-slot content heights; the ACTIVE slot's height is what the parent
    // sees via onContentHeight (it computes snaps from it).
    const slotContentHRef = useRef<Record<number, number>>({});
    // Height changes caused by a page transition ANIMATE (the measurement
    // settle effect below is instant); this flag marks the next snaps-change
    // as page-driven.
    const pageAnimRef = useRef(false);
    useEffect(() => {
        if (!mountedRef.current) { mountedRef.current = true; return; }
        pageAnimRef.current = true;
        depthSV.value = withTiming(depth, { duration: 240 });
        // A fresh push starts at the top; popping PRESERVES the previous
        // page's offset (its slot kept its scroll position).
        if (depth > 0) slotRefs[depth]?.current?.scrollTo?.({ y: 0, animated: false });
        // Re-report the newly active page's content height so the parent can
        // recompute snaps for THIS page.
        const h = slotContentHRef.current[depth];
        if (h != null) onContentHeight?.(h);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [depth]);
    const [pageW, setPageW] = useState(SCREEN_W);
    const pageWSV = useSharedValue(SCREEN_W);
    const pagesRowStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: -depthSV.value * pageWSV.value }],
    }));
    // Android hardware back pops one page while the stack is deep.
    useEffect(() => {
        if (!pages || pages.length <= 1 || !onPopPage) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => { onPopPage(); return true; });
        return () => sub.remove();
    }, [pages, onPopPage]);

    const sheetGesture = useMemo(() => Gesture.Pan()
        .manualActivation(true)
        .simultaneousWithExternalGesture(scrollRef, slotRef1, slotRef2)
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
            const activeScrollY = [scrollY.value, scrollY1.value, scrollY2.value][depthIndexSV.value] ?? 0;
            if (!atFull || (dy > 0 && activeScrollY <= 1)) sm.activate();
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
    const listH = Math.max(0, maxSnap - handleH - barH);
    const cornerR = cornerRadius ?? concentricRadius(bottomInset, spacing.sm);
    const displayR = displayCornerRadius(bottomInset);
    const expandable = snaps.length > 1;

    // DISCOVERABILITY PULSE: while collapsed (stage 0) an expandable sheet's pill
    // glows pink and flashes on a ~2.7s cadence (grow + brighten, then a long
    // hold) so users notice it lifts. Stops the instant the sheet leaves stage 0.
    // FINITE — 4 cycles, not withRepeat(-1): an infinite repeat kept idle screens
    // animating forever (perf audit finding 3; same cap as DockedGlassSheet).
    // Each return to stage 0 re-arms a fresh hint; the sequence ends at 0.
    const pillHinting = pulseHint && expandable && safeStage === 0;
    useEffect(() => {
        pillPulse.value = pillHinting
            ? withRepeat(withSequence(
                withTiming(1, { duration: 460 }),
                withTiming(0, { duration: 460 }),
                withDelay(1800, withTiming(0, { duration: 0 })),
            ), 4, false)
            : withTiming(0, { duration: 200 });
    }, [pillHinting, pillPulse]);
    const pillStyle = useAnimatedStyle(() => ({
        opacity: 0.8 + 0.2 * pillPulse.value,
        transform: [{ scaleX: 1 + 0.5 * pillPulse.value }, { scaleY: 1 + 0.35 * pillPulse.value }],
    }));

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
        // Glass fades over the first 40px of rise from the collapsed snap.
        const opacity = fadeGlassNearCollapse
            ? Math.min(1, Math.max(0, (height.value - sn[0]) / 40))
            : 1;
        if (!dockAtLast) return { top, opacity };
        const p = dockP.value;
        const r = Math.round(cornerR + (displayR - cornerR) * p);
        return { top, opacity, borderBottomLeftRadius: r, borderBottomRightRadius: r };
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
            style={[
                styles.sheetRoot, rootPos, { height: maxSnap, borderRadius: cornerR },
                flushBottom && { borderBottomLeftRadius: flushBottomRadius, borderBottomRightRadius: flushBottomRadius },
                outerStyle, dockCornersStyle,
            ]}
            pointerEvents="box-none"
        >
            {/* GLASS FRAME — sized to the VISIBLE sheet rect every frame; the
                material's rim wraps all real edges. Radii on the glass itself. */}
            <Animated.View pointerEvents={flushBottom ? 'none' : 'auto'} style={[styles.glassFrame, glassBottomInset > 0 && { bottom: glassBottomInset }, {
                borderTopLeftRadius: cornerR, borderTopRightRadius: cornerR,
                borderBottomLeftRadius: cornerR, borderBottomRightRadius: cornerR,
            },
            flushBottom && { borderBottomLeftRadius: flushBottomRadius, borderBottomRightRadius: flushBottomRadius, borderBottomWidth: 0 },
            flushBottom && Platform.OS === 'android' && { backgroundColor: 'transparent', borderColor: colors.outlineVariant },
            topRimColor != null && { borderTopWidth: 1.2, borderTopColor: topRimColor },
            glassFrameStyle]}>
                {flushBottom && Platform.OS === 'android' ? (
                    // Merge mode: replicate the floating tab bar's EXACT glass
                    // recipe so sheet and bar are indistinguishable where they
                    // meet — the default near-opaque Android frame reads as a
                    // different material. The bar dropped its LIVE Android blur
                    // (perf audit finding 3 — dimezis re-renders the sibling
                    // hierarchy in software per invalidation), so this matches
                    // its new recipe: expo-blur's cheap translucent fallback
                    // (no experimentalBlurMethod) + the 0.8 surface tint.
                    <>
                        <BlurView
                            pointerEvents="none"
                            intensity={isDark ? 40 : 55}
                            tint={isDark ? 'dark' : 'light'}
                            style={StyleSheet.absoluteFillObject}
                        />
                        <View
                            pointerEvents="none"
                            style={[StyleSheet.absoluteFillObject, { backgroundColor: withAlpha(colors.surfaceContainer, 0.8) }]}
                        />
                    </>
                ) : (
                    <LiquidGlass fallback="blur" style={[StyleSheet.absoluteFillObject, { borderRadius: cornerR }]} />
                )}
                {dockAtLast && (
                    <Animated.View
                        pointerEvents="none"
                        style={[StyleSheet.absoluteFillObject, { backgroundColor: colors.pageBackground }, solidBgStyle]}
                    />
                )}
            </Animated.View>

            {/* PANEL (handle host) — slides transform-only with the body. */}
            <Animated.View style={[styles.panel, { height: maxSnap }, bodyStyle]} pointerEvents="box-none">
                <View style={[styles.handleArea, { height: handleH }, handleAlign === 'bottom' && styles.handleAreaBottom]}>
                    {expandable && (pillHinting
                        ? <Animated.View style={[styles.handle, { backgroundColor: colors.primary }, pillStyle]} />
                        : <View style={styles.handle} />)}
                </View>
            </Animated.View>

            {/* Counter-scale wrapper (identity in float mode). */}
            <Animated.View style={[StyleSheet.absoluteFillObject, counterScaleStyle]} pointerEvents="box-none">
                {/* Body viewport: root-fixed, ends at the bar's top edge. The
                    page-stack row slides horizontally inside it (plain children
                    = a 1-page stack, so this is the only body code path). */}
                <View
                    style={[styles.viewport, { left: viewportInset, right: viewportInset, height: Math.max(0, maxSnap - barH) }]}
                    pointerEvents="box-none"
                    onLayout={e => {
                        const w = e.nativeEvent.layout.width;
                        if (w > 0 && Math.abs(w - pageW) > 0.5) { setPageW(w); pageWSV.value = w; }
                    }}
                >
                    <Animated.View style={bodyStyle}>
                        <Animated.View style={[styles.pagesRow, { width: pageW * pageList.length }, pagesRowStyle]}>
                            {pageList.map((page, i) => {
                                const active = i === depth;
                                return (
                                    <View key={page.key} style={{ width: pageW }}>
                                        <AnimatedGHScrollView
                                            ref={slotRefs[i]}
                                            style={[styles.list, { height: listH, marginTop: handleH }]}
                                            contentContainerStyle={page.contentContainerStyle ?? contentContainerStyle}
                                            showsVerticalScrollIndicator={active && expandable && safeStage === snaps.length - 1}
                                            scrollEnabled={active && expandable && safeStage === snaps.length - 1}
                                            bounces={false}
                                            overScrollMode="never"
                                            onScroll={[onListScroll, onListScroll1, onListScroll2][i]}
                                            scrollEventThrottle={16}
                                            onContentSizeChange={(_, h) => {
                                                slotContentHRef.current[i] = h;
                                                if (i === depth) onContentHeight?.(h);
                                            }}
                                        >
                                            {page.content}
                                        </AnimatedGHScrollView>
                                    </View>
                                );
                            })}
                        </Animated.View>
                    </Animated.View>
                </View>

                {/* Bar: transparent overlay pinned to the root's bottom —
                    always over the same panel glass (no seam line). */}
                <View
                    pointerEvents="box-none"
                    style={[styles.barOverlay, { paddingHorizontal: viewportInset }]}
                    onLayout={e => { setBarH(e.nativeEvent.layout.height); onBarHeight?.(e.nativeEvent.layout.height); }}
                >
                    {bar}
                </View>
            </Animated.View>

            {/* Tap target for the grabber — rendered TOPMOST (the body's
                page-stack wrapper otherwise swallows taps over the handle)
                and sliding with the same transform as the handle itself.
                Drags still pan: the sheet gesture activates on vertical
                movement at the root before this Pressable completes a tap. */}
            {onHandlePress && (
                <Animated.View pointerEvents="box-none" style={[styles.panel, { height: maxSnap }, bodyStyle]}>
                    {/* Tap-to-expand target. hitSlop extends the touch zone
                        DOWN over the bar's top strip so a tucked pill (mostly
                        behind the bar) stays reliably tappable; the strip is
                        above the tab icons, so it never steals a tab tap. */}
                    <Pressable
                        style={[styles.handleArea, { height: handleH }]}
                        hitSlop={{ bottom: 22, left: 40, right: 40 }}
                        onPress={onHandlePress}
                    />
                </Animated.View>
            )}
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
    handleArea: { alignItems: 'center', justifyContent: 'center' },
    handleAreaBottom: { justifyContent: 'flex-end', paddingBottom: 3 },
    handle: { width: 44, height: 5, borderRadius: radius.pill, backgroundColor: c.border },
    list: { flexGrow: 0 },
    pagesRow: { flexDirection: 'row' },
});
