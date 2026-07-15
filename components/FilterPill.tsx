import { type ReactNode } from 'react';
import { Text, TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, radius, elevation, type AppTheme } from '../constants/theme';

/**
 * The shared filter-trigger pill used by the store + date filters (and matching
 * the discounts screen's FilterChip look). Renders optional leading/label, and a
 * trailing chevron by default (override `trailing` for a custom affordance, e.g.
 * a clear ✕). `active` fills it with the brand colour.
 */
export function FilterPill({
    active,
    onPress,
    label,
    leading,
    trailing,
    style,
}: {
    active?: boolean;
    onPress: () => void;
    label?: string;
    leading?: ReactNode;
    trailing?: ReactNode;
    style?: StyleProp<ViewStyle>;
}) {
    const c = useTheme();
    const s = makeStyles(c);
    return (
        <TouchableOpacity
            style={[s.bubble, active && s.bubbleActive, style]}
            onPress={onPress}
            activeOpacity={0.7}
        >
            {leading}
            {label != null && (
                <Text style={[s.text, active && s.textActive]} numberOfLines={1}>{label}</Text>
            )}
            {trailing ?? (
                <Ionicons name="chevron-down" size={14} color={active ? c.onPrimary : c.textSecondary} />
            )}
        </TouchableOpacity>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    bubble: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.cardBackground,
    },
    bubbleActive: {
        backgroundColor: c.primary,
        borderColor: c.primary,
        ...elevation.level1,
    },
    text: { fontSize: 13, color: c.textPrimary },
    textActive: { color: c.onPrimary, fontWeight: '600' },
});
