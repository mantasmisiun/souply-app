import React, { useMemo, type ReactNode } from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MaterialProgress } from '@/components/MaterialProgress';
import { type AppTheme } from '../../constants/theme';
import { SheetCard } from '../SheetCard';

/**
 * A big dock action card — icon (top-left), title, subtitle — on a SheetCard.
 * The main dock's Basket / Invite and the store dock's Navigate / List all use
 * this, so the primary actions look identical everywhere.
 */
export function DockActionCard({ colors, icon, iconNode, title, subtitle, onPress, onPressIn, disabled, loading, badge }: {
    colors: AppTheme;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    /** Custom icon element (e.g. a MaterialIcons glyph for the Android download
     *  logo). Overrides `icon` when provided. */
    iconNode?: ReactNode;
    title: string;
    subtitle?: string;
    onPress: () => void;
    /** Fires on touch-down — used over a native map to stamp the interaction
     *  before the map's leaked onPress on release. */
    onPressIn?: () => void;
    disabled?: boolean;
    loading?: boolean;
    /** Optional overlay on the icon (e.g. the basket item-count pip). */
    badge?: ReactNode;
}) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    return (
        <TouchableOpacity style={styles.wrap} onPress={onPress} onPressIn={onPressIn} disabled={disabled} activeOpacity={0.7}>
            <SheetCard style={styles.card}>
                <View>
                    {loading
                        ? <MaterialProgress size="small" color={colors.primary} />
                        : iconNode ?? <Ionicons name={icon ?? 'ellipse-outline'} size={24} color={colors.primary} />}
                    {badge}
                </View>
                <Text style={styles.title}>{title}</Text>
                {subtitle != null && <Text style={styles.sub} numberOfLines={1}>{subtitle}</Text>}
            </SheetCard>
        </TouchableOpacity>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    wrap: { flex: 1 },
    card: { alignItems: 'flex-start', gap: 2, paddingVertical: 14 },
    title: { fontSize: 16, fontWeight: '700', color: c.textPrimary, marginTop: 6 },
    sub: { fontSize: 12, fontWeight: '500', color: c.textSecondary },
});
