import { Platform, Pressable, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../constants/theme';
import { LiquidGlass } from './LiquidGlass';

interface Props {
    icon: keyof typeof Ionicons.glyphMap;
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
}

/**
 * Icon button for nav-bar headers and in-screen header bars.
 *
 * In a native nav bar (headerLeft/headerRight) leave `glass` off: iOS 26 gives
 * the bar item its own liquid-glass capsule. For an in-screen bar with no native
 * header (e.g. the search screen) pass `glass` so the button carries its own
 * pill and matches the native look.
 */
export function GlassIconButton({
    icon,
    onPress,
    size = 22,
    color,
    accessibilityLabel,
    disabled,
    glass,
    solid,
}: Props) {
    const colors = useTheme();
    const tint = disabled ? colors.textMuted : (color ?? colors.primary);
    const disc = size + 14;
    const iconEl = <Ionicons name={icon} size={size} color={tint} />;
    // The glass pill is an iOS-only affordance (Liquid Glass / blur capsule).
    // Android header buttons app-wide are bare icons — the blur fallback
    // rendered as a dark-tinted circle there (visible in light mode).
    const showGlass = glass && Platform.OS === 'ios';

    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            style={({ pressed }) => ({
                opacity: disabled ? 0.5 : (pressed ? 0.5 : 1),
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
                <View
                    style={[
                        styles.disc,
                        { width: disc, height: disc },
                        solid && { backgroundColor: colors.cardBackground, borderRadius: disc / 2, elevation: 3 },
                    ]}
                >
                    {iconEl}
                </View>
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
