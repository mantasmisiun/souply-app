import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from './MaterialProgress';
import { useReceiptQueueStore } from '../state/receiptQueueStore';
import { useTheme, spacing, radius, typography, type AppTheme } from '../constants/theme';

// How long the "done" confirmation lingers before auto-hiding.
const DONE_LINGER_MS = 7000;

type BannerState =
    | { mode: 'processing'; progress?: string; done?: number; total?: number }
    | { mode: 'queued'; count: number }
    | { mode: 'awaiting' }
    | { mode: 'error' }
    | { mode: 'done'; receiptId: number | null }
    | null;

/**
 * Global, non-intrusive receipt-processing banner. Receipts scanned/uploaded
 * from a list or trip process silently in the background queue instead of the
 * full-screen scan flow; this thin top bar reports progress and, on completion,
 * offers a "View" jump to the finished receipt. Lives OUTSIDE the tab Stack so
 * it follows the user across screens.
 */
export function ReceiptProcessingBanner() {
    const colors = useTheme();
    const { t } = useTranslation();
    const router = useRouter();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const items = useReceiptQueueStore((s) => s.items);
    const recentIds = useReceiptQueueStore((s) => s.recentIds);
    const lastCompletedAt = useReceiptQueueStore((s) => s.lastCompletedAt);

    // Track which completion we've already dismissed so the "done" banner
    // shows once per completion (and can be manually closed).
    const [dismissedAt, setDismissedAt] = useState<number | null>(null);

    // Auto-hide the done state after it lingers.
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (!lastCompletedAt || lastCompletedAt === dismissedAt) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setDismissedAt(lastCompletedAt), DONE_LINGER_MS);
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [lastCompletedAt, dismissedAt]);

    const state: BannerState = useMemo(() => {
        const processing = items.find((i) => i.status === 'processing');
        if (processing) {
            return { mode: 'processing', progress: processing.progress, done: processing.progressDone, total: processing.progressTotal };
        }
        const pending = items.filter((i) => i.status === 'pending');
        if (pending.length > 0) return { mode: 'queued', count: pending.length };
        if (items.some((i) => i.status === 'awaiting_network')) return { mode: 'awaiting' };
        if (items.some((i) => i.status === 'error')) return { mode: 'error' };
        // No active items — show the just-completed confirmation once.
        if (lastCompletedAt && lastCompletedAt !== dismissedAt) {
            return { mode: 'done', receiptId: recentIds.length > 0 ? recentIds[recentIds.length - 1] : null };
        }
        return null;
    }, [items, recentIds, lastCompletedAt, dismissedAt]);

    if (!state) return null;

    const pct =
        state.mode === 'processing' && state.total && state.total > 0
            ? Math.max(0.04, Math.min(1, (state.done ?? 0) / state.total))
            : null;

    const isDone = state.mode === 'done';
    const isError = state.mode === 'error';

    const label = (() => {
        switch (state.mode) {
            case 'processing': return state.progress || t('banners.receiptQueue.processing');
            case 'queued': return t('banners.receiptQueue.queued', { count: state.count });
            case 'awaiting': return t('banners.receiptQueue.awaitingNetwork');
            case 'error': return t('banners.receiptQueue.error');
            case 'done': return t('banners.receiptQueue.done');
        }
    })();

    const viewReceipt = () => {
        if (state.mode !== 'done') return;
        setDismissedAt(lastCompletedAt);
        if (state.receiptId != null) router.push(`/receipt-process?receiptId=${state.receiptId}` as any);
        else router.push('/receipt' as any);
    };

    return (
        <SafeAreaView edges={['top']} style={{ backgroundColor: colors.surfaceContainer }}>
            <View style={[styles.bar, isError && { backgroundColor: colors.errorMuted }]}>
                {isDone ? (
                    <Ionicons name="checkmark-circle" size={18} color={colors.primary} />
                ) : isError ? (
                    <Ionicons name="alert-circle" size={18} color={colors.error} />
                ) : (
                    <MaterialProgress size={16} color={colors.primary} />
                )}

                <Text style={[styles.label, isError && { color: colors.error }]} numberOfLines={1}>
                    {label}
                </Text>

                {isDone ? (
                    <TouchableOpacity onPress={viewReceipt} hitSlop={8} style={styles.viewBtn}>
                        <Text style={styles.viewText}>{t('banners.receiptQueue.view')}</Text>
                    </TouchableOpacity>
                ) : null}

                {(isDone || isError) ? (
                    <TouchableOpacity onPress={() => setDismissedAt(lastCompletedAt)} hitSlop={8}>
                        <Ionicons name="close" size={18} color={colors.textSecondary} />
                    </TouchableOpacity>
                ) : null}
            </View>

            {/* Thin progress line — determinate during product matching, a subtle
                full track otherwise. Hidden on the terminal done/error states. */}
            {!isDone && !isError && (
                <View style={styles.track}>
                    <View style={[styles.fill, pct != null ? { width: `${pct * 100}%` } : styles.fillIndeterminate]} />
                </View>
            )}
        </SafeAreaView>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: 8,
    },
    label: { flex: 1, ...typography.bodySmall, fontWeight: '600', color: c.textPrimary },
    viewBtn: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: c.secondaryContainer },
    viewText: { ...typography.labelSmall, fontWeight: '800', color: c.primary },
    track: { height: 2, backgroundColor: c.border },
    fill: { height: 2, backgroundColor: c.primary },
    fillIndeterminate: { width: '40%', opacity: 0.5 },
});
