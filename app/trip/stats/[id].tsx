/**
 * Trip stats screen (stage 5 of the simplified flow — basic view, the real
 * saved/could-have-saved + planning/impulsivity design comes later).
 * Locked hint while the trip's mandatory swipe queues are still open.
 */
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { ScreenBackButton } from '../../../components/ScreenBackButton';
import { useTheme, radius, spacing, type AppTheme } from '../../../constants/theme';
import { fetchTripStats, fetchTripReceipts, type TripStats } from '../../../utils/tripsApi';

export default function TripStatsScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const { id } = useLocalSearchParams<{ id: string }>();
    const tripId = Number(id);

    const [stats, setStats] = useState<TripStats | null>(null);
    const [locked, setLocked] = useState<boolean | null>(null);

    const load = useCallback(async () => {
        try {
            const receipts = await fetchTripReceipts(tripId);
            const pending = receipts.some(r => r.mandatorySwipesRequired > 0 && !r.mandatorySwipesCompleted);
            setLocked(pending || receipts.length === 0);
            if (!pending && receipts.length > 0) setStats(await fetchTripStats(tripId));
        } catch { setLocked(true); }
    }, [tripId]);
    useFocusEffect(useCallback(() => { void load(); }, [load]));

    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
                <View style={styles.chrome}>
                    <ScreenBackButton />
                    <Text style={styles.title}>{t('trips.sheetStats')}</Text>
                </View>
                {locked == null ? (
                    <View style={styles.centered}><MaterialProgress size="large" color={colors.primary} /></View>
                ) : locked ? (
                    <View style={styles.centered}>
                        <Text style={styles.hint}>{t('tripMap.statsLocked')}</Text>
                    </View>
                ) : stats ? (
                    <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl }}>
                        <View style={styles.statsRow}>
                            <View style={styles.statBox}>
                                <Text style={styles.statValue}>€{stats.totalSpent.toFixed(2)}</Text>
                                <Text style={styles.statLabel}>{t('trips.statSpent')}</Text>
                            </View>
                            <View style={styles.statBox}>
                                <Text style={[styles.statValue, { color: stats.savings >= 0 ? colors.success : colors.textPrimary }]}>
                                    €{Math.abs(stats.savings).toFixed(2)}
                                </Text>
                                <Text style={styles.statLabel}>
                                    {stats.savings >= 0 ? t('trips.statSaved') : t('trips.statOverpaid')}
                                </Text>
                            </View>
                        </View>
                        {stats.categoryBreakdown.map(cat => (
                            <View key={cat.categoryName} style={styles.catRow}>
                                <Text style={styles.catName} numberOfLines={1}>{cat.categoryName}</Text>
                                <Text style={styles.catTotal}>€{cat.total.toFixed(2)}</Text>
                            </View>
                        ))}
                    </ScrollView>
                ) : (
                    <View style={styles.centered}>
                        <Text style={styles.hint}>{t('tripMap.statsLocked')}</Text>
                    </View>
                )}
            </View>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    chrome: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
    title: { fontSize: 22, fontWeight: '800', color: c.textPrimary },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
    hint: { fontSize: 14, color: c.textSecondary, textAlign: 'center', lineHeight: 20 },
    statsRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
    statBox: {
        flex: 1, backgroundColor: c.cardBackground, borderRadius: radius.lg,
        padding: spacing.lg, alignItems: 'center', gap: 4,
    },
    statValue: { fontSize: 20, fontWeight: '800', color: c.textPrimary },
    statLabel: { fontSize: 12, color: c.textSecondary },
    catRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
    catName: { flex: 1, fontSize: 14, color: c.textSecondary },
    catTotal: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
});
