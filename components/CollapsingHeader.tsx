import { useCallback, useState, type ReactNode } from 'react';
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
import { useTheme, typography } from '../constants/theme';
import { ScreenBackButton } from './ScreenBackButton';
import { useBasketSession } from '../state/basketSession';

/** The collapsed bar's row height (below the status-bar inset). Fits the 40dp
 *  GlassIconButton chrome with breathing room. */
const BAR_ROW_H = 48;

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
 *  - `headerOptions` instead renders a real NATIVE bar (the template cover
 *    screen); the custom bar is not drawn.
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
    };
}

export type CollapsingHeaderController = ReturnType<typeof useCollapsingHeader>;

export function CollapsingHeader({
    controller,
    background,
    back,
    right,
    smallTitle,
    headerOptions,
}: {
    controller: CollapsingHeaderController;
    /** Bar colour — defaults to the page background. */
    background?: string;
    /** Back chip in the top row. */
    back?: boolean;
    /** Right-side action(s) in the top row. */
    right?: ReactNode;
    /** The collapsed bar title that fades in as the large title scrolls off. */
    smallTitle?: string;
    /** Full Stack.Screen options override → a real native bar (template cover).
     *  The custom chrome row is not rendered. */
    headerOptions?: NativeStackNavigationOptions;
}) {
    const insets = useSafeAreaInsets();
    const colors = useTheme();
    const bg = background ?? colors.pageBackground;
    const { offset, titleHeight } = controller;

    const smallTitleStyle = useAnimatedStyle(() => {
        const h = titleHeight || 56;
        return { opacity: clamp((offset.value - (h - 16)) / 24, 0, 1) };
    });

    if (headerOptions) {
        return <Stack.Screen options={headerOptions} />;
    }

    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            {/* Flat opaque bar — NO shadow/elevation and NO hairline: content
                clips at its bottom edge and any sticky chips below read as one
                continuous pinned zone (no double separators). */}
            <View style={{ paddingTop: insets.top, backgroundColor: bg }}>
                <View style={styles.barRow}>
                    {back ? <ScreenBackButton /> : null}
                    <Animated.Text
                        numberOfLines={1}
                        style={[styles.barTitle, { color: colors.textPrimary }, smallTitleStyle]}
                    >
                        {smallTitle}
                    </Animated.Text>
                    {right ?? null}
                </View>
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    barRow: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 8, height: BAR_ROW_H,
    },
    barTitle: { flex: 1, marginHorizontal: 8, ...typography.barTitle },
});
