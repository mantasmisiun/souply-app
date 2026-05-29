import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../constants/theme';

interface Props {
    icon: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
    /** Icon size in pt. The container scales with this for centring. */
    size?: number;
    /** Defaults to the theme primary color. */
    color?: string;
    accessibilityLabel?: string;
    disabled?: boolean;
}

/**
 * Plain icon button for nav-bar headers. Centers the icon in a small
 * container with generous hit-slop so the touch target stays >= 44pt
 * even though the visible bounds are tight.
 *
 * NOTE: This used to wrap the icon in a `BlurView` disc, but on iOS 26
 * the native nav bar already provides its own liquid-glass background
 * — adding another BlurView produced a visible double-glass artifact
 * (smaller glass disc inside the bar's glass). The icon now sits
 * directly on whatever surface the nav bar provides, matching the
 * iOS 26 native Apple-app look.
 */
export function GlassIconButton({
    icon,
    onPress,
    size = 22,
    color,
    accessibilityLabel,
    disabled,
}: Props) {
    const colors = useTheme();
    const tint = disabled ? colors.textMuted : (color ?? colors.primary);
    const disc = size + 14;

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
            <View
                style={{
                    width: disc,
                    height: disc,
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <Ionicons name={icon} size={size} color={tint} />
            </View>
        </Pressable>
    );
}
