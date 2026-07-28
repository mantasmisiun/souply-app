import React, { createContext, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { StyleSheet, View, Pressable, Dimensions, BackHandler, Platform } from 'react-native';
import { Gesture, GestureDetector, ScrollView as GHScrollView, State } from 'react-native-gesture-handler';
import Animated, {
    runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useDerivedValue,
    useSharedValue, withSpring, withTiming, type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    GlassFill, makeGlassLayerStyles, GLASS_SHADOW_OPACITY, SheetSolidContext,
} from './DockedGlassSheet';
import { useTheme, useResolvedScheme, spacing, radius, type AppTheme } from '../constants/theme';
import { sheetCornerRadius } from './dock/sheetTokens';
import { SheetContent } from './dock/SheetContent';

/**
 * GlassSheet — a NON-DOCKED modal bottom sheet that shares the app's ONE glass
 * recipe with DockedGlassSheet (blur + tint + rim + shadow, via GlassFill +
 * makeGlassLayerStyles), so every sheet looks identical to the floating docks.
 *
 * Unlike DockedGlassSheet (a persistent bar that grows), this is a dismissible
 * overlay: a dim backdrop + a panel with TWO detents — it OPENS at medium
 * (stage 2), a drag lifts it to full (stage 3), and the inner ScrollView only
 * scrolls at full (below that an up-drag expands the sheet, the standard
 * bottom-sheet handoff). Dragging down past medium, tapping the backdrop, or
 * hardware-back dismisses it.
 *
 * It publishes SheetSolidContext (0 at medium → 1 at full) so any SheetCard /
 * DockActionCard inside animates glass→solid exactly like the docked sheets.
 *
 * Mount it only while open (so content-loading effects don't run when closed);
 * it animates itself IN on mount and calls onClose after animating OUT.
 */

/** True once the sheet has finished its open animation — content (e.g. bars) reads
 *  this to start its own animation AFTER the sheet settles, avoiding stutter. */
export const SheetOpenedContext = createContext<SharedValue<boolean> | null>(null);

/** Lets sheet CONTENT request the animated dismiss (an in-sheet X, a "Done"
 *  action). Calling the host's onClose directly would unmount the sheet mid-air
 *  and skip its slide-out — this runs the same path as backdrop / drag / back. */
export const SheetDismissContext = createContext<(() => void) | null>(null);

/** The dismiss for the sheet this component is rendered inside (null outside one). */
export function useSheetDismiss(): (() => void) | null {
    return React.useContext(SheetDismissContext);
}

const SCREEN_H = Dimensions.get('window').height;
const SNAP_SPRING = { damping: 30, stiffness: 280, mass: 0.9, overshootClamping: true } as const;
const PILL_W = 40;
const PILL_H = 5;

const AnimatedScroll = Animated.createAnimatedComponent(GHScrollView);

function clamp(v: number, lo: number, hi: number) {
    'worklet';
    return Math.max(lo, Math.min(hi, v));
}

export function GlassSheet({
    onClose,
    children,
    mediumFraction = 0.5,
    autoHeight = false,
}: {
    /** Called after the sheet has animated OUT — the host then unmounts it. */
    onClose: () => void;
    children: ReactNode;
    /** Medium-detent height as a fraction of the screen (default 0.5). Ignored
     *  when `autoHeight`. */
    mediumFraction?: number;
    /** Size the sheet to its CONTENT (a single detent) instead of medium/full —
     *  for short action sheets. Drag-down / backdrop dismiss; no drag-to-full. */
    autoHeight?: boolean;
}) {
    const colors = useTheme();
    const isDark = useResolvedScheme() === 'dark';
    const insets = useSafeAreaInsets();
    const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);

    const screenFullH = SCREEN_H - insets.top;
    // autoHeight: measure the content, cap at the screen. One detent (medium ===
    // ceiling), so solidP stays 0 (pure glass) and there's no drag-to-full.
    const [contentH, setContentH] = React.useState(0);
    const autoTarget = Math.min(contentH + PILL_H + 6 + spacing.md + insets.bottom + spacing.md, screenFullH);
    const mediumH = autoHeight ? (contentH > 0 ? autoTarget : 0) : Math.round(SCREEN_H * mediumFraction);
    // The ceiling detent — the screen-full for a normal sheet, the content height
    // for an autoHeight one (so up-drags clamp and only down-drags dismiss).
    const fullH = autoHeight ? mediumH : screenFullH;
    const snaps = useMemo(() => [mediumH, fullH], [mediumH, fullH]);

    const h = useSharedValue(0);
    const startH = useSharedValue(0);
    const backdrop = useSharedValue(0);
    // Latches true the instant a dismiss begins. The autoHeight re-settle below must
    // NOT spring a closing sheet back open — SavingsSheet & co. re-measure (async load
    // + bar animations) exactly as the user drags to dismiss, which otherwise cancels
    // the close (h springs back to mediumH, backdrop already gone, onClose never fires).
    const closing = useSharedValue(false);
    // Flips true when the open spring settles — content sequences its animations
    // off this so the bars don't animate while the sheet is still moving.
    const opened = useSharedValue(false);

    // Animate IN once the target is known (immediately for a fraction sheet; after
    // the first content layout for an autoHeight one).
    const openedRef = useRef(false);
    useEffect(() => {
        if (openedRef.current || mediumH <= 0) return;
        openedRef.current = true;
        h.value = withSpring(mediumH, SNAP_SPRING, (finished) => {
            'worklet';
            if (finished) opened.value = true;
        });
        backdrop.value = withTiming(1, { duration: 220 });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediumH]);

    // autoHeight sheets whose CONTENT grows after opening (async fetch) re-settle
    // to the new content height. Skips the very first settle (the open effect owns
    // it, and keeps the `opened` completion callback).
    const settledOnceRef = useRef(false);
    useEffect(() => {
        if (!openedRef.current || !autoHeight || mediumH <= 0) return;
        if (closing.value) return; // a dismiss is in flight — never spring back open
        if (!settledOnceRef.current) { settledOnceRef.current = true; return; }
        // Also mark opened here: a re-settle (content grew after an async fetch)
        // interrupts the open spring, so its completion fires finished=false and
        // never sets `opened` — set it on whichever spring actually settles.
        h.value = withSpring(mediumH, SNAP_SPRING, (finished) => {
            'worklet';
            if (finished) opened.value = true;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediumH]);

    const dismiss = useCallback(() => {
        closing.value = true;
        backdrop.value = withTiming(0, { duration: 180 });
        h.value = withTiming(0, { duration: 200 }, (done) => {
            if (done) runOnJS(onClose)();
        });
    }, [backdrop, h, onClose, closing]);

    // Hardware back dismisses (peels this layer before navigation).
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => { dismiss(); return true; });
        return () => sub.remove();
    }, [dismiss]);

    // ── Inner scroll (only at the full detent) ────────────────────────────────
    const scrollRef = useRef<any>(null);
    const scrollY = useSharedValue(0);
    const onScroll = useAnimatedScrollHandler((e) => { scrollY.value = e.contentOffset.y; });

    const snapEnd = useCallback((velocityY: number) => {
        'worklet';
        const cur = h.value;
        // Below the medium detent → dismiss (drag-down to close).
        if (cur < mediumH * 0.72 || velocityY > 900) {
            closing.value = true;
            backdrop.value = withTiming(0, { duration: 180 });
            h.value = withTiming(0, { duration: 200 }, (done) => { if (done) runOnJS(onClose)(); });
            return;
        }
        // Otherwise snap to the nearest of [medium, full] (velocity biases).
        let idx = Math.abs(fullH - cur) < Math.abs(mediumH - cur) ? 1 : 0;
        if (velocityY < -500) idx = 1;
        else if (velocityY > 500) idx = 0;
        h.value = withSpring(snaps[idx], { ...SNAP_SPRING, velocity: -velocityY });
    }, [h, backdrop, mediumH, fullH, snaps, onClose, closing]);

    const pan = useMemo(() => Gesture.Pan()
        .manualActivation(true)
        .simultaneousWithExternalGesture(scrollRef)
        .onTouchesMove((e, sm) => {
            'worklet';
            if (e.state === State.ACTIVE) return;
            const t = e.allTouches[0];
            if (!t) return;
            const atFull = h.value >= fullH - 2;
            // At full: the list owns UPWARD drags; a downward drag at the list's
            // top hands off to collapse the sheet. Below full: the sheet owns all.
            if (!atFull) { sm.activate(); return; }
            // crude: activate on downward intent when scrolled to top
            if (scrollY.value <= 1) sm.activate();
            else sm.fail();
        })
        .onStart(() => { 'worklet'; startH.value = h.value; })
        .onUpdate((e) => {
            'worklet';
            let nh = startH.value - e.translationY;
            if (nh > fullH) nh = fullH;
            h.value = nh;
        })
        .onEnd((e) => { 'worklet'; snapEnd(e.velocityY); }),
        [h, startH, fullH, scrollY, snapEnd]);

    // Progress 0 (medium) → 1 (full): drives solid fade + rim + scroll enable.
    const solidP = useDerivedValue(() =>
        fullH > mediumH ? clamp((h.value - mediumH) / (fullH - mediumH), 0, 1) : 0);

    const cornerR = sheetCornerRadius(insets.bottom);

    const panelStyle = useAnimatedStyle(() => ({ height: h.value }));
    const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
    const solidStyle = useAnimatedStyle(() => ({ opacity: solidP.value }));
    const rimStyle = useAnimatedStyle(() => ({ opacity: 1 - solidP.value }));
    // Bottom corners square off as it reaches full (docks edge-to-edge).
    const clipStyle = useAnimatedStyle(() => ({
        borderBottomLeftRadius: cornerR * (1 - solidP.value),
        borderBottomRightRadius: cornerR * (1 - solidP.value),
    }));

    // Scroll only at full — matches the "stage 3 enables scroll" requirement.
    // Fire the JS setState ONLY when crossing the threshold (a shared-value latch),
    // never per-frame during the drag.
    const [scrollOn, setScrollOn] = React.useState(false);
    const enableScroll = useCallback((on: boolean) => setScrollOn(on), []);
    const scrollArmed = useSharedValue(false);
    useDerivedValue(() => {
        const on = h.value >= fullH - 2;
        if (on !== scrollArmed.value) {
            scrollArmed.value = on;
            runOnJS(enableScroll)(on);
        }
    });

    return (
        <View style={styles.root} pointerEvents="box-none">
            <Animated.View style={[styles.backdrop, backdropStyle]}>
                <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
            </Animated.View>

            <GestureDetector gesture={pan}>
                <Animated.View
                    style={[styles.panel, { borderTopLeftRadius: cornerR, borderTopRightRadius: cornerR }, panelStyle, clipStyle]}
                >
                    <GlassFill isDark={isDark} style={styles} />
                    <Animated.View pointerEvents="none" style={[styles.glassFill, styles.solid, solidStyle]} />
                    <Animated.View pointerEvents="none" style={[styles.rim, rimStyle]} />

                    {/* Grabber */}
                    <View style={styles.pillWrap} pointerEvents="none"><View style={styles.pill} /></View>

                    <AnimatedScroll
                        ref={scrollRef}
                        style={styles.scroll}
                        contentContainerStyle={{ paddingBottom: autoHeight ? 0 : insets.bottom + spacing.xl }}
                        scrollEnabled={scrollOn}
                        showsVerticalScrollIndicator={scrollOn}
                        // A sheet with a text field (the recipe-URL sheet) would
                        // otherwise lose the first tap on its paste/submit buttons:
                        // the default 'never' makes THIS scroll swallow any tap that
                        // dismisses the keyboard, before the child ever sees it.
                        keyboardShouldPersistTaps="handled"
                        onScroll={onScroll}
                        scrollEventThrottle={16}
                        bounces={false}
                        overScrollMode="never"
                    >
                        <SheetSolidContext.Provider value={solidP}>
                            <SheetOpenedContext.Provider value={opened}>
                              <SheetDismissContext.Provider value={dismiss}>
                                {/* The measured box wraps SheetContent so an
                                    autoHeight sheet sizes to content PLUS the
                                    shared inset. Content owns no padding of its
                                    own — see components/dock/SheetContent.tsx. */}
                                <View onLayout={autoHeight ? (e => setContentH(e.nativeEvent.layout.height)) : undefined}>
                                    <SheetContent>{children}</SheetContent>
                                </View>
                              </SheetDismissContext.Provider>
                            </SheetOpenedContext.Provider>
                        </SheetSolidContext.Provider>
                    </AnimatedScroll>
                </Animated.View>
            </GestureDetector>
        </View>
    );
}

