import { useEffect, useState, type ReactNode } from 'react';
import { View, Pressable, Text, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withSequence,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useTabBarOverride } from '../state/tabBarOverride';
import {
    useTheme,
    useResolvedScheme,
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
 * M3 features applied here (the "test surface" for the modernization pass):
 *   - tonal **active-indicator** pill (`secondaryContainer`) that slides between
 *     tabs and STRETCHES while travelling (expressive motion), then settles;
 *   - **surface-tint** elevated bar (`surfaceContainer` + `outlineVariant`);
 *   - per-tab **state layer + shape-morph**: native ripple, a press scale-down,
 *     and a spring bounce when a tab becomes active;
 *   - active icon/label in `onSecondaryContainer` with a heavier label weight;
 *   - selection haptic on press.
 *
 * Icons + badges are reused from each screen's `tabBarIcon` option so counts
 * stay in sync; this component owns layout, the indicator, motion + haptics.
 */
export function FloatingPillTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
    const colors = useTheme();
    const isDark = useResolvedScheme() === 'dark';
    const insets = useSafeAreaInsets();
    const [innerWidth, setInnerWidth] = useState(0);
    const tx = useSharedValue(0);
    const stretch = useSharedValue(1);

    // Two stacked shadows (Material's key + ambient light model) give a real
    // sense of lift that a single capped Android `elevation` can't. The key
    // shadow is tight, darker and tinted (warm beet in light mode) so the bar
    // reads as floating ABOVE the page rather than printed on it; the ambient
    // is wide + faint for the soft penumbra. An inner top highlight rim adds the
    // convex sheen (lit-from-above) that sells the 3D, iOS-like feel.
    const keyShadow = isDark
        ? { shadowColor: '#000000', shadowOpacity: 0.6, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 16 }
        : { shadowColor: '#5A2233', shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 16 };
    const ambientShadow = isDark
        ? { shadowColor: '#000000', shadowOpacity: 0.45, shadowRadius: 28, shadowOffset: { width: 0, height: 16 }, elevation: 8 }
        : { shadowColor: '#3A1722', shadowOpacity: 0.16, shadowRadius: 28, shadowOffset: { width: 0, height: 16 }, elevation: 8 };
    const rimColor = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.9)';

    // Contextual override (e.g. shopping-list multi-select): the pill KEEPS its
    // glass/shadow shell but renders action items instead of tabs — no second
    // bar floating behind this one. The active-indicator is hidden (no tab is
    // "selected" while actions own the bar).
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

    return (
        <View
            pointerEvents="box-none"
            style={[styles.wrap, { paddingBottom: insets.bottom + spacing.sm }]}
        >
          {/* Ambient (soft, wide) shadow layer — hugs the bar so both shadows
              share the same rounded silhouette. The bar carries the tighter key
              shadow; together they fake two-light depth. */}
          <View style={[styles.shadowLayer, ambientShadow]}>
            <View
                onLayout={(e: LayoutChangeEvent) =>
                    setInnerWidth(e.nativeEvent.layout.width - spacing.sm * 2)
                }
                style={[
                    styles.bar,
                    keyShadow,
                    { borderColor: colors.outlineVariant }, // background is now glass (blur + tint), not solid
                ]}
            >
                {/* GLASS: a blurred backdrop of the page behind the bar, plus a
                    semi-transparent surface tint over it for color identity and so
                    icons/labels stay legible over busy content. `experimentalBlurMethod`
                    enables a real blur on Android (iOS ignores it). Both layers are
                    clipped to the bar's rounded shape via `styles.glass`. */}
                <BlurView
                    pointerEvents="none"
                    intensity={isDark ? 40 : 55}
                    tint={isDark ? 'dark' : 'light'}
                    experimentalBlurMethod="dimezisBlurView"
                    style={styles.glass}
                />
                <View
                    pointerEvents="none"
                    style={[styles.glass, { backgroundColor: withAlpha(colors.surfaceContainer, 0.6) }]}
                />
                {/* Inner top-highlight rim — only the top edge is lit, giving the
                    surface a convex, lit-from-above sheen. */}
                <View
                    pointerEvents="none"
                    style={[styles.rim, { borderTopColor: rimColor }]}
                />
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
                            onPress={() => {
                                Haptics.selectionAsync();
                                a.onPress();
                            }}
                        />
                    ))
                    : state.routes.map((route, index) => {
                    const { options } = descriptors[route.key];
                    const focused = state.index === index;
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
          </View>
        </View>
    );
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
    wrap: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        paddingHorizontal: spacing.lg,
    },
    shadowLayer: {
        borderRadius: radius.xl,
    },
    glass: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderRadius: radius.xl,
        overflow: 'hidden', // clip the blur/tint to the bar's rounded corners
    },
    rim: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderRadius: radius.xl,
        borderWidth: 1.2,
        borderColor: 'transparent',
        zIndex: 5,
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
