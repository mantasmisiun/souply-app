import { useEffect, useState, type ReactNode } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, {
    runOnJS,
    useAnimatedScrollHandler,
    useAnimatedStyle,
    useSharedValue,
} from 'react-native-reanimated';
import { Stack } from 'expo-router';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import { useTheme } from '../constants/theme';
import { ScreenBackButton } from './ScreenBackButton';
import { useBasketSession } from '../state/basketSession';

/** Breathing gap between the header's lowest section and the first list item. */
const CONTENT_GAP = 10;
/** Maximum wash strength at the very top of the screen. Items dim progressively
 *  as they travel up from the header's bottom edge but are NEVER fully hidden —
 *  the physical screen edge clips them. */
const MAX_WASH = 0.75;
/** SVG gradient ids are resolved app-wide by react-native-svg — several stack
 *  screens keep their headers mounted at once, so each instance needs its own. */
let fadeIdCounter = 0;

/**
 * Collapsing header for the app's list screens — and the single owner of the
 * top-of-screen chrome.
 *
 * There is NO native bar on these screens (headerShown: false): the back
 * chevron and right action render as floating chips in this overlay, over a
 * page-coloured gradient fade. (A `headerTransparent` native bar was tried and
 * abandoned — Android react-native-screens renders the whole pushed screen
 * semi-transparent when the header background is a translucent colour.)
 *
 * A `collapsing` section (e.g. <ScreenHeading/>) rides the scroll 1:1 — fading
 * as it crosses the chrome row and clipping at the screen's top edge — while an
 * optional `pinned` section (e.g. a filter bar) parks under the chrome. List
 * items dissolve into the gradient as they scroll up beneath it.
 *
 * Usage:
 *   const header = useCollapsingHeader();
 *   <CollapsingHeader controller={header} back right={<GlassIconButton …/>}
 *       collapsing={<ScreenHeading … />} pinned={<FilterBar … />} />
 *   <Animated.ScrollView {...header.scroll}               // or Animated.FlatList
 *       contentContainerStyle={{ paddingTop: header.paddingTop, … }}>
 *       {content}
 *   </Animated.ScrollView>
 */
export function useCollapsingHeader() {
    // Scroll offset via the workletized handler — runs on the UI thread for
    // Animated.* scrollables. (useScrollOffset + animatedRef was tried and
    // abandoned: it never attaches to Animated.FlatList on this setup — it only
    // spammed "animatedRef is not initialized" warnings — and it breaks under
    // Android RefreshControl's SwipeRefreshLayout wrapper regardless.)
    //
    // The begin-drag dock collapse ALSO lives here as a WORKLET: attaching a
    // plain JS `onScrollBeginDrag` prop next to a worklet handler downgrades
    // the whole scroll-event stream to the JS thread — that was the title
    // lagging/stuttering behind the items during drags.
    const offset = useSharedValue(0);
    const collapseDock = () => { useBasketSession.getState().collapseDock?.(); };
    const onScroll = useAnimatedScrollHandler({
        onScroll: e => { offset.value = e.contentOffset.y; },
        onBeginDrag: () => { runOnJS(collapseDock)(); },
    });
    const [collapsingHeight, setCollapsingHeight] = useState(0);
    const [pinnedHeight, setPinnedHeight] = useState(0);
    const [topInset, setTopInset] = useState(0);
    return {
        offset,
        /** Spread onto the scrollable: `<Animated.FlatList {...header.scroll} … />`. */
        scroll: { onScroll, scrollEventThrottle: 16 },
        collapsingHeight,
        pinnedHeight,
        topInset,
        /** Reserve this as the scroll content's paddingTop (overlay sits over it).
         *  Includes a small gap below the header's last section — the fade tail
         *  occupies it. */
        paddingTop: topInset + collapsingHeight + pinnedHeight + CONTENT_GAP,
        setCollapsingHeight,
        setPinnedHeight,
        setTopInset,
    };
}

export type CollapsingHeaderController = ReturnType<typeof useCollapsingHeader>;

