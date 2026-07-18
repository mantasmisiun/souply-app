import React, {
    createContext, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
    type ReactNode,
} from 'react';
import type { SharedValue } from 'react-native-reanimated';
import {
    View, Pressable, StyleSheet, Platform, Dimensions,
    type LayoutChangeEvent, type StyleProp, type ViewStyle,
} from 'react-native';
import {
    Gesture, GestureDetector, ScrollView as GHScrollView, State,
} from 'react-native-gesture-handler';
import Animated, {
    interpolateColor, runOnJS, useAnimatedScrollHandler, useAnimatedStyle,
    useDerivedValue, useSharedValue, withSpring,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    useTheme, useResolvedScheme, spacing, radius, withAlpha, type AppTheme,
} from '../constants/theme';
import { concentricRadius, displayCornerRadius } from '../utils/displayCorners';

/** The sheet's 0→1 solid/dock progress (0 floating glass → 1 edge-to-edge
 *  solid), published to sheet CONTENT so cards can fade from transparent (they
 *  blend with the glass) to raised-white as the sheet docks. */
export const SheetSolidContext = createContext<SharedValue<number> | null>(null);

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
const COLLAPSED_INSET = 18;
// The floating dock's gap from every screen edge (left/right/bottom), shrinking
// to 0 at full. Trimmed 25% for a tighter float.
const COLLAPSED_MARGIN = Math.round((FLOAT_MARGIN + COLLAPSED_INSET) * 0.75);
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
    /** When this panel is stacked IN FRONT of another dock (the session list
     *  sheet over the tab-bar dock), its own shadow would double the back one
     *  while collapsed. Set this so the shadow starts at 0 (collapsed — the back
     *  dock casts it) and fades in with the sheet's expansion instead. */
    progressiveShadow?: boolean;
    /** Put the bar row at the TOP of the sheet (a title that RISES with the
     *  sheet as it expands) and reveal the sheet content BELOW it — a normal
     *  bottom-sheet layout, vs the default Find-My style (fixed bar at the
     *  bottom, content revealed above it). The bar↔content separator is dropped
     *  in this mode. */
    barAtTop?: boolean;
}

