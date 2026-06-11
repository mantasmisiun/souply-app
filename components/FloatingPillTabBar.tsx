import { useEffect, useState } from 'react';
import { View, Pressable, Text, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useTheme, spacing, radius, elevation, typography, motion } from '../constants/theme';

// Width/height of the Material-3 "active indicator" pill that sits behind the
// selected tab's icon and slides between tabs.
const INDICATOR_WIDTH = 56;
const INDICATOR_HEIGHT = 34;

/**
 * Bottom clearance (above the safe-area inset) that screens must pad their
 * scroll content by so the last item clears this floating bar. The bar is
 * `position: absolute`, so it reserves no layout space and react-navigation's
 * measured tab-bar height is unreliable — `useSafeBottomTabBarHeight` returns
 * this constant (+ inset) on Android instead. = bar height (~71) + a small gap.
 */
export const FLOATING_TAB_BAR_CLEARANCE = 80;

/**
 * Android floating pill tab bar. Replaces the flat bottom bar with a rounded,
 * elevated bar inset from the screen edges, plus a sliding pill indicator
 * behind the active icon (which is simultaneously the iOS-26 trend and native
 * Material-3 bottom-nav). iOS keeps the native glass `NativeTabs`; this is the
 * Android (and JS-fallback) bar, wired via the `tabBar` prop on `<Tabs>`.
 *
 * Icons + badges are reused from each screen's existing `tabBarIcon` option so
 * counts stay in sync; this component only owns layout, the indicator, haptics
 * and the press handling.
 */
export function FloatingPillTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
    const colors = useTheme();
    const insets = useSafeAreaInsets();
    const [innerWidth, setInnerWidth] = useState(0);
    const tx = useSharedValue(0);

    const count = state.routes.length;
    const itemWidth = innerWidth > 0 ? innerWidth / count : 0;

    useEffect(() => {
        if (itemWidth <= 0) return;
        const target = state.index * itemWidth + (itemWidth - INDICATOR_WIDTH) / 2;
        tx.value = withSpring(target, {
            damping: motion.spring.damping,
            stiffness: motion.spring.stiffness,
            mass: motion.spring.mass,
        });
    }, [state.index, itemWidth, tx]);

    const indicatorStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));

    return (
        <View
            pointerEvents="box-none"
            style={[styles.wrap, { paddingBottom: insets.bottom + spacing.sm }]}
        >
            <View
                onLayout={(e: LayoutChangeEvent) =>
                    setInnerWidth(e.nativeEvent.layout.width - spacing.sm * 2)
                }
                style={[
                    styles.bar,
                    elevation.level3,
                    { backgroundColor: colors.cardBackground, borderColor: colors.borderSubtle },
                ]}
            >
                {itemWidth > 0 && (
                    <Animated.View
                        pointerEvents="none"
                        style={[
                            styles.indicator,
                            {
                                left: spacing.sm,
                                width: INDICATOR_WIDTH,
                                height: INDICATOR_HEIGHT,
                                borderRadius: radius.pill,
                                backgroundColor: colors.primaryMuted,
                            },
                            indicatorStyle,
                        ]}
                    />
                )}

                {state.routes.map((route, index) => {
                    const { options } = descriptors[route.key];
                    const focused = state.index === index;
                    const tint = focused ? colors.primary : colors.textSecondary;
                    const label = (options.title ?? route.name) as string;

                    const onPress = () => {
                        Haptics.selectionAsync();
                        const event = navigation.emit({
                            type: 'tabPress',
                            target: route.key,
                            canPreventDefault: true,
                        });
                        if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
                    };

                    return (
                        <Pressable
                            key={route.key}
                            accessibilityRole="button"
                            accessibilityState={focused ? { selected: true } : {}}
                            accessibilityLabel={label}
                            android_ripple={{ color: colors.primaryMuted, borderless: true, radius: 36 }}
                            onPress={onPress}
                            style={styles.item}
                        >
                            <View style={styles.iconWrap}>
                                {options.tabBarIcon?.({ focused, color: tint, size: 24 })}
                            </View>
                            <Text numberOfLines={1} style={[typography.caption, styles.label, { color: tint }]}>
                                {label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        paddingHorizontal: spacing.lg,
    },
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.sm,
        paddingTop: spacing.sm,
        paddingBottom: spacing.xs,
        borderRadius: radius.xl,
        borderWidth: StyleSheet.hairlineWidth,
    },
    indicator: {
        position: 'absolute',
        top: spacing.sm,
    },
    item: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
    },
    iconWrap: {
        height: INDICATOR_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    label: {
        textAlign: 'center',
    },
});
