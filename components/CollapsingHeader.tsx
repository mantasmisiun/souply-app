import { useState, type ReactNode } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, {
    useAnimatedRef,
    useScrollViewOffset,
    useAnimatedStyle,
} from 'react-native-reanimated';

/**
 * Collapsing header for the app's list screens.
 *
 * A `collapsing` section (e.g. <ScreenHeading/> with title + breadcrumb) hides
 * as the list scrolls up — it translates under the nav bar — while an optional
 * `pinned` section (e.g. a filter bar) stays put. It's an absolute overlay over
 * the list, driven by the list's NATIVE scroll offset and clamped at 0 on
 * overscroll, so the header never rubber-bands (no jitter) and the list scrolls
 * under it natively.
 *
 * Usage:
 *   const header = useCollapsingHeader();
 *   <CollapsingHeader controller={header} background={colors.cardBackground}
 *       collapsing={<ScreenHeading … />} pinned={<FilterBar … />} />
 *   <Animated.ScrollView ref={header.scrollRef}            // or Animated.FlatList
 *       contentContainerStyle={{ paddingTop: header.paddingTop, … }}>
 *       {content}
 *   </Animated.ScrollView>
 */
export function useCollapsingHeader() {
    const scrollRef = useAnimatedRef<Animated.ScrollView>();
    const offset = useScrollViewOffset(scrollRef);
    const [collapsingHeight, setCollapsingHeight] = useState(0);
    const [pinnedHeight, setPinnedHeight] = useState(0);
    return {
        scrollRef,
        offset,
        collapsingHeight,
        pinnedHeight,
        /** Reserve this as the scroll content's paddingTop (overlay sits over it). */
        paddingTop: collapsingHeight + pinnedHeight,
        setCollapsingHeight,
        setPinnedHeight,
    };
}

export type CollapsingHeaderController = ReturnType<typeof useCollapsingHeader>;

export function CollapsingHeader({
    controller,
    collapsing,
    pinned,
    background,
}: {
    controller: CollapsingHeaderController;
    /** Hides on scroll (translates under the bar). */
    collapsing: ReactNode;
    /** Stays pinned under the bar (optional). */
    pinned?: ReactNode;
    background?: string;
}) {
    const { offset, collapsingHeight, setCollapsingHeight, setPinnedHeight } = controller;
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
        <Animated.View style={[styles.overlay, background ? { backgroundColor: background } : null, style]}>
            <View onLayout={onCollapsingLayout}>{collapsing}</View>
            {pinned != null ? <View onLayout={onPinnedLayout}>{pinned}</View> : null}
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    overlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, elevation: 10 },
});
