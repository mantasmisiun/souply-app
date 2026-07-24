import { type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet } from 'react-native';
import { useEffect } from 'react';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withRepeat, withTiming, cancelAnimation } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, motion, withAlpha } from '../constants/theme';
import { LiquidGlass } from './LiquidGlass';

interface Props {
    icon?: keyof typeof Ionicons.glyphMap;
    /** Custom icon element (e.g. a MaterialCommunityIcons glyph). Overrides
     *  `icon`; the caller sets its own size/colour. */
    iconNode?: ReactNode;
    onPress: () => void;
    /** Icon size in pt. The container scales with this for centring. */
    size?: number;
    /** Defaults to the theme primary color. */
    color?: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    /**
     * Render the icon inside a self-contained liquid-glass pill. Use ONLY when
     * the button is NOT a native nav-bar item (e.g. an in-screen header like the
     * search bar) — a native bar already provides its own glass, so leaving this
     * off in headers avoids a double-glass artifact.
     */
    glass?: boolean;
    /** Solid disc fallback where glass is unavailable (Android): use for chrome
     *  floating over a MAP — a bare icon has no contrast against tiles. */
    solid?: boolean;
    /** Attention variant — a FILLED primary (pink) disc with an onPrimary icon
     *  and a soft tinted lift. Use to make one header action stand out (e.g. a
     *  call-to-action). Overrides glass/solid; icon colour defaults to onPrimary. */
    filled?: boolean;
    /** Pulse the disc (opacity breathe) — a lightweight "loading / drawing your
     *  attention" state, e.g. while the CTA's availability is still resolving. */
    loading?: boolean;
}

/**
 * Icon button for nav-bar headers and in-screen header bars.
 *
 * Android: an M3-Expressive TONAL icon chip — a 40dp translucent circle
 * (surfaceContainerHigh at ~85%, sits on the header fade with the page ghosting
 * through), no shadow, and the Expressive press signature: the circle MORPHS
 * toward a rounded square and shrinks slightly while pressed (same
 * springExpressive voice as the tab bar).
 *
 * iOS: in a native nav bar leave `glass` off — iOS 26 gives the bar item its
 * own liquid-glass capsule. For an in-screen bar pass `glass` so the button
 * carries its own pill and matches the native look.
 */
export function GlassIconButton({
    icon,
    iconNode,
    onPress,
    size = 24,
    color,
    accessibilityLabel,
    disabled,
    glass,
    solid,
    filled,
    loading,
}: Props) {
    const colors = useTheme();
    const tint = disabled ? colors.textMuted : (color ?? (filled ? colors.onPrimary : colors.primary));
    const disc = size + 16; // M3: 24dp icon in a 40dp container
    const iconEl = iconNode ?? <Ionicons name={icon ?? 'ellipse-outline'} size={size} color={tint} />;
    // The glass pill is an iOS-only affordance (Liquid Glass / blur capsule).
    const showGlass = glass && Platform.OS === 'ios' && !filled;

    // Expressive press morph: round → rounded-square + slight shrink.
    const pressP = useSharedValue(0);
    const morphStyle = useAnimatedStyle(() => ({
        transform: [{ scale: 1 - 0.08 * pressP.value }],
        borderRadius: disc / 2 - (disc / 2 - disc / 3.4) * pressP.value,
    }));

    // Loading "breathe": opacity pulses while `loading`, settles to 1 when done.
    const pulse = useSharedValue(1);
    useEffect(() => {
        if (loading) pulse.value = withRepeat(withTiming(0.5, { duration: 620 }), -1, true);
        else { cancelAnimation(pulse); pulse.value = withTiming(1, { duration: 180 }); }
        return () => cancelAnimation(pulse);
    }, [loading, pulse]);
    const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            onPressIn={() => { pressP.value = withSpring(1, motion.springExpressive); }}
            onPressOut={() => { pressP.value = withSpring(0, motion.springExpressive); }}
            style={({ pressed }) => ({
                opacity: disabled ? 0.5 : (pressed && Platform.OS === 'ios' ? 0.5 : 1),
                marginHorizontal: 4,
            })}
        >
            {showGlass ? (
                <LiquidGlass
                    style={[styles.disc, styles.glassDisc, { width: disc, height: disc, borderRadius: disc / 2 }]}
                >
                    {iconEl}
                </LiquidGlass>
            ) : (
                <Animated.View
                    style={[
                        styles.disc,
                        { width: disc, height: disc },
                        // Android: SOLID card-white chip + hairline outline + soft
                        // lift — same surface recipe as the search pill, so the
                        // header buttons are clearly noticeable on the page (the
                        // translucent tonal fill had no contrast on cream). iOS
                        // non-glass (native bar items) stays bare.
                        Platform.OS === 'android' && !filled && {
                            backgroundColor: colors.cardBackground,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: colors.border,
                            elevation: 2,
                        },
                        solid && { backgroundColor: colors.cardBackground, elevation: 3 },
                        // Attention CTA: filled pink disc with a soft same-hue lift.
                        filled && {
                            backgroundColor: colors.primary,
                            elevation: 4,
                            shadowColor: colors.primary,
                            shadowOpacity: 0.35,
                            shadowRadius: 6,
                            shadowOffset: { width: 0, height: 2 },
                        },
                        Platform.OS === 'android' ? morphStyle : { borderRadius: disc / 2 },
                        pulseStyle,
                    ]}
                >
                    {iconEl}
                </Animated.View>
            )}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    disc: { alignItems: 'center', justifyContent: 'center' },
    glassDisc: {
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'rgba(120,120,128,0.24)',
    },
});
