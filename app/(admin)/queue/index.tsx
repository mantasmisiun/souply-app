import {
    View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator,
} from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Stack, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { glassHeaderOptions } from '../../../constants/navHeader';
import { ScreenHeading } from '../../../components/ScreenHeading';
import { getQueueCounts, type QueueCounts } from '../../../services/adminClient';
import { FlagsQueue } from '../../../components/admin/queue/FlagsQueue';
import { UncategorisedQueue } from '../../../components/admin/queue/UncategorisedQueue';
import { ImagesQueue } from '../../../components/admin/queue/ImagesQueue';
import { AmountsQueue } from '../../../components/admin/queue/AmountsQueue';
import { FailedReceiptsQueue } from '../../../components/admin/queue/FailedReceiptsQueue';

type ChipId = 'all' | 'flags' | 'uncategorised' | 'images' | 'amounts' | 'failedReceipts';
type QueueType = Exclude<ChipId, 'all'>;

const PRIORITY: QueueType[] = ['flags', 'uncategorised', 'images', 'amounts', 'failedReceipts'];

export default function QueueScreen() {
    const colors = useTheme();
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [activeChip, setActiveChip] = useState<ChipId>('all');
    const [counts, setCounts] = useState<QueueCounts | null>(null);
    const [countsLoading, setCountsLoading] = useState(true);

    // In "Visi" mode, which queue type is currently being served.
    const [servedType, setServedType] = useState<QueueType>('flags');

    const loadCounts = useCallback(async () => {
        try {
            const c = await getQueueCounts();
            setCounts(c);
        } catch {
            // Non-fatal — chips still show without badges.
        } finally {
            setCountsLoading(false);
        }
    }, []);

    useFocusEffect(useCallback(() => {
        loadCounts();
    }, [loadCounts]));

    // When counts arrive (or refresh), reset servedType to first non-empty queue.
    useEffect(() => {
        if (!counts) return;
        if (activeChip !== 'all') return;
        const first = PRIORITY.find(q => counts[q] > 0);
        if (first) setServedType(first);
    }, [counts, activeChip]);

    // Advance to the next non-empty queue in priority order.
    const handleEmpty = useCallback(async () => {
        // Re-fetch counts so we advance based on fresh data.
        let fresh: QueueCounts | null = null;
        try {
            fresh = await getQueueCounts();
            setCounts(fresh);
        } catch {
            // Keep existing counts.
            fresh = counts;
        }
        if (!fresh) return;
        const currentIdx = PRIORITY.indexOf(servedType);
        const next = PRIORITY.slice(currentIdx + 1).find(q => fresh![q] > 0);
        if (next) {
            setServedType(next);
        }
        // If no next type has items, counts will show zeroes — queue is done.
    }, [servedType, counts]);

    const badge = (q: QueueType) => {
        if (!counts || counts[q] === 0) return null;
        return (
            <View style={styles.badge}>
                <Text style={styles.badgeText}>
                    {counts[q] > 99 ? '99+' : String(counts[q])}
                </Text>
            </View>
        );
    };

    const chips: { id: ChipId; label: string }[] = [
        { id: 'all', label: t('admin.queue.chipAll') },
        { id: 'flags', label: t('admin.tabFlags') },
        { id: 'uncategorised', label: t('admin.tabUncategorised') },
        { id: 'images', label: t('admin.tabImages') },
        { id: 'amounts', label: t('admin.tabAmounts') },
        { id: 'failedReceipts', label: t('admin.tabFailed') },
    ];

    const activeQueueType: QueueType =
        activeChip === 'all' ? servedType : activeChip;

    const isAll = activeChip === 'all';

    return (
        <View style={styles.root}>
            <Stack.Screen options={glassHeaderOptions()} />
            <ScreenHeading title={t('admin.tabQueue')} topInset={insets.top} />
            <View style={styles.chipBar}>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.chipBarContent}
                >
                    {chips.map(chip => {
                        const active = chip.id === activeChip;
                        return (
                            <TouchableOpacity
                                key={chip.id}
                                style={[styles.chip, active && styles.chipActive]}
                                onPress={() => setActiveChip(chip.id)}
                            >
                                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                                    {chip.label}
                                </Text>
                                {chip.id !== 'all' && badge(chip.id as QueueType)}
                                {chip.id === 'all' && countsLoading && (
                                    <ActivityIndicator size={10} color={active ? colors.onPrimary : colors.textSecondary} style={{ marginLeft: 4 }} />
                                )}
                            </TouchableOpacity>
                        );
                    })}
                </ScrollView>
            </View>

            <View style={styles.queueContainer}>
                {activeQueueType === 'flags' && (
                    <FlagsQueue onEmpty={isAll ? handleEmpty : undefined} />
                )}
                {activeQueueType === 'uncategorised' && (
                    <UncategorisedQueue onEmpty={isAll ? handleEmpty : undefined} />
                )}
                {activeQueueType === 'images' && (
                    <ImagesQueue onEmpty={isAll ? handleEmpty : undefined} />
                )}
                {activeQueueType === 'amounts' && (
                    <AmountsQueue onEmpty={isAll ? handleEmpty : undefined} />
                )}
                {activeQueueType === 'failedReceipts' && (
                    <FailedReceiptsQueue onEmpty={isAll ? handleEmpty : undefined} />
                )}
            </View>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    root: { flex: 1, backgroundColor: c.pageBackground },
    chipBar: {
        backgroundColor: c.cardBackground,
        borderBottomWidth: 1,
        borderBottomColor: c.borderSubtle,
    },
    chipBarContent: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 6,
        paddingHorizontal: 14,
        borderRadius: 20,
        backgroundColor: c.surfaceMuted,
        gap: 6,
    },
    chipActive: { backgroundColor: c.primary },
    chipText: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
    chipTextActive: { color: c.onPrimary },
    badge: {
        backgroundColor: c.error,
        borderRadius: 10,
        minWidth: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    badgeText: { fontSize: 10, fontWeight: '700', color: '#fff' },
    queueContainer: { flex: 1 },
});
