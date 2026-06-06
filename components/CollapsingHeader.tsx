import { useEffect, useState, type ReactNode } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, {
    useSharedValue,
    useAnimatedScrollHandler,
    useAnimatedStyle,
} from 'react-native-reanimated';
import { Stack } from 'expo-router';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../constants/theme';
import { glassHeaderOptions } from '../constants/navHeader';

/**
 * Collapsing header for the app's list screens — and the single owner of the
 * native bar decision.
 *
 * A `collapsing` section (e.g. <ScreenHeading/> with title + breadcrumb) hides
 * as the list scrolls up — it translates under the bar — while an optional
 * `pinned` section (e.g. a filter bar) stays put. It's an absolute overlay over
 * the list, driven by the list's NATIVE scroll offset and clamped at 0 on
 * overscroll, so the header never rubber-bands (no jitter).
 *
 * THE BAR RULE: pass `back` / `right`. If either is present, the titleless glass
 * bar is shown (via glassHeaderOptions). If NEITHER is present, the native bar
 * is hidden and this header takes the status-bar inset itself — so an empty bar
 * never wastes space.
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
    const offset = useSharedValue(0);
    // Drive the offset from the scroll handler (no animated ref) so it never
    // warns when the scrollable isn't mounted (loading states, inactive tabs).
    const onScroll = useAnimatedScrollHandler(e => {
        offset.value = e.contentOffset.y;
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
        /** Reserve this as the scroll content's paddingTop (overlay sits over it). */
        paddingTop: topInset + collapsingHeight + pinnedHeight,
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
    /** Hides on scroll (translates under the bar). */
    collapsing: ReactNode;
    /** Stays pinned under the bar (optional). */
    pinned?: ReactNode;
    background?: string;
    /** Glass back chevron in the bar. */
    back?: boolean;
    /** Right-side action(s) in the bar. */
    right?: ReactNode;
    /** Full Stack.Screen options override (e.g. a search-mode bar). Forces the
     *  bar to show. */
    headerOptions?: NativeStackNavigationOptions;
}) {
    const insets = useSafeAreaInsets();
    const colors = useTheme();
    const bg = background ?? colors.cardBackground;
    const barShown = !!(back || right || headerOptions);
    const { offset, collapsingHeight, setCollapsingHeight, setPinnedHeight, setTopInset } = controller;

    // Reserve the status-bar inset in the scroll padding only when there's no
    // native bar to provide it.
    useEffect(() => {
        setTopInset(barShown ? 0 : insets.top);
    }, [barShown, insets.top, setTopInset]);

    const style = useAnimatedStyle(() => {
        const o = offset.value;
        // Only collapse while scrolling DOWN into content; clamp at the
        // collapsing section's height (so the pinned section stays), and at 0
        // on overscroll (so the header doesn't follow the rubber-band).
        const collapse = o > 0 ? Math.min(o, collapsingHeight) : 0;
        return { transform: [{ translateY: -collapse }] };
    });
    const onCollapsingLayout = (e: LayoutChangeEvent) =>
        setCollapsingHeight(Math.round(e.nativeEvent.layout.height));
    const onPinnedLayout = (e: LayoutChangeEvent) =>
        setPinnedHeight(Math.round(e.nativeEvent.layout.height));

    return (
        <>
            <Stack.Screen options={headerOptions ?? glassHeaderOptions({ back, right, background: bg })} />
            {/* Overlay itself is TRANSPARENT — the background lives on the moving
                band below, so it travels up with the title/chips on scroll and
                doesn't leave an empty strip behind. */}
            <View style={styles.overlay}>
                {/* When there's no native bar, reserve the status-bar inset so the
                    title clears the notch/clock. */}
                <View style={{ paddingTop: barShown ? 0 : insets.top }}>
                    <Animated.View style={[{ backgroundColor: bg }, style]}>
                        <View onLayout={onCollapsingLayout}>{collapsing}</View>
                        {pinned != null ? <View onLayout={onPinnedLayout}>{pinned}</View> : null}
                    </Animated.View>
                </View>
                {/* Opaque status-bar cover (no native bar) so the collapsing title
                    slides up *under* it instead of over the clock. */}
                {!barShown ? (
                    <View pointerEvents="none" style={[styles.statusCover, { height: insets.top, backgroundColor: bg }]} />
                ) : null}
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    overlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, elevation: 10 },
    statusCover: { position: 'absolute', top: 0, left: 0, right: 0 },
});