export const DockedGlassSheet = forwardRef<DockedSheetControls, Props>(function DockedGlassSheet({
    barRow, barRowHeight, sheet, colors: colorsProp, onBarHeight, onCollapsedClearance, blockScrollRef,
    progressiveShadow, barAtTop,
}, ref) {
    const themed = useTheme();
    const colors = colorsProp ?? themed;
    const isDark = useResolvedScheme() === 'dark';
    const insets = useSafeAreaInsets();
    const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);

    const hasSheet = sheet != null;
    const maxStage = sheet?.maxStage ?? 2;
    // Has a full detent (and, there, docks edge-to-edge). ALL sheets share ONE
    // geometry now: a symmetric floating gap when collapsed that shrinks equally
    // on the sides AND bottom, reaching an edge-to-edge dock at full — the bar
    // row stays screen-fixed throughout (see p / barRowStyle).
    const dockAtLast = hasSheet && maxStage >= 2;
    // Reserve the grabber strip ALWAYS — even a sheet-less bar keeps the space,
    // so the pill's presence/absence never shifts the bar content; only the
    // grabber itself toggles. The bar content is centred in (barRowHeight + peek)
    // so its top gap (holding the grabber) matches its bottom gap.
    const peek = PEEK;

    // ── STANDARD detents (fixed, content-independent) ─────────────────────────
    // Collapsed height brackets the bar row with an EQUAL peek above (grabber)
    // and below (gap), so the bar content is vertically centred in the dock.
    const collapsedH = barRowHeight + 2 * peek;
    const mediumH = Math.max(Math.round(SCREEN_H * MEDIUM_FRACTION), collapsedH + 160);
    // Full is edge-to-edge (clip bottom → 0), spanning up to just under the
    // status bar.
    const fullH = SCREEN_H - insets.top;

    // Distance from the screen bottom to the TOP of the (screen-fixed) bar row.
    // The collapsed dock floats a SYMMETRIC COLLAPSED_MARGIN from the left, right
    // AND bottom screen edges (no safe-area term — that made the bottom gap look
    // bigger than the sides). Identical for every sheet. Peek excluded.
    const collapsedClearance = COLLAPSED_MARGIN + barRowHeight + 2 * peek;
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

    // ── ONE progress: 0 collapsed → 1 full (edge-to-edge). Margins, bar-row
    //    counter-offset and content anchor all derive from it, so sides + bottom
    //    grow in lock-step and the bar row never budges. ────────────────────────
    const p = useDerivedValue(() => {
        const sn = snapsSV.value;
        const lo = sn[0], hi = sn[sn.length - 1];
        return hi > lo ? clamp((h.value - lo) / (hi - lo), 0, 1) : 0;
    });
    // Glass→solid + square-corner dock fades over the LAST segment (medium→full).
    const solidP = useDerivedValue(() => {
        const sn = snapsSV.value;
        if (sn.length < 3) return 0;
        const mid = sn[1], hi = sn[sn.length - 1];
        return hi > mid ? clamp((h.value - mid) / (hi - mid), 0, 1) : 0;
    });
    const cornerR = concentricRadius(insets.bottom, spacing.sm);
    const displayR = displayCornerRadius(insets.bottom);

    // ── Animated styles ───────────────────────────────────────────────────────
    // Symmetric margin: COLLAPSED_MARGIN when collapsed → 0 at full, applied to
    // left/right AND the (visible) bottom gap in lock-step. Bottom corners square
    // off into the display radius as it docks.
    const clipStyle = useAnimatedStyle(() => {
        const m = COLLAPSED_MARGIN * (1 - p.value);
        const r = Math.round(cornerR + (displayR - cornerR) * solidP.value);
        return {
            height: h.value,
            left: m,
            right: m,
            bottom: m, // symmetric with the sides; → 0 (edge-to-edge) at full
            borderBottomLeftRadius: r,
            borderBottomRightRadius: r,
            // The whole-clip edge outline (wraps the sheet AND the bar) fades out
            // as it docks — no border once edge-to-edge.
            borderColor: interpolateColor(solidP.value, [0, 1], [colors.outlineVariant, 'transparent']),
        };
    });
    // Bar row held in a FIXED screen box (width BAR_CONTENT_W): its left+bottom
    // offset counter-animate the clip's own shrinking left+bottom, so its screen
    // x AND y are constant at every detent — the glass grows around it.
    const barRowStyle = useAnimatedStyle(() => {
        const off = COLLAPSED_MARGIN * p.value;
        // The bar row is inset by `peek` on left/right/bottom (and the grabber
        // sits in the equal peek strip above) so the content's gap to every dock
        // edge matches. The content itself carries NO extra horizontal padding.
        return { left: peek + off, width: BAR_CONTENT_W - 2 * peek, bottom: peek + off };
    });
    // Separator + content ride above the bar row. The bar row's top edge is at
    // (peek + off + barRowHeight); the separator must clear it by another `peek`
    // so its gap to the bar content matches the bar's side/bottom peek — otherwise
    // it lands flush on the X/Basket buttons, which now fill the whole row.
    const barTopStyle = useAnimatedStyle(() => ({
        bottom: barRowHeight + 2 * peek + COLLAPSED_MARGIN * p.value,
    }));
    // ── barAtTop layout ───────────────────────────────────────────────────────
    // Bar row pinned to the TOP of the clip (just below the pill). Because the
    // clip grows UPWARD, a top-anchored row RISES with the sheet — it reads as
    // the sheet title moving up. `top` is a CONSTANT peek: the title's gap to
    // the sheet's top edge must never change during the drag. Horizontally the
    // row hugs the clip's edges (left/right: peek), so as the sheet widens
    // toward its edge-to-edge dock the row widens WITH it — the X and the
    // action button gradually spread outward through the stages.
    const barRowTopStyle = useAnimatedStyle(() => ({ left: peek, right: peek, top: peek }));
    // Content revealed BELOW the top bar: top rides just under the title (also a
    // constant gap) and the bottom clips EXACTLY at the sheet's bottom edge
    // (bottom: 0 of the clip — which is the screen bottom once docked at full).
    // Left/right hug the clip's edges like the title row, so the item rows
    // spread outward WITH the sheet as it widens through the stages. The opacity
    // ramp hides the content sliver that would otherwise peek out below the
    // title in the collapsed bar (the clip leaves `peek` of slack there).
    const contentBelowStyle = useAnimatedStyle(() => ({
        left: peek, right: peek,
        top: peek + barRowHeight, bottom: 0,
        opacity: clamp(p.value * 6, 0, 1),
    }));
    // Scroll fade under the title (barAtTop, full detent): items gradually fade
    // as they slide beneath the title row. Only meaningful once the sheet is
    // solid and actually scrolled (scroll is enabled at full only). Same edge
    // anchoring as the content it covers.
    const topFadeStyle = useAnimatedStyle(() => ({
        left: peek, right: peek,
        top: peek + barRowHeight,
        opacity: solidP.value * clamp(scrollY.value / 32, 0, 1),
    }));
    // Shadow opacity + elevation animate (color/radius/offset are static in the
    // clip style). A `progressiveShadow` panel casts NOTHING while collapsed (the
    // dock behind it already does) and fades its own shadow in as it expands;
    // every other panel keeps a constant barely-there shadow.
    const shadowStyle = useAnimatedStyle(() => {
        const k = progressiveShadow ? p.value : 1;
        return { shadowOpacity: (isDark ? 0.18 : 0.07) * k, elevation: 3 * k };
    });
    const solidStyle = useAnimatedStyle(() => ({ opacity: solidP.value }));
    // Top rim highlight is part of the edge decoration — fades out with the border.
    const rimStyle = useAnimatedStyle(() => ({ opacity: 1 - solidP.value }));
    const sepStyle = useAnimatedStyle(() => {
        const sn = snapsSV.value;
        const lo = sn[0], hi = sn[sn.length - 1];
        return { opacity: hi > lo ? clamp((h.value - lo) / Math.min(70, hi - lo), 0, 1) : 0 };
    });

    const onExpandTap = useCallback(() => {
        if (stageRef.current === 0) { setStageJS(1); springTo(1); }
        else { setStageJS(0); springTo(0); }
    }, [setStageJS, springTo]);

    // Scroll at the FULL detent whenever one exists (floating or docked).
    const scrollEnabled = hasSheet && maxStage >= 2 && stage === lastIdx;

    const panel = (
        <Animated.View
            style={[
                styles.clip,
                { borderRadius: cornerR },
                // left/right/bottom + bottom-radius all come from clipStyle (one
                // symmetric margin that shrinks to the edge-to-edge dock at full).
                clipStyle,
                shadowStyle,
            ]}
            pointerEvents={hasSheet ? 'auto' : 'box-none'}
        >
            {/* CONSTANT GLASS (blur + tint) + a SOLID backdrop that fades in at
                the full detent. */}
            <BlurView
                pointerEvents="none"
                intensity={isDark ? 40 : 35}
                tint={isDark ? 'dark' : 'light'}
                experimentalBlurMethod="dimezisBlurView"
                style={styles.glassFill}
            />
            <View pointerEvents="none" style={[styles.glassFill, styles.tint]} />
            {dockAtLast && (
                <Animated.View pointerEvents="none" style={[styles.glassFill, styles.solid, solidStyle]} />
            )}
            <Animated.View pointerEvents="none" style={[styles.rim, rimStyle]} />

            {/* CONTENT — default: Find-My reveal (below the pill, above the bar).
                barAtTop: revealed BELOW the top title bar. Scrolls only at full. */}
            {hasSheet && (
                <Animated.View
                    style={[styles.contentClip, barAtTop ? contentBelowStyle : [{ top: peek }, barTopStyle]]}
                    pointerEvents="box-none"
                >
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
                        <SheetSolidContext.Provider value={solidP}>
                            {sheet!.content}
                        </SheetSolidContext.Provider>
                    </AnimatedScroll>
                </Animated.View>
            )}

            {hasSheet && !barAtTop && (
                <Animated.View pointerEvents="none" style={[styles.separator, barTopStyle, sepStyle]} />
            )}

            {/* Scroll fade (barAtTop): a short surface→transparent gradient just
                below the title row, so items dissolve as they scroll under it. */}
            {hasSheet && barAtTop && (
                <Animated.View pointerEvents="none" style={[styles.topFade, topFadeStyle]}>
                    <Svg width="100%" height="100%">
                        <Defs>
                            <SvgLinearGradient id="dockTopFade" x1="0" y1="0" x2="0" y2="1">
                                <Stop offset="0" stopColor={colors.sheetSurface} stopOpacity="1" />
                                <Stop offset="1" stopColor={colors.sheetSurface} stopOpacity="0" />
                            </SvgLinearGradient>
                        </Defs>
                        <Rect x="0" y="0" width="100%" height="100%" fill="url(#dockTopFade)" />
                    </Svg>
                </Animated.View>
            )}

            {/* BAR ROW — held to a fixed centred box so the content never shifts
                as the glass widens/raises or the pill toggles. Default: pinned at
                the bottom. barAtTop: pinned near the top, rising with the sheet as
                a title. */}
            <Animated.View
                style={[styles.barRow, { height: barRowHeight }, barAtTop ? barRowTopStyle : barRowStyle]}
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
    // NO horizontal padding — the clip sets its own symmetric left/right/bottom
    // margin (clipStyle). Padding here would offset the sides but not the bottom,
    // making the side gaps wider than the bottom.
    wrap: {
        position: 'absolute', left: 0, right: 0, bottom: 0,
    },
    clip: {
        position: 'absolute',
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: c.outlineVariant,
        // Barely-there shadow — just a hint of lift. Color/radius/offset are
        // static; opacity + elevation come from the animated shadowStyle so a
        // stacked front sheet can fade its shadow in on expand.
        shadowColor: isDark ? '#000000' : '#5A2233',
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 2 },
    },
    glassFill: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: Platform.OS === 'android' ? undefined : 'transparent',
    },
    // Glass tint over the blur. Light: WHITE and VERY transparent (stages 1–2
    // share this constant tint — solid only fades in medium→full — so both read
    // as the same, markedly see-through white frosted panel). Dark keeps its
    // tinted container.
    tint: { backgroundColor: withAlpha(isDark ? c.surfaceContainer : '#FFFFFF', isDark ? 0.62 : 0.08) },
    // Opaque surface the glass fades INTO at full — WHITE in light (same as the
    // section cards; a soft card shadow does the separating there).
    solid: { backgroundColor: c.sheetSurface },
    rim: {
        ...StyleSheet.absoluteFillObject,
        borderTopWidth: 1.2,
        borderTopColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.9)',
    },
    contentClip: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
    // Height of the under-title scroll fade (barAtTop mode).
    topFade: { position: 'absolute', height: 32 },
    // The BAR separator (bar ↔ sheet content) — whisper-thin, subtle.
    separator: {
        position: 'absolute', left: spacing.lg, right: spacing.lg,
        height: StyleSheet.hairlineWidth, backgroundColor: c.dividerBar,
    },
    // Position (top/bottom) comes from the mode-specific animated style
    // (barRowStyle / barRowTopStyle); base only sets absolute + vertical centring.
    barRow: { position: 'absolute', justifyContent: 'center' },
    pillWrap: {
        position: 'absolute', top: 0, left: 0, right: 0,
        alignItems: 'center', paddingTop: 5,
    },
    pill: {
        width: PILL_W, height: PILL_H, borderRadius: radius.pill,
        // Light: a solid mid-gray — c.border washed out to invisible on the
        // near-transparent glass. Dark keeps the theme border tone.
        backgroundColor: isDark ? c.border : 'rgba(60,60,67,0.55)',
    },
});