const makeStyles = (c: AppTheme, isDark: boolean) => {
    const glass = makeGlassLayerStyles(c, isDark);
    return StyleSheet.create({
        root: { ...StyleSheet.absoluteFill, zIndex: 30, elevation: 30, justifyContent: 'flex-end' },
        backdrop: { ...StyleSheet.absoluteFill, backgroundColor: c.overlayBackdrop },
        panel: {
            position: 'absolute', left: 0, right: 0, bottom: 0,
            overflow: 'hidden',
            ...glass.clipEdge,
            shadowOpacity: isDark ? GLASS_SHADOW_OPACITY.dark : GLASS_SHADOW_OPACITY.light,
            // Android: 0 — see DockedGlassSheet's shadowStyle. An elevation
            // shadow under a translucent, overflow-hidden clip washes grey
            // inward from the edges now that Android has no live blur.
            elevation: Platform.OS === 'android' ? 0 : 3,
        },
        glassFill: glass.glassFill,
        tint: glass.tint,
        tintOverBlur: glass.tintOverBlur,
        solid: glass.solid,
        rim: glass.rim,
        scroll: { flex: 1, marginTop: spacing.md },
        pillWrap: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', paddingTop: 6, zIndex: 2 },
        pill: {
            width: PILL_W, height: PILL_H, borderRadius: radius.pill,
            backgroundColor: isDark ? c.border : 'rgba(60,60,67,0.55)',
        },
    });
};
