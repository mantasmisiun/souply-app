import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../constants/theme';

/**
 * Curated avatar palette — mirrors the server's AVATAR_PALETTE (src/utils/
 * avatarColor.ts). All read clearly with white text. The colour picker offers
 * this exact set; the server assigns one at random on first name-set.
 */
export const AVATAR_PALETTE = [
    '#EB6784', '#5EA29A', '#E8894D', '#6C8AE4', '#B07CD6',
    '#E0A93B', '#58B368', '#E06C9F', '#4CA0B3', '#C76B6B',
] as const;

/** First letter of a name for the circle. Falls back to '?' when nameless. */
export const avatarInitial = (name?: string | null): string => {
    const c = (name ?? '').trim().replace(/^@/, '').charAt(0);
    return c ? c.toUpperCase() : '?';
};

/**
 * A user's identity chip: a coloured circle with the first letter of their
 * name. Used in the profile, member rosters, and the "who checked this" badge
 * on shared-list items. Colour falls back to the theme's muted surface when a
 * user hasn't been assigned one yet.
 */
export function UserAvatar({
    name, color, size = 30, style,
}: {
    name?: string | null;
    color?: string | null;
    size?: number;
    style?: StyleProp<ViewStyle>;
}) {
    const colors = useTheme();
    const bg = color ?? colors.surfaceMuted ?? colors.border;
    return (
        <View
            style={[
                styles.circle,
                { width: size, height: size, borderRadius: size / 2, backgroundColor: bg },
                style,
            ]}
        >
            <Text
                allowFontScaling={false}
                style={[styles.letter, { fontSize: Math.round(size * 0.44), color: color ? '#FFFFFF' : colors.textSecondary }]}
            >
                {avatarInitial(name)}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create({
    circle: { alignItems: 'center', justifyContent: 'center' },
    letter: { fontWeight: '800', includeFontPadding: false },
});
