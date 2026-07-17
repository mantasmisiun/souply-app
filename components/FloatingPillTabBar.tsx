import { useEffect, useState, type ReactNode } from 'react';
import { View, Pressable, Text, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withSequence,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useTabBarOverride } from '../state/tabBarOverride';
import { BasketDockSheet } from './basket/BasketDockSheet';
import {
    useTheme,
    spacing,
    radius,
    typography,
    motion,
    stateLayer,
    withAlpha,
    type AppTheme,
} from '../constants/theme';

const DESTRUCTIVE_COLOR = '#E53E3E';

// Width/height of the Material-3 "active indicator" pill that sits behind the
// selected tab's icon and slides between tabs.
const INDICATOR_WIDTH = 56;
const INDICATOR_HEIGHT = 34;
/** The tab-buttons row height (the collapsed bar). Content: icon 34 + label. */
const TABS_ROW_H = 64;

/**
 * Bottom clearance (above the safe-area inset) that screens must pad their
 * scroll content by so the last item clears this floating bar. The bar is
 * `position: absolute`, so it reserves no layout space and react-navigation's
 * measured tab-bar height is unreliable — `useSafeBottomTabBarHeight` returns
 * this constant (+ inset) on Android instead. = bar height (~71) + a small gap.
 */
export const FLOATING_TAB_BAR_CLEARANCE = 80;

/**
 * Android floating pill tab bar — Material-3 (Expressive) bottom navigation.
 * iOS keeps the native glass `NativeTabs`; this is the Android (and JS-fallback)
 * bar, wired via the `tabBar` prop on `<Tabs>`.
 *
 * The GLASS, shadow and expand-into-a-sheet behaviour now live in
 * `DockedGlassSheet` (one panel, artifact-free). This component only builds the
 * TAB-BUTTON ROW (indicator, badges, haptics, M3 motion, multi-select override)
 * and hands it to `BasketDockSheet`, which docks it in the glass panel and adds
 * the Naršyti basket sheet above it when relevant.
 */
export function FloatingPillTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
    const colors = useTheme();
    const [innerWidth, setInnerWidth] = useState(0);
    const tx = useSharedValue(0);
    const stretch = useSharedValue(1);

    // Contextual override (e.g. shopping-list multi-select): the bar renders
    // action items instead of tabs. The active-indicator is hidden.
    const overrideActions = useTabBarOverride((s) => s.actions);

    const count = state.routes.length;
    const itemWidth = innerWidth > 0 ? innerWidth / count : 0;

    useEffect(() => {
        if (itemWidth <= 0) return;
        const target = state.index * itemWidth + (itemWidth - INDICATOR_WIDTH) / 2;
        tx.value = withSpring(target, motion.spring);
        // Expressive: the indicator elongates while it travels, then springs back
        // to its resting width — the signature M3 Expressive nav motion.
        stretch.value = withSequence(
            withTiming(1.55, {
                duration: motion.duration.fast,
                easing: Easing.bezier(...motion.easing.emphasized),
            }),
            withSpring(1, motion.springExpressive),
        );
    }, [state.index, itemWidth, tx, stretch]);

    const indicatorStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: tx.value }, { scaleX: stretch.value }],
    }));

    // The tab-button row — laid out edge-to-edge; the glass around it is the
    // DockedGlassSheet's. `onLayout` measures the indicator track width.
    const tabsRow = (
        <View
            style={styles.tabsRow}
            onLayout={(e: LayoutChangeEvent) => setInnerWidth(e.nativeEvent.layout.width - spacing.sm * 2)}
            pointerEvents="box-none"
        >
            {itemWidth > 0 && !overrideActions && (
                <Animated.View
                    pointerEvents="none"
                    style={[
                        styles.indicator,
                        {
                            left: spacing.sm,
                            width: INDICATOR_WIDTH,
                            height: INDICATOR_HEIGHT,
                            borderRadius: radius.pill,
                            backgroundColor: colors.secondaryContainer,
                        },
                        indicatorStyle,
                    ]}
                />
            )}

            {overrideActions
                ? overrideActions.map((a, i) => (
                    <TabItem
                        key={`${a.label}-${i}`}
                        label={a.label}
                        focused={false}
                        colors={colors}
                        tintOverride={a.destructive ? DESTRUCTIVE_COLOR : colors.primary}
                        renderIcon={(color) => <Ionicons name={a.icon} size={24} color={color} />}
                        onPress={() => { Haptics.selectionAsync(); a.onPress(); }}
                    />
                ))
                : state.routes.map((route, index) => {
                    const { options } = descriptors[route.key];
                    const focused = state.index === index;
                    const label = (options.title ?? route.name) as string;
                    const onPress = () => {
                        Haptics.selectionAsync();
                        const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                        if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
                    };
                    return (
                        <TabItem
                            key={route.key}
                            label={label}
                            focused={focused}
                            colors={colors}
                            renderIcon={(color) => options.tabBarIcon?.({ focused, color, size: 24 })}
                            onPress={onPress}
                        />
                    );
                })}
        </View>
    );

    return <BasketDockSheet tabsRow={tabsRow} tabsRowHeight={TABS_ROW_H} />;
}

/**
 * One tab cell — owns its own icon-scale spring so a press shrinks the icon
 * (state-layer feedback) and becoming-active gives it a brief bounce
 * (shape-morph). Kept as a child so each cell has independent shared values.
 */
function TabItem({
    label,
    focused,
    colors,
    renderIcon,
    onPress,
    tintOverride,
}: {
    label: string;
    focused: boolean;
    colors: AppTheme;
    renderIcon: (color: string) => ReactNode;
    onPress: () => void;
    /** Fixed tint for override-action items (primary / destructive red). */
    tintOverride?: string;
}) {
    const scale = useSharedValue(1);
    const tint = tintOverride ?? (focused ? colors.onSecondaryContainer : colors.textSecondary);

    useEffect(() => {
        if (focused) {
            scale.value = withSequence(
                withSpring(1.14, motion.springExpressive),
                withSpring(1, motion.springExpressive),
            );
        }
    }, [focused, scale]);

    const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={focused ? { selected: true } : {}}
            accessibilityLabel={label}
            android_ripple={{
                color: withAlpha(colors.surfaceTint, stateLayer.pressed),
                borderless: true,
                radius: 36,
            }}
            onPress={onPress}
            onPressIn={() => { scale.value = withSpring(0.86, motion.spring); }}
            onPressOut={() => { scale.value = withSpring(1, motion.springExpressive); }}
            style={styles.item}
        >
            <Animated.View style={[styles.iconWrap, iconStyle]}>
                {renderIcon(tint)}
            </Animated.View>
            <Text
                numberOfLines={1}
                style={[
                    focused ? typography.labelSmall : typography.caption,
                    styles.label,
                    { color: tint },
                ]}
            >
                {label}
            </Text>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    tabsRow: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingTop: spacing.sm,
        paddingHorizontal: spacing.sm,
        minHeight: TABS_ROW_H,
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
