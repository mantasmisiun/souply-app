import { useCallback, useId, useState, type ComponentProps, type ReactNode } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, {
    runOnJS,
    useAnimatedScrollHandler,
    useAnimatedStyle,
    useSharedValue,
} from 'react-native-reanimated';
import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import { useTheme, typography } from '../constants/theme';
import { ScreenBackButton } from './ScreenBackButton';
import { useBasketSession } from '../state/basketSession';

/** The collapsed bar's row height (below the status-bar inset). Fits the 40dp
 *  GlassIconButton chrome with breathing room. */
const BAR_ROW_H = 48;

/** Depth of the dissolve under the pinned chrome. Enough to fade a row of text;
 *  shallow enough that it never veils content that is still meant to be read. */
const FADE_H = 20;
/** The strip is pulled UP by this much so it overlaps the chrome above instead
 *  of butting against it — fractional insets/pinned heights otherwise round to a
 *  1px transparent seam. Its top gradient stop is opaque, so the overlap is
 *  invisible while the gap was not. */
const FADE_OVERLAP = 1;

function clamp(v: number, lo: number, hi: number) {
    'worklet';
    return Math.max(lo, Math.min(hi, v));
}

/**
 * The app's unified iOS-26 collapsing header for list screens.
 *
 *  - A DEFINED opaque top bar in real layout: back (if any) · a small title that
 *    FADES in as the large `ScreenHeading` scrolls off · right action (if any).
 *    The scrollable sits BELOW the bar, so the large title clips at its bottom
 *    edge. Filter chips are NATIVE sticky headers INSIDE the scrollable
 *    (stickyHeaderIndices / SectionList) — not here.
 *  - The small title is opacity-only off the `offset` shared value (a fade is
 *    lag-tolerant; a position-synced overlay title lagged on Android Fabric —
 *    reanimated #6992 / #7460).
 *  - The bar is ALWAYS this custom in-layout row — never a native header. A
 *    cover-coloured screen (the recipe detail) passes `background` +
 *    `titleColor` instead of forking to a native bar; keeping every host on
 *    the same chrome is what lets a DockedGlassSheet expand over it to the
 *    very top (the sheet's full detent is the whole window below the status
 *    bar, and a native bar would sit in the navigator's own container where
 *    screen content can never paint over it).
 *
 * Usage:
 *   const header = useCollapsingHeader();
 *   <CollapsingHeader controller={header} back right={…} smallTitle={t('…')} />
 *   <Animated.ScrollView {...header.scroll} stickyHeaderIndices={chips ? [1] : undefined}
 *       contentContainerStyle={{ paddingTop: 0, … }}>
 *       <ScreenHeading … onLayout={header.onTitleLayout} />
 *       {chips}      // index 1 — native sticky
 *       {…content}
 *   </Animated.ScrollView>
 */
export function useCollapsingHeader() {
    // The workletized scroll handler drives the small-title fade off `offset`,
    // and collapses the basket dock on begin-drag (a plain JS `onScrollBeginDrag`
    // next to reanimated components would downgrade the event stream).
    const offset = useSharedValue(0);
    const collapseDock = () => { useBasketSession.getState().collapseDock?.(); };
    const onScroll = useAnimatedScrollHandler({
        onScroll: e => { offset.value = e.contentOffset.y; },
        onBeginDrag: () => { runOnJS(collapseDock)(); },
    });
    // The large title's measured height → when to fade the small title in.
    const [titleHeight, setTitleHeight] = useState(0);
    // Height of a row PINNED under the bar (filter chips). The dissolve belongs
    // below it: the pinned row is chrome, and washing it would dim controls the
    // user is still meant to read and tap.
    const [pinnedHeight, setPinnedHeight] = useState(0);
    const onPinnedLayout = useCallback((e: LayoutChangeEvent) => {
        const h = Math.round(e.nativeEvent.layout.height);
        if (h > 0) setPinnedHeight(h);
    }, []);
    const onTitleLayout = useCallback((e: LayoutChangeEvent) => {
        const h = Math.round(e.nativeEvent.layout.height);
        if (h > 0) setTitleHeight(h);
    }, []);
    return {
        offset,
        /** Spread onto the scrollable: `<Animated.FlatList {...header.scroll} … />`. */
        scroll: { onScroll, scrollEventThrottle: 16 },
        titleHeight,
        setTitleHeight,
        onTitleLayout,
        /** Spread onto a row pinned under the bar so the dissolve clears it. */
        pinnedHeight,
        onPinnedLayout,
    };
}

export type CollapsingHeaderController = ReturnType<typeof useCollapsingHeader>;

/**
 * THE nav-bar title text — one identity (typography.barTitle, single line
 * with a tail ellipsis, textPrimary ink) for every screen's top bar.
 * Screens must not hand-roll a bar title: the font drifting apart per screen
 * is exactly the bug this component exists to prevent.
 *
 * Optional props cover the covered-bar screens without forking:
 *   `color` — ink override for a bar whose background is a cover colour
 *             (CollapsingHeader's `titleColor` — the recipe screen flips
 *             white/near-black by the cover's contrast);
 *   `style` — layout constraints and/or an ANIMATED style (the scroll-keyed
 *             opacity fade). Rendered via Animated.Text so an animated
 *             opacity is accepted directly.
 */
