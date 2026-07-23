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
// selected tab's icon and slides between tabs. Compact metrics so the whole
// tab row measures ~40lp — the same bar size as the session list sheet's.
const INDICATOR_WIDTH = 56;
const INDICATOR_HEIGHT = 26;
const ICON_SIZE = 20;
/** Fallback row height before the first layout measure. The REAL height is
 *  MEASURED from the row's natural content (icon + label), so resizing icons
 *  or labels later auto-adjusts the dock — same scheme as the session bar. */
export const TABS_ROW_H = 40;

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
    // Natural content height of the row — measured, so the dock's collapsed
    // padding stays `peek` on every side whatever the icon/label sizes.
    const [rowH, setRowH] = useState(TABS_ROW_H);
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
            onLayout={(e: LayoutChangeEvent) => {
                setInnerWidth(e.nativeEvent.layout.width);
                const h = Math.round(e.nativeEvent.layout.height);
                if (h > 0) setRowH(prev => (prev === h ? prev : h));
            }}
            pointerEvents="box-none"
        >
            {itemWidth > 0 && !overrideActions && (
                <Animated.View
                    pointerEvents="none"
                    style={[
                        styles.indicator,
                        {
                            left: 0,
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
                        renderIcon={(color) => <Ionicons name={a.icon} size={ICON_SIZE} color={color} />}
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
                            renderIcon={(color) => options.tabBarIcon?.({ focused, color, size: ICON_SIZE })}
                            onPress={onPress}
                        />
                    );
                })}
        </View>
    );

    return <BasketDockSheet tabsRow={tabsRow} tabsRowHeight={rowH} />;
}

/** A generic dock tab item (for docks other than the root tab bar). */
export interface DockTab {
    key: string;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    /** Dim + ignore taps (e.g. a pane gated until the trip unlocks). */
    disabled?: boolean;
    /** Show a small lock glyph beside the label (a gated pane). */
    locked?: boolean;
    /** Pink dot on the icon — an attention cue (e.g. a pending mandatory queue). */
    dot?: boolean;
}

/**
 * Reusable dock TAB ROW — the exact visual system of the root tab bar
 * (M3 indicator, icon+label cells, expressive press morphs) for other
 * dock surfaces (e.g. the trip-map six-tab bar). Render it as the
 * `barRow` of a DockedGlassSheet and feed the measured height back via
 * onHeight (same auto-sizing contract as the root bar).
 */