export function CollapsingHeader({
    controller,
    collapsing,
    pinned,
    background,
    back,
    right,
    headerOptions,
}: {
    controller: CollapsingHeaderController;
    /** Rides the scroll (fades + clips at the screen top). */
    collapsing: ReactNode;
    /** Parks under the chrome row (optional). */
    pinned?: ReactNode;
    /** Fade colour — defaults to the page background. */
    background?: string;
    /** Floating back chip in the chrome row. */
    back?: boolean;
    /** Right-side action(s) in the chrome row. */
    right?: ReactNode;
    /** Full Stack.Screen options override (e.g. a search-mode bar). Forces a
     *  real native bar; the chrome row is not rendered. */
    headerOptions?: NativeStackNavigationOptions;
}) {
    const insets = useSafeAreaInsets();
    const colors = useTheme();
    // The fade colour — what the top of the screen dissolves into.
    const bg = background ?? colors.pageBackground;
    // Floating chip chrome (back / right) — only without a custom native bar.
    const hasChrome = !!(back || right) && !headerOptions;
    // Measured height of the chrome row (incl. its status-bar padding).
    const [chromeH, setChromeH] = useState(0);
    // The resting TOP of the collapsing band: below the chrome row, or just the
    // status inset when the screen has no chrome. 0 for custom in-layout bars
    // (the native bar occupies layout space above the overlay).
    const restingTop = headerOptions
        ? 0
        : hasChrome
            ? (chromeH || insets.top + 52)
            : insets.top;
    const { offset, collapsingHeight, pinnedHeight, setCollapsingHeight, setPinnedHeight, setTopInset } = controller;

    // Scroll padding: the chrome floats (no layout space), so the content must
    // clear it (or the status inset) itself.
    useEffect(() => {
        setTopInset(restingTop);
    }, [restingTop, setTopInset]);

    // TITLE: tracks the content 1:1 all the way PAST the chrome zone to the top
    // edge of the screen (travel = its own height + its resting offset), fading
    // along that full path — it dims as it crosses the chrome row and is fully
    // gone (and screen-clipped) at the top edge.
    const titleTravel = collapsingHeight + restingTop;
    const collapsingStyle = useAnimatedStyle(() => {
        const o = offset.value;
        const t = o > 0 ? Math.min(o, titleTravel) : 0;
        return {
            transform: [{ translateY: -t }],
            opacity: titleTravel > 0 ? 1 - t / titleTravel : 1,
        };
    });
    // PINNED: stops once the collapsing section is gone (classic clamp), so a
    // filter bar parks under the chrome.
    const pinnedStyle = useAnimatedStyle(() => {
        const o = offset.value;
        const collapse = o > 0 ? Math.min(o, collapsingHeight) : 0;
        return { transform: [{ translateY: -collapse }] };
    });
    const onCollapsingLayout = (e: LayoutChangeEvent) =>
        setCollapsingHeight(Math.round(e.nativeEvent.layout.height));
    const onPinnedLayout = (e: LayoutChangeEvent) =>
        setPinnedHeight(Math.round(e.nativeEvent.layout.height));
    const onChromeLayout = (e: LayoutChangeEvent) =>
        setChromeH(Math.round(e.nativeEvent.layout.height));

    // Fade block: page-coloured, spanning the WHOLE header zone (chrome + title
    // + pinned) with its dissolve tail at the header's BOTTOM edge — items
    // start fading the moment they cross under the header's lowest section,
    // whatever that is on a given screen (auto-sized from the measured parts).
    // It rides the same clamp as `pinned`, so while the title collapses the
    // tail tracks the header's shrinking bottom edge exactly.
    const headerBottom = restingTop + collapsingHeight + pinnedHeight;
    const [gradId] = useState(() => `chTopFade${++fadeIdCounter}`);
    const fadeBlockStyle = useAnimatedStyle(() => {
        const o = offset.value;
        const collapse = o > 0 ? Math.min(o, collapsingHeight) : 0;
        return { transform: [{ translateY: -collapse }] };
    });
    return (
        <>
            <Stack.Screen options={headerOptions ?? { headerShown: false }} />
            <View style={styles.overlay} pointerEvents="box-none">
                {/* Fade wash: TRANSPARENT at the header's bottom edge, growing
                    toward the screen top but capped below full — items dim
                    progressively as they travel up, stay faintly visible, and
                    are clipped only by the physical screen edge. Rides the
                    pinned clamp so its zero-edge tracks the shrinking header. */}
                <Animated.View pointerEvents="none" style={[styles.fade, fadeBlockStyle]}>
                    <Svg width="100%" height={Math.max(headerBottom, 1)}>
                        <Defs>
                            <SvgLinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                                <Stop offset="0" stopColor={bg} stopOpacity={String(MAX_WASH)} />
                                <Stop offset="1" stopColor={bg} stopOpacity="0" />
                            </SvgLinearGradient>
                        </Defs>
                        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradId})`} />
                    </Svg>
                </Animated.View>
                {/* Band wrapper: below the chrome (flow) or below the status
                    inset. Title and pinned translate INDEPENDENTLY — the title
                    rides with the content past the chrome to the screen edge;
                    pinned parks. */}
                <View style={{ paddingTop: hasChrome ? 0 : (headerOptions ? 0 : insets.top) }} pointerEvents="box-none">
                    {hasChrome ? (
                        <View
                            style={[styles.chromeRow, { paddingTop: insets.top + 6 }]}
                            onLayout={onChromeLayout}
                            pointerEvents="box-none"
                        >
                            {back ? <ScreenBackButton /> : <View />}
                            {right ?? <View />}
                        </View>
                    ) : null}
                    <Animated.View onLayout={onCollapsingLayout} style={[styles.band, collapsingStyle]}>
                        {collapsing}
                    </Animated.View>
                    {pinned != null ? (
                        <Animated.View onLayout={onPinnedLayout} style={[styles.band, pinnedStyle]}>
                            {pinned}
                        </Animated.View>
                    ) : null}
                </View>
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    overlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, elevation: 10 },
    fade: { position: 'absolute', top: 0, left: 0, right: 0 },
    // Chrome row draws ABOVE the travelling title (zIndex), so the title slides
    // UNDER the chips on its way out.
    chromeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 8,
        paddingBottom: 6,
        zIndex: 2,
    },
    band: { zIndex: 1 },
});
