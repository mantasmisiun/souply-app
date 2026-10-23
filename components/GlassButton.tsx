import { BlurView } from 'expo-blur';
import { Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../constants/theme';

type Variant = 'primary' | 'danger' | 'secondary';

interface Props {
    onPress: () => void;
    title: string;
    variant?: Variant;
    disabled?: boolean;
    /** Pass true when you need the button to expand to its parent. */
    flex?: boolean;
    style?: StyleProp<ViewStyle>;
}

/**
 * iOS 26 liquid-glass button. Three stacked layers on iOS:
 *   1. `BlurView` (systemThinMaterial) — the actual glass material
 *      that refracts whatever is behind the button.
 *   2. Variant tint overlay              — primary / danger color at
 *                                          25-40% alpha for color
 *                                          identity.
 *   3. Text label                        — onPrimary color for tinted
 *                                          variants, primary for
 *                                          secondary.
 *
 * On Android the BlurView wrapper is skipped — the button renders as
 * a plain solid Pressable with the same dimensions and the variant's
 * solid color. Matches the existing Android look bit-for-bit.
 */
export function GlassButton({
    onPress,
    title,
    variant = 'primary',
    disabled = false,
    flex = false,
    style,
}: Props) {
    const colors = useTheme();
    const tintColor =
        variant === 'danger'
            ? colors.error
            // Small (14px) white label → use the stronger beet so the text clears
            // WCAG AA (bright `primary` is ~3:1 with white — fine for fills/icons,
            // under the 4.5:1 bar for small text). primaryStrong ≈ 4.4:1.
            : variant === 'secondary'
                ? colors.surfaceMuted
                : colors.primaryStrong;
    const labelColor =
        variant === 'secondary'
            ? colors.textPrimary
            : colors.onPrimary;

    const containerStyle: StyleProp<ViewStyle> = [
        {
            borderRadius: 12,
            overflow: 'hidden',
            opacity: disabled ? 0.4 : 1,
        },
        flex ? { flex: 1 } : null,
        style,
    ];

    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            style={({ pressed }) => [
                containerStyle,
                { opacity: pressed && !disabled ? 0.7 : disabled ? 0.4 : 1 },
            ]}
        >
            {Platform.OS === 'ios' ? (
                <>
                    <BlurView
                        tint="systemThinMaterial"
                        intensity={50}
                        style={StyleSheet.absoluteFill}
                    />
                    <View
                        style={[
                            StyleSheet.absoluteFill,
                            { backgroundColor: tintColor, opacity: variant === 'secondary' ? 0.25 : 0.65 },
                        ]}
                    />
                </>
            ) : (
                <View
                    style={[StyleSheet.absoluteFill, { backgroundColor: tintColor }]}
                />
            )}
            <View style={{ paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' }}>
                <Text
                    style={{
                        fontSize: 14,
                        fontWeight: variant === 'secondary' ? '600' : '700',
                        color: labelColor,
                    }}
                >
                    {title}
                </Text>
            </View>
        </Pressable>
    );
}