export function DockTabsRow({
    tabs,
    activeKey,
    onSelect,
    onHeight,
    hug,
}: {
    tabs: DockTab[];
    activeKey: string;
    onSelect: (key: string) => void;
    onHeight?: (h: number) => void;
    /** HUG layout: cells size to their content (equal, via `item.minWidth`)
     *  instead of flex-filling the row — for a content-width dock (the compact
     *  DockedGlassSheet). Default false = fill (the full-width root/map bars). */
    hug?: boolean;
}) {
    const colors = useTheme();
    const [innerWidth, setInnerWidth] = useState(0);
    const tx = useSharedValue(0);
    const stretch = useSharedValue(1);
    const activeIndex = Math.max(0, tabs.findIndex(t => t.key === activeKey));
    const itemWidth = innerWidth > 0 ? innerWidth / tabs.length : 0;

    useEffect(() => {
        if (itemWidth <= 0) return;
        const target = activeIndex * itemWidth + (itemWidth - INDICATOR_WIDTH) / 2;
        tx.value = withSpring(target, motion.spring);
        stretch.value = withSequence(
            withTiming(1.55, {
                duration: motion.duration.fast,
                easing: Easing.bezier(...motion.easing.emphasized),
            }),
            withSpring(1, motion.springExpressive),
        );
    }, [activeIndex, itemWidth, tx, stretch]);

    const indicatorStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: tx.value }, { scaleX: stretch.value }],
    }));

    return (
        <View
            style={styles.tabsRow}
            onLayout={(e: LayoutChangeEvent) => {
                setInnerWidth(e.nativeEvent.layout.width);
                const h = Math.round(e.nativeEvent.layout.height);
                if (h > 0) onHeight?.(h);
            }}
            pointerEvents="box-none"
        >
            {itemWidth > 0 && (
                <Animated.View
                    pointerEvents="none"
                    style={[
                        styles.indicator,
                        {
                            left: 0,
                            width: INDICATOR_WIDTH,
                            height: INDICATOR_HEIGHT,
                            borderRadius: radius.pill,
                            backgroundColor: colors.secondaryContainer,
                        },
                        indicatorStyle,
                    ]}
                />
            )}
            {tabs.map((tab) => (
                <TabItem
                    key={tab.key}
                    label={tab.label}
                    focused={tab.key === activeKey}
                    colors={colors}
                    disabled={tab.disabled}
                    locked={tab.locked}
                    dot={tab.dot}
                    hug={hug}
                    renderIcon={(color) => <Ionicons name={tab.icon} size={ICON_SIZE} color={color} />}
                    onPress={() => { if (tab.disabled) return; Haptics.selectionAsync(); onSelect(tab.key); }}
                />
            ))}
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
    disabled,
    locked,
    dot,
    hug,
}: {
    label: string;
    focused: boolean;
    colors: AppTheme;
    renderIcon: (color: string) => ReactNode;
    onPress: () => void;
    /** Fixed tint for override-action items (primary / destructive red). */
    tintOverride?: string;
    /** Dim the cell + swallow presses (a gated pane). */
    disabled?: boolean;
    /** Show a small lock glyph after the label. */
    locked?: boolean;
    /** Pink attention dot on the icon. */
    dot?: boolean;
    /** Content-sized cell (for a hugging/content-width dock) instead of flex-fill. */
    hug?: boolean;
}) {
    const scale = useSharedValue(1);
    const tint = disabled
        ? colors.textMuted
        : tintOverride ?? (focused ? colors.onSecondaryContainer : colors.textSecondary);

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
            accessibilityState={{ selected: focused, disabled: !!disabled }}
            accessibilityLabel={label}
            android_ripple={disabled ? undefined : {
                color: withAlpha(colors.surfaceTint, stateLayer.pressed),
                borderless: true,
                radius: 30,
            }}
            onPress={disabled ? undefined : onPress}
            onPressIn={() => { if (!disabled) scale.value = withSpring(0.86, motion.spring); }}
            onPressOut={() => { if (!disabled) scale.value = withSpring(1, motion.springExpressive); }}
            style={[styles.item, hug && styles.itemHug, disabled && styles.itemDisabled]}
        >
            <Animated.View style={[styles.iconWrap, iconStyle]}>
                {renderIcon(tint)}
                {dot && <View style={[styles.tabDot, { backgroundColor: colors.primary, borderColor: colors.surfaceContainerHigh }]} />}
            </Animated.View>
            <View style={styles.labelRow}>
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
                {locked && <Ionicons name="lock-closed" size={10} color={colors.textMuted} />}
            </View>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    tabsRow: {
        // No padding, no flex, no minHeight — the row keeps its NATURAL content
        // height (icon + label), which is measured and fed to the dock so its
        // collapsed padding is `peek` on every side, auto-adjusting to any
        // future icon/label resize. The DockedGlassSheet centres it.
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    indicator: {
        position: 'absolute',
        top: 0,
    },
    item: {
        flex: 1,
        // Equal minimum so a content-width (compact) dock keeps its cells the
        // same width — the sliding indicator (itemWidth = innerWidth / count)
        // then lands centred under each. Harmless full-width (flex dominates).
        minWidth: 72,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
    },
    itemDisabled: { opacity: 0.55 },
    // HUG: content-sized cell (row shrinks to its tabs) — the compact dock. The
    // shared minWidth keeps the two cells equal so the indicator stays centred.
    itemHug: { flex: 0, paddingHorizontal: spacing.sm },
    labelRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    iconWrap: {
        height: INDICATOR_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Pink attention dot riding the icon's top-right corner (bordered so it lifts
    // off the glyph). Signals a pending action on the tab (e.g. mandatory swipes).
    tabDot: {
        position: 'absolute', top: -2, right: -4,
        width: 9, height: 9, borderRadius: 5, borderWidth: 1.5,
    },
    label: {
        textAlign: 'center',
        // Compact: with the 26lp icon wrap + 2 gap this lands the row at ~41lp —
        // the session bar's size class.
        fontSize: 11,
        lineHeight: 13,
    },
});
