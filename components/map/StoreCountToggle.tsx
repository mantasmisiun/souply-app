import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useEffect, useMemo } from 'react';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LiquidGlass } from '../LiquidGlass';
import { useTheme, radius, spacing, elevation, iconSize, type AppTheme } from '../../constants/theme';

/**
 * Compact 1·2·3 store-count segmented toggle — the floating glass pill at the
 * top of the results map, extracted for the 2.0 one-map shell (spec: the
 * selector lives on the map in EVERY mode; store count is removed from
 * Parinktys). A sliding capsule animates between segments instead of
 * hard-cutting; haptic selection tick on change.
 */

const SEG_WIDTH = 34;

export type StoreCount = 1 | 2 | 3;

export function StoreCountToggle({
    value,
    onChange,
}: {
    value: StoreCount;
    /** Called only on an actual change (taps on the active segment no-op). */
    onChange: (n: StoreCount) => void;
}) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const idx = useSharedValue(value - 1);
    useEffect(() => { idx.value = value - 1; }, [value, idx]);
    const indicatorStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: withTiming(idx.value * SEG_WIDTH, { duration: 220 }) }],
    }));

    const handlePress = (n: StoreCount) => {
        if (n === value) return;
        try { Haptics.selectionAsync(); } catch {}
        onChange(n);
    };

    return (
        <View style={styles.shadow}>
            <LiquidGlass style={styles.pill} fallback="solid">
                <Ionicons name="storefront-outline" size={iconSize.sm} color={colors.textSecondary} style={styles.icon} />
                <View style={styles.segments}>
                    <Animated.View style={[styles.indicator, indicatorStyle]} />
                    {([1, 2, 3] as const).map(n => (
                        <TouchableOpacity
                            key={n}
                            style={styles.btn}
                            onPress={() => handlePress(n)}
                            activeOpacity={0.8}
                        >
                            <Text style={[styles.text, value === n && styles.textActive]}>{n}</Text>
                        </TouchableOpacity>
                    ))}
                </View>
            </LiquidGlass>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    shadow: {
        borderRadius: radius.pill,
        ...elevation.level3,
    },
    pill: {
        flexDirection: 'row', alignItems: 'center', overflow: 'hidden',
        backgroundColor: c.cardBackground, borderRadius: radius.pill,
        paddingLeft: spacing.sm, paddingRight: spacing.xs, paddingVertical: spacing.xs, gap: 2,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
    icon: { marginRight: spacing.xs },
    segments: { flexDirection: 'row', position: 'relative' },
    // Sliding selection capsule; sits behind the digits and animates between them.
    indicator: { position: 'absolute', top: 0, bottom: 0, left: 0, width: SEG_WIDTH, borderRadius: radius.pill, backgroundColor: c.primary },
    btn: { width: SEG_WIDTH, paddingVertical: 6, alignItems: 'center', justifyContent: 'center' },
    text: { fontSize: 15, fontWeight: '800', color: c.textSecondary },
    textActive: { color: c.onPrimary },
});
