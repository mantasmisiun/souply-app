import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
    View, Text, Pressable, StyleSheet, Dimensions, Animated,
    type NativeSyntheticEvent, type NativeScrollEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { type AppTheme } from '../../constants/theme';
import { formatEuro } from '../../utils/formatCurrency';

export type WheelLogo = { chainId: number; logoUrl: string | null };
export type WheelItem = { key: string; logos: WheelLogo[]; sum: number; recommended: boolean; isAll?: boolean };

const ITEM_WIDTH = 118;
const SCREEN_W = Dimensions.get('window').width;
const SIDE_PAD = (SCREEN_W - ITEM_WIDTH) / 2;
const HEIGHT = 82;

type Props = {
    items: WheelItem[];
    selectedIndex: number;
    onSelectIndex: (i: number) => void;
    colors: AppTheme;
};

type Styles = ReturnType<typeof makeStyles>;

/**
 * Focus carousel. The centred option scales up into a raised pink pill; the
 * neighbours shrink to dim logo chips. The first option ("Visi") shows the
 * whole-map overview. Finite & fully rendered (≤11 cells) so a fast fling
 * never hits a blank cell; only the native-driver scrollX animates the cells.
 */
function CarouselCell({
    item, index, rank, scrollX, styles, colors, onPress,
}: {
    item: WheelItem;
    index: number;
    rank: number;
    scrollX: Animated.Value;
    styles: Styles;
    colors: AppTheme;
    onPress: (index: number) => void;
}) {
    const c = index * ITEM_WIDTH;
    const wide = [c - 2 * ITEM_WIDTH, c - ITEM_WIDTH, c, c + ITEM_WIDTH, c + 2 * ITEM_WIDTH];
    const scale = scrollX.interpolate({ inputRange: wide, outputRange: [0.6, 0.72, 1.1, 0.72, 0.6], extrapolate: 'clamp' });
    const opacity = scrollX.interpolate({ inputRange: wide, outputRange: [0.4, 0.55, 1, 0.55, 0.4], extrapolate: 'clamp' });
    const translateY = scrollX.interpolate({ inputRange: wide, outputRange: [10, 6, -6, 6, 10], extrapolate: 'clamp' });
    const focus = [c - ITEM_WIDTH * 0.55, c, c + ITEM_WIDTH * 0.55];
    const focusOpacity = scrollX.interpolate({ inputRange: focus, outputRange: [0, 1, 0], extrapolate: 'clamp' });

    return (
        <Animated.View style={[styles.cell, { opacity, transform: [{ translateY }, { scale }] }]}>
            <Pressable style={styles.pressable} onPress={() => onPress(index)}>
                <Animated.View style={[styles.card, { opacity: focusOpacity }]} />
                <View style={styles.cellInner}>
                    {item.isAll ? (
                        <>
                            <Ionicons name="map" size={16} color={colors.primary} />
                            <Text style={styles.label}>Visi</Text>
                        </>
                    ) : (
                        <>
                            <Text style={styles.rankNum}>#{rank}</Text>
                            <Text style={styles.price}>{formatEuro(item.sum)}</Text>
                        </>
                    )}
                </View>
            </Pressable>
        </Animated.View>
    );
}

export default function ResultsWheel({ items, selectedIndex, onSelectIndex, colors }: Props) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const scrollRef = useRef<any>(null);
    const n = items.length;
    const lastRealRef = useRef(Math.max(0, selectedIndex));
    const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scrollX = useRef(new Animated.Value(Math.max(0, selectedIndex) * ITEM_WIDTH)).current;

    const clamp = useCallback((i: number) => Math.max(0, Math.min(n - 1, i)), [n]);

    const onTapIndex = useCallback((i: number) => {
        scrollRef.current?.scrollTo?.({ x: i * ITEM_WIDTH, animated: true });
    }, []);

    const settle = useCallback((real: number) => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onSelectIndex(real);
    }, [onSelectIndex]);

    const onScrollListener = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (n === 0) return;
        const real = clamp(Math.round(e.nativeEvent.contentOffset.x / ITEM_WIDTH));
        if (real !== lastRealRef.current) {
            lastRealRef.current = real;
            Haptics.selectionAsync().catch(() => {});
        }
        if (settleTimer.current) clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => settle(real), 110);
    }, [n, clamp, settle]);

    const onScroll = useMemo(
        () => Animated.event(
            [{ nativeEvent: { contentOffset: { x: scrollX } } }],
            { useNativeDriver: true, listener: onScrollListener },
        ),
        [scrollX, onScrollListener],
    );

    useEffect(() => {
        if (n === 0 || selectedIndex < 0 || selectedIndex === lastRealRef.current) return;
        lastRealRef.current = selectedIndex;
        scrollRef.current?.scrollTo?.({ x: selectedIndex * ITEM_WIDTH, animated: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedIndex]);

    useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current); }, []);

    if (n === 0) return null;

    return (
        <View style={styles.wrap}>
            <Animated.ScrollView
                ref={scrollRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                snapToInterval={ITEM_WIDTH}
                snapToAlignment="start"
                decelerationRate="normal"
                onScroll={onScroll}
                scrollEventThrottle={16}
                contentOffset={{ x: Math.max(0, selectedIndex) * ITEM_WIDTH, y: 0 }}
                contentContainerStyle={{ paddingHorizontal: SIDE_PAD, alignItems: 'center' }}
            >
                {items.map((item, i) => (
                    <CarouselCell key={item.key} item={item} index={i} rank={i} scrollX={scrollX} styles={styles} colors={colors} onPress={onTapIndex} />
                ))}
            </Animated.ScrollView>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    wrap: {
        height: HEIGHT,
        backgroundColor: c.cardBackground,
        borderTopWidth: 1, borderTopColor: c.border,
        justifyContent: 'center',
    },
    cell: {
        width: ITEM_WIDTH, height: HEIGHT,
        alignItems: 'center', justifyContent: 'center',
    },
    pressable: {
        width: ITEM_WIDTH, height: HEIGHT,
        alignItems: 'center', justifyContent: 'center',
    },
    card: {
        position: 'absolute', top: 15, bottom: 15, left: 10, right: 10,
        borderRadius: 999,
        backgroundColor: (c as any).primaryMuted ?? c.surfaceMuted,
        borderWidth: 1.5, borderColor: c.primary,
        elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.18, shadowRadius: 5,
    },
    cellInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
    rankNum: { fontSize: 16, fontWeight: '800', color: c.textPrimary },
    price: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
    label: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
});
