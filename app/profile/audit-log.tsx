import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import { getAdminAuditLog, revertImageChange, type AuditLogRow } from '../../services/adminClient';

/**
 * Admin audit log. Lists every reversible action with a one-tap
 * Revert button per row. Reads paginate 50 at a time; for v1 the
 * scroll just loads more on-end-reached.
 *
 * Only image-targeted rows are revertable from this screen because
 * the revert endpoint is image-specific in v1. Other rows render
 * read-only with a disabled chip.
 */

const REVERTABLE_ACTIONS = new Set([
    'image_adopt_candidate',
    'image_adopt_pending_upload',
    'image_admin_upload',
    'image_remove',
]);

export default function AuditLogScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [rows, setRows] = useState<AuditLogRow[]>([]);
    const [page, setPage] = useState(0);
    const [loading, setLoading] = useState(true);
    const [reverting, setReverting] = useState<number | null>(null);
    const [done, setDone] = useState(false);

    const loadPage = useCallback(async (pageNum: number) => {
        try {
            const res = await getAdminAuditLog(pageNum, 50);
            setRows(prev => pageNum === 0 ? res.rows : [...prev, ...res.rows]);
            if (res.rows.length < 50) setDone(true);
        } catch (e) {
            console.warn('[audit-log] load failed', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadPage(0); }, [loadPage]);

    const onRevert = useCallback(async (row: AuditLogRow) => {
        if (!REVERTABLE_ACTIONS.has(row.action) || row.reversedAt) return;
        setReverting(row.id);
        try {
            await revertImageChange(row.id);
            setRows(prev => prev.map(r =>
                r.id === row.id ? { ...r, reversedAt: new Date().toISOString() } : r,
            ));
        } catch (e) {
            Alert.alert(t('admin.images.errorToast'));
        } finally {
            setReverting(null);
        }
    }, [t]);

    if (loading && rows.length === 0) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" color={colors.primary} />
            </View>
        );
    }

    if (rows.length === 0) {
        return (
            <View style={styles.centered}>
                <Ionicons name="document-text-outline" size={48} color={colors.textMuted} />
                <Text style={styles.emptyText}>{t('admin.audit.empty')}</Text>
            </View>
        );
    }

    return (
        <FlatList
            data={rows}
            keyExtractor={r => String(r.id)}
            contentContainerStyle={styles.list}
            onEndReachedThreshold={0.4}
            onEndReached={() => {
                if (done || loading) return;
                const next = page + 1;
                setPage(next);
                loadPage(next);
            }}
            renderItem={({ item }) => {
                const canRevert = REVERTABLE_ACTIONS.has(item.action) && !item.reversedAt;
                const before = parsedJson(item.valueBefore);
                const after = parsedJson(item.valueAfter);
                return (
                    <View style={styles.row}>
                        <View style={styles.rowLeft}>
                            <Text style={styles.action}>{item.action}</Text>
                            <Text style={styles.meta} numberOfLines={1}>
                                {item.targetType} #{item.targetId} · {timeAgo(item.createdAt)}
                            </Text>
                            {before?.imageUrl !== undefined && (
                                <Text style={styles.delta} numberOfLines={1}>
                                    {before.imageUrl ? '…' + String(before.imageUrl).slice(-20) : '∅'}
                                    {' → '}
                                    {after?.imageUrl ? '…' + String(after.imageUrl).slice(-20) : '∅'}
                                </Text>
                            )}
                        </View>
                        {item.reversedAt ? (
                            <View style={styles.reversedChip}>
                                <Ionicons name="arrow-undo" size={12} color={colors.textMuted} />
                                <Text style={styles.reversedChipText}>{t('admin.audit.reversed')}</Text>
                            </View>
                        ) : canRevert ? (
                            <TouchableOpacity
                                style={styles.revertBtn}
                                onPress={() => onRevert(item)}
                                disabled={reverting === item.id}
                            >
                                {reverting === item.id ? (
                                    <ActivityIndicator size="small" color={colors.primary} />
                                ) : (
                                    <Text style={styles.revertBtnText}>{t('admin.audit.revertButton')}</Text>
                                )}
                            </TouchableOpacity>
                        ) : null}
                    </View>
                );
            }}
        />
    );
}

function parsedJson(v: any): any {
    if (v == null) return null;
    if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return null; }
    }
    return v;
}

function timeAgo(iso: string): string {
    const d = new Date(iso);
    const diffMin = Math.max(1, Math.round((Date.now() - d.getTime()) / 60000));
    if (diffMin < 60) return `${diffMin}m`;
    const diffH = Math.round(diffMin / 60);
    if (diffH < 24) return `${diffH}h`;
    return `${Math.round(diffH / 24)}d`;
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    list: { padding: 12, gap: 8 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12, backgroundColor: c.pageBackground },
    emptyText: { fontSize: 14, color: c.textSecondary },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        backgroundColor: c.cardBackground,
        borderRadius: 10,
    },
    rowLeft: { flex: 1 },
    action: { fontSize: 13, fontWeight: '700', color: c.textPrimary },
    meta: { fontSize: 11, color: c.textMuted, marginTop: 2 },
    delta: { fontSize: 11, color: c.textSecondary, marginTop: 2 },
    revertBtn: {
        paddingVertical: 6, paddingHorizontal: 12,
        borderRadius: 8, borderWidth: 1, borderColor: c.primary,
    },
    revertBtnText: { fontSize: 12, color: c.primary, fontWeight: '600' },
    reversedChip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingVertical: 4, paddingHorizontal: 8,
        backgroundColor: c.surfaceMuted, borderRadius: 6,
    },
    reversedChipText: { fontSize: 11, color: c.textMuted },
});
