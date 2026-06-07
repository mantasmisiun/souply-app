import { TouchableOpacity, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useTheme } from '../constants/theme';
import { AppleMark, GoogleMark } from './BrandMarks';

/**
 * OAuth sign-in button, styled to match the website (souply-web) — theme-aware,
 * no brand-custom colours:
 *   • Apple — Apple HIG: an "ink" button with "surface" content that flips with
 *     the theme (black-on-white in light, white-on-black in dark). Mirrors the
 *     web's `bg-ink text-surface`.
 *   • Google — neutral surface button + hairline border with the official
 *     four-colour "G". Mirrors the web's Google-rendered button.
 */
export function OAuthButton({
    provider,
    label,
    onPress,
    disabled,
    loading,
}: {
    provider: 'google' | 'apple';
    label: string;
    onPress: () => void;
    disabled?: boolean;
    loading?: boolean;
}) {
    const c = useTheme();
    const isApple = provider === 'apple';
    const bg = isApple ? c.textPrimary : c.cardBackground;
    const fg = isApple ? c.cardBackground : c.textPrimary;

    return (
        <TouchableOpacity
            onPress={onPress}
            disabled={disabled}
            activeOpacity={0.85}
            style={[
                styles.btn,
                { backgroundColor: bg },
                !isApple && { borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
                disabled && styles.disabled,
            ]}
        >
            {loading
                ? <ActivityIndicator color={fg} />
                : <>
                    {isApple ? <AppleMark size={18} color={fg} /> : <GoogleMark size={18} />}
                    <Text style={[styles.label, { color: fg }]}>{label}</Text>
                  </>}
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    btn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
        paddingVertical: 15, borderRadius: 14,
    },
    label: { fontSize: 16, fontWeight: '700' },
    disabled: { opacity: 0.6 },
});
