import { useEffect, useState, type ReactNode } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import {
    runOnJS,
    useAnimatedScrollHandler,
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
/** Maximum wash strength at the very top of the screen. Content dims
 *  progressively as it travels up from the header's bottom edge but is NEVER
 *  fully hidden — the physical screen edge clips it. (This mirrors iOS 26's
 *  "soft scroll edge effect": a progressive dim from the top edge to just past
 *  the bar chrome, content staying partially visible throughout.) */
const MAX_WASH = 0.75;
/** SVG gradient ids are resolved app-wide by react-native-svg — several stack
 *  screens keep their headers mounted at once, so each instance needs its own. */
let fadeIdCounter = 0;

/**
 * Adaptive top-of-screen chrome for the app's list screens — fully STATIC by
 * design, following the iOS 26 model:
 *
 *  - The big TITLE is NOT rendered here. It lives INSIDE the scrollable as its
 *    ListHeaderComponent (`<Animated.FlatList ListHeaderComponent={<ScreenHeading …/>} …`),
 *    so it scrolls 1:1 with the items natively — pixel-perfect, no scroll-sync
 *    code. As it travels up it dims under the fade wash and is clipped by the
 *    screen's top edge. (Overlay titles translated from scroll events were
 *    tried twice and always lagged: reanimated scroll→style sync on Android
 *    Fabric is a documented issue class — see reanimated #6992 / #7460.)
 *
 *  - This overlay renders only chrome that never moves: the floating back /
 *    action chips, an optional PINNED section (filter chips / search pill)
 *    parked directly under them, and the fade wash. The wash is anchored to
 *    the overlay's lowest section — its zero edge sits just below the pinned
 *    row (or the chrome row when there's no pinned section), so content fades
 *    exactly from the moment it slides under the header.
 *
 *  - There is NO native bar (headerShown: false). A `headerTransparent` native
 *    bar was tried and abandoned — Android react-native-screens renders the
 *    whole pushed screen semi-transparent when the header background is a
 *    translucent colour.
 *
 * Usage:
 *   const header = useCollapsingHeader();
 *   <CollapsingHeader controller={header} back right={<GlassIconButton …/>}
 *       pinned={<FilterBar … />} />
 *   <Animated.FlatList {...header.scroll}
 *       ListHeaderComponent={<ScreenHeading … />}
 *       contentContainerStyle={{ paddingTop: header.paddingTop, … }}>
 */
export function useCollapsingHeader() {
    // The workletized scroll handler exists for the begin-drag dock collapse
    // (a plain JS `onScrollBeginDrag` prop next to reanimated components would
    // downgrade the event stream) and to expose `offset` for any screen that
    // wants scroll-driven extras. Nothing in the header itself moves with it.
    const offset = useSharedValue(0);
    const collapseDock = () => { useBasketSession.getState().collapseDock?.(); };
    const onScroll = useAnimatedScrollHandler({
        onScroll: e => { offset.value = e.contentOffset.y; },
        onBeginDrag: () => { runOnJS(collapseDock)(); },
    });
    const [pinnedHeight, setPinnedHeight] = useState(0);
    const [topInset, setTopInset] = useState(0);
    return {
        offset,
        /** Spread onto the scrollable: `<Animated.FlatList {...header.scroll} … />`. */
        scroll: { onScroll, scrollEventThrottle: 16 },
        pinnedHeight,
        topInset,
        /** Reserve this as the scroll content's paddingTop. The in-list title
         *  renders after it, i.e. directly below the chrome / pinned section. */
        paddingTop: topInset + pinnedHeight + CONTENT_GAP,
        setPinnedHeight,
        setTopInset,
    };
}

export type CollapsingHeaderController = ReturnType<typeof useCollapsingHeader>;

export function CollapsingHeader({
    controller,
    pinned,
    background,
    back,
    right,
    headerOptions,
}: {
    controller: CollapsingHeaderController;
    /** Static section parked under the chrome row (filter chips / search pill). */
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
    // Where the pinned section (or, without one, the content zone) starts:
    // below the chrome row, or just the status inset when the screen has no
    // chrome. 0 for custom in-layout bars (the native bar occupies layout
    // space above the overlay).
    const restingTop = headerOptions
        ? 0
        : hasChrome
            ? (chromeH || insets.top + 52)
            : insets.top;
    const { pinnedHeight, setPinnedHeight, setTopInset } = controller;

    // Scroll padding: the chrome floats (no layout space), so the content must
    // clear it (and the pinned section) itself.
    useEffect(() => {
        setTopInset(restingTop);
    }, [restingTop, setTopInset]);

    const onPinnedLayout = (e: LayoutChangeEvent) =>
        setPinnedHeight(Math.round(e.nativeEvent.layout.height));
    const onChromeLayout = (e: LayoutChangeEvent) =>
        setChromeH(Math.round(e.nativeEvent.layout.height));

    // The wash's zero edge: just below the overlay's LOWEST static section —
    // the pinned row when present, else the chrome row. The CONTENT_GAP ramp
    // means items (and the outgoing in-list title) start dimming exactly as
    // they cross under the header.
    const headerBottom = restingTop + pinnedHeight;
    const [gradId] = useState(() => `chTopFade${++fadeIdCounter}`);
    return (
        <>
            <Stack.Screen options={headerOptions ?? { headerShown: false }} />
            <View style={styles.overlay} pointerEvents="box-none">
                {/* Fade wash — STATIC: transparent at the header's bottom edge,
                    growing toward the screen top, capped below full. */}
                <View pointerEvents="none" style={styles.fade}>
                    <Svg width="100%" height={Math.max(headerBottom + CONTENT_GAP, 1)}>
                        <Defs>
                            <SvgLinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                                <Stop offset="0" stopColor={bg} stopOpacity={String(MAX_WASH)} />
                                <Stop offset="1" stopColor={bg} stopOpacity="0" />
                            </SvgLinearGradient>
                        </Defs>
                        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradId})`} />
                    </Svg>
                </View>
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
                    {pinned != null ? (
                        <View onLayout={onPinnedLayout} pointerEvents="box-none">
                            {pinned}
                        </View>
                    ) : null}
                </View>
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    overlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, elevation: 10 },
    fade: { position: 'absolute', top: 0, left: 0, right: 0 },
    chromeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 8,
        paddingBottom: 6,
    },
});
