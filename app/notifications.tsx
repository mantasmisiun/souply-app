/**
 * Notification inbox (Souply 2.0 Phase 6) — the source of truth the bell
 * opens. Rows mark read on entry; tapping a row follows its payload route
 * (trip, join code, …).
 */
import { View, Text, TouchableOpacity, StyleSheet, RefreshControl, ScrollView } from 'react-native';
import { useCallback, useMemo, useState } from 'react';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { glassHeaderOptions } from '../constants/navHeader';
import { ScreenHeading } from '../components/ScreenHeading';
import { SkeletonBox } from '../components/SkeletonBox';
import { useTheme, radius, spacing, type AppTheme } from '../constants/theme';
import { API_BASE_URL } from '../config/api';
import { formatDate } from '../utils/formatCurrency';

interface InboxRow {
    id: number;
    type: string;
    payload: { title?: string; body?: string; route?: string } | null;
    readAt: string | null;
    createdAt: string;
}

const TYPE_ICONS: Record<string, string> = {
    trip_invite: 'mail-unread-outline',
    trip_member_joined: 'people-outline',
    household_member_joined: 'home-outline',
    trip_receipt_in: 'receipt-outline',
};

export default function NotificationsScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const [rows, setRows] = useState<InboxRow[] | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/notifications`);
            setRows(await res.json());
            // Entering the inbox clears the bell badge.
            fetch(`${API_BASE_URL}/api/notifications/mark-read`, { method: 'POST' }).catch(() => {});
        } catch { setRows([]); }
    }, []);
    useFocusEffect(useCallback(() => { load(); }, [load]));

    return (
        <View style={styles.container}>
            <Stack.Screen options={glassHeaderOptions({ back: true })} />
            <ScreenHeading title={t('notifications.title')} />
            {rows == null ? (
                <View style={{ padding: 16, gap: 12 }}>
                    {Array.from({ length: 5 }).map((_, i) => (
                        <SkeletonBox key={i} width="100%" height={64} borderRadius={12} />
                    ))}
                </View>
            ) : (
                <ScrollView
                    contentContainerStyle={styles.list}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
                            colors={[colors.primary]}
                            tintColor={colors.primary}
                        />
                    }
                >
                    {rows.length === 0 ? (
                        <View style={styles.empty}>
                            <Ionicons name="notifications-off-outline" size={52} color={colors.textMuted} />
                            <Text style={styles.emptyText}>{t('notifications.empty')}</Text>
                        </View>
                    ) : rows.map(row => (
                        <TouchableOpacity
                            key={row.id}
                            style={[styles.row, row.readAt == null && styles.rowUnread]}
                            onPress={() => {
                                const route = row.payload?.route;
                                if (route) router.push(route as any);
                            }}
                            activeOpacity={0.75}
                        >
                            <View style={styles.rowIcon}>
                                <Ionicons
                                    name={(TYPE_ICONS[row.type] ?? 'notifications-outline') as any}
                                    size={20}
                                    color={colors.primary}
                                />
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.rowTitle} numberOfLines={1}>{row.payload?.title ?? row.type}</Text>
                                {row.payload?.body ? (
                                    <Text style={styles.rowBody} numberOfLines={2}>{row.payload.body}</Text>
                                ) : null}
                            </View>
                            <Text style={styles.rowDate}>{formatDate(row.createdAt)}</Text>
                        </TouchableOpacity>
                    ))}
                </ScrollView>
            )}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    list: { padding: spacing.lg, gap: 8 },
    empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
    emptyText: { fontSize: 14, color: c.textMuted },
    row: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        backgroundColor: c.cardBackground, borderRadius: radius.lg, padding: 14,
    },
    rowUnread: { borderWidth: 1.5, borderColor: c.primary },
    rowIcon: {
        width: 36, height: 36, borderRadius: 18,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    rowTitle: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
    rowBody: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    rowDate: { fontSize: 11, color: c.textMuted },
});
