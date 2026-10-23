import React, { useMemo, type ReactNode } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type AppTheme } from '../../constants/theme';
import { SheetCard } from '../SheetCard';

/**
 * A titled section card inside a dock — an icon + title header, a divider, then
 * its rows. The main dock's Settings / Location & Route and the store dock's
 * Stores section all use this, so section headers never diverge.
 */
export function DockSection({ colors, icon, title, children }: {
    colors: AppTheme;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    title: string;
    children: ReactNode;
}) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    return (
        <SheetCard>
            <View style={styles.titleRow}>
                <Ionicons name={icon} size={20} color={colors.primary} />
                <Text style={styles.titleText}>{title}</Text>
            </View>
            <View style={styles.sep} />
            {children}
        </SheetCard>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14 },
    titleText: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    sep: { height: 1, backgroundColor: c.border },
});