export function BarTitle({
    title,
    color,
    style,
}: {
    title?: string;
    color?: string;
    style?: ComponentProps<typeof Animated.Text>['style'];
}) {
    const colors = useTheme();
    return (
        <Animated.Text
            numberOfLines={1}
            style={[styles.barTitleText, { color: color ?? colors.textPrimary }, style]}
        >
            {title}
        </Animated.Text>
    );
}

export function CollapsingHeader({
    controller,
    background,
    back,
    onBack,
    right,
    smallTitle,
    titleColor,
}: {
    controller: CollapsingHeaderController;
    /** Bar colour — defaults to the page background. Supplying one also turns
     *  the under-bar dissolve strip OFF: a cover-coloured bar over page-coloured
     *  content would paint the strip as a visible wash across the top of the
     *  body (it greyed the recipe's cover title); a distinct bar keeps a hard
     *  bottom edge instead. */
    background?: string;
    /** Back chip in the top row. */
    back?: boolean;
    /** Override the default pop — e.g. return to a specific tab. */
    onBack?: () => void;
    /** Right-side action(s) in the top row. */
    right?: ReactNode;
    /** The collapsed bar title that fades in as the large title scrolls off. */
    smallTitle?: string;
    /** Small-title ink for a bar whose `background` is a cover colour — the
     *  recipe screen flips white/near-black by the cover's contrast (inkOn).
     *  The back chip and `right` actions keep their own ink (the chevron sits
     *  in its own circle, so it stays app-pink regardless of the cover). */
    titleColor?: string;
}) {
    const insets = useSafeAreaInsets();
    const colors = useTheme();
    const bg = background ?? colors.pageBackground;
    const { offset, titleHeight, pinnedHeight } = controller;
    // Unique per mounted header: during a push two screens are alive at once, and
    // a shared SVG gradient id makes one of them resolve to the other's def.
    const fadeId = useId().replace(/:/g, '');

    const smallTitleStyle = useAnimatedStyle(() => {
        const h = titleHeight || 56;
        return { opacity: clamp((offset.value - (h - 16)) / 24, 0, 1) };
    });

    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            {/* Flat opaque bar — NO shadow/elevation and NO hairline: content
                clips at its bottom edge and any sticky chips below read as one
                continuous pinned zone (no double separators). */}
            <View style={{ paddingTop: insets.top, backgroundColor: bg }}>
                <View style={styles.barRow}>
                    {back ? <ScreenBackButton onPress={onBack} /> : null}
                    <BarTitle title={smallTitle} color={titleColor} style={[styles.barTitleLayout, smallTitleStyle]} />
                    {right ?? null}
                </View>
            </View>

            {/* THE DISSOLVE. The bar (and any row pinned under it) is real layout,
                so a row scrolling up used to be guillotined at an invisible line.
                This strip sits directly BELOW that chrome and runs from the page
                colour to transparent, so a row dissolves as it slides behind the
                bar instead of being cut mid-glyph.

                Deliberately below the chrome, never over it: the bar's title,
                back button and any pinned filter chips must stay at full
                strength — they are controls, not content. pointerEvents none so
                it can never swallow a tap meant for the list.

                DEFAULT (page-coloured) bars only. On those the strip is
                invisible until content actually slides under it — same colour
                over same colour. A bar with an explicit `background` (the
                recipe's cover colour) sits on content of a DIFFERENT colour,
                so the same strip paints a visible cover-coloured wash over the
                first 20px of the body — it dimmed the top of the recipe's
                cover title. Such a bar is a deliberately distinct band; a hard
                bottom edge IS its design, so it gets no dissolve. */}
            {background == null && (
                <View
                    style={[styles.fade, {
                        // Overlap the chrome above by 1px. `insets.top` and the
                        // measured `pinnedHeight` are fractional dp, so the
                        // chrome's bottom edge and this strip's top edge round to
                        // DIFFERENT physical pixels — leaving a 1px fully
                        // transparent seam that the list scrolls through (only
                        // visible against saturated content, e.g. a red product
                        // image). The first gradient stop is opaque chrome colour,
                        // so overlapping is invisible; a gap is not.
                        top: insets.top + BAR_ROW_H + pinnedHeight - FADE_OVERLAP,
                        height: FADE_H + FADE_OVERLAP,
                    }]}
                    pointerEvents="none"
                >
                    <Svg width="100%" height={FADE_H + FADE_OVERLAP}>
                        <Defs>
                            <SvgLinearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
                                {/* Starts at the chrome's own colour — no seam. */}
                                <Stop offset="0" stopColor={bg} stopOpacity="1" />
                                <Stop offset="0.5" stopColor={bg} stopOpacity="0.6" />
                                <Stop offset="1" stopColor={bg} stopOpacity="0" />
                            </SvgLinearGradient>
                        </Defs>
                        <Rect x="0" y="0" width="100%" height={FADE_H + FADE_OVERLAP} fill={`url(#${fadeId})`} />
                    </Svg>
                </View>
            )}
        </>
    );
}

const styles = StyleSheet.create({
    // Above the scrollable on BOTH platforms: iOS honours zIndex, Android needs
    // elevation for the same stacking, or the list paints over the dissolve.
    fade: { position: 'absolute', left: 0, right: 0, height: FADE_H, zIndex: 10, elevation: 10 },
    barRow: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 8, height: BAR_ROW_H,
    },
    // BarTitle owns the TEXT identity; this is only the custom row's layout.
    barTitleLayout: { flex: 1, marginHorizontal: 8 },
    barTitleText: { ...typography.barTitle },
});
