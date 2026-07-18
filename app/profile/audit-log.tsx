import {
    View,
    Text,
    StyleSheet,
    FlatList,
    TouchableOpacity,
    Alert,
    Image,
    ScrollView,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import Animated from 'react-native-reanimated';
import { useTheme, type AppTheme } from '../../constants/theme';
import { useCollapsingHeader, CollapsingHeader } from '../../components/CollapsingHeader';
import { ScreenHeading } from '../../components/ScreenHeading';
import { getAdminAuditLog, revertImageChange, type AuditLogRow } from '../../services/adminClient';

/**
 * Admin audit log. Reads paginate 50 rows at a time. Each row carries
 * hydrated `context` from the server (product name, thumbnail, chain)
 * so the card shows what the admin actually did instead of raw
 * `targetType #targetId` jargon.
 *
 * Filter chip row scopes to one tab's actions at a time (Visi / Žymos
 * / Kategorijos / Nuotraukos / Kiekiai).
 *
 * Only image-targeted rows are revertable today; the revert flow is
 * image-specific server-side. Other action families show a read-only
 * card with the diff.
 */

// Action families used by the filter chips. Add new actions here when
// new admin flows ship — the chip stays selectable as long as at
// least one action is mapped.
const ACTION_FAMILIES = {
    all: null as null | string[],
    flags: [
        'flag_resolve', 'flag_dismiss', 'flag_skip',
        'flag_price_suspect', 'flag_discount_suspect',
    ],
    uncategorised: ['uncategorised_set', 'uncategorised_delete', 'uncategorised_skip'],
    images: [
        'image_adopt_candidate', 'image_adopt_pending_upload', 'image_admin_upload',
        'image_remove', 'image_skip', 'image_reject_pending', 'image_revert',
    ],
    amounts: ['amount_set', 'amount_skip', 'amount_revert'],
} as const;
type FamilyKey = keyof typeof ACTION_FAMILIES;
const FAMILY_ORDER: FamilyKey[] = ['all', 'flags', 'uncategorised', 'images', 'amounts'];

const REVERTABLE_ACTIONS = new Set([
    'image_adopt_candidate',
    'image_adopt_pending_upload',
    'image_admin_upload',
    'image_remove',
]);

export default function AuditLogScreen() {
    const colors = useTheme();
    const header = useCollapsingHeader();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [rows, setRows] = useState<AuditLogRow[]>([]);
    const [page, setPage] = useState(0);
    const [loading, setLoading] = useState(true);
    const [reverting, setReverting] = useState<number | null>(null);
    const [done, setDone] = useState(false);
    const [family, setFamily] = useState<FamilyKey>('all');

    const loadPage = useCallback(async (pageNum: number, fam: FamilyKey) => {
        try {
            const actions = ACTION_FAMILIES[fam];
            const res = await getAdminAuditLog(
                pageNum,
                50,
                actions ? [...actions] : undefined,
            );
            setRows(prev => pageNum === 0 ? res.rows : [...prev, ...res.rows]);
            if (res.rows.length < 50) setDone(true);
            else setDone(false);
        } catch (e) {
            console.warn('[audit-log] load failed', e);
        } finally {
            setLoading(false);
        }
    }, []);

    // Initial load + family-change reload. Reset page + done on
    // filter change so the user starts from the top of the new filter.
    useEffect(() => {
        setLoading(true);
        setPage(0);
        setRows([]);
        setDone(false);
        loadPage(0, family);
    }, [family, loadPage]);

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

    return (
        <View style={styles.page}>
            <CollapsingHeader
                controller={header}
                back
                collapsing={<ScreenHeading title={t('admin.auditLogTitle')} />}
                pinned={
                    <View style={styles.chipsSurface}>
                        <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            contentContainerStyle={styles.chipsRow}
                        >
                            {FAMILY_ORDER.map(key => {
                                const selected = family === key;
                                return (
                                    <TouchableOpacity
                                        key={key}
                                        style={[styles.chip, selected && styles.chipSelected]}
                                        onPress={() => setFamily(key)}
                                    >
                                        <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                                            {t(`admin.audit.filter.${key}`)}
                                        </Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </ScrollView>
                    </View>
                }
            />

            {loading && rows.length === 0 ? (
                <View style={[styles.centered, { paddingTop: header.paddingTop }]}>
                    <MaterialProgress size="large" color={colors.primary} />
                </View>
            ) : rows.length === 0 ? (
                <View style={[styles.centered, { paddingTop: header.paddingTop }]}>
                    <Ionicons name="document-text-outline" size={48} color={colors.textMuted} />
                    <Text style={styles.emptyText}>{t('admin.audit.empty')}</Text>
                </View>
            ) : (
                <Animated.FlatList
                    {...header.scroll}
                    data={rows}
                    keyExtractor={(r: any) => String(r.id)}
                    contentContainerStyle={[styles.list, { paddingTop: header.paddingTop + 12 }]}
                    onEndReachedThreshold={0.4}
                    onEndReached={() => {
                        if (done || loading) return;
                        const next = page + 1;
                        setPage(next);
                        loadPage(next, family);
                    }}
                    renderItem={({ item }) => (
                        <AuditCard
                            row={item}
                            styles={styles}
                            colors={colors}
                            reverting={reverting === item.id}
                            onRevert={() => onRevert(item)}
                            t={t}
                        />
                    )}
                />
            )}
        </View>
    );
}

interface AuditCardProps {
    row: AuditLogRow;
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
    reverting: boolean;
    onRevert: () => void;
    t: (key: string, opts?: any) => string;
}

function AuditCard({ row, styles, colors, reverting, onRevert, t }: AuditCardProps) {
    const family = familyOf(row.action);
    const before = parsedJson(row.valueBefore);
    const after = parsedJson(row.valueAfter);
    const ctx = row.context ?? {};
    const canRevert = REVERTABLE_ACTIONS.has(row.action) && !row.reversedAt;

    // Subject line: product name first, fallback to chain+SP, then
    // to "Receipt #N line M" for flag rows, finally to bare id.
    const subject =
        ctx.productName
        || ctx.spName
        || (ctx.receiptId !== undefined ? `${t('admin.audit.receiptShort')} #${ctx.receiptId} · ${t('admin.audit.lineShort')} ${(ctx.lineIdx ?? 0) + 1}` : null)
        || before?.name
        || `${row.targetType} #${row.targetId}`;

    const subtitle = ctx.chainName ? ctx.chainName : null;

    // Thumbnail strategy:
    //  - Image actions (image_*) show the AFTER image to confirm the
    //    new state. Falls back to context.imageUrl.
    //  - Uncategorised + flag actions show the product/SP thumbnail
    //    (read-only context.imageUrl).
    //  - Amount actions: no useful thumbnail; show a generic icon.
    let thumbUri: string | null = null;
    if (family === 'images') {
        thumbUri = after?.imageUrl || ctx.imageUrl || before?.imageUrl || null;
    } else if (family === 'flags' || family === 'uncategorised') {
        thumbUri = ctx.imageUrl || null;
    }

    return (
        <View style={styles.row}>
            <View style={styles.thumbWrap}>
                {thumbUri ? (
                    <Image source={{ uri: thumbUri }} style={styles.thumb} resizeMode="cover" />
                ) : (
                    <View style={[styles.thumb, styles.thumbPlaceholder]}>
                        <Ionicons name={iconForFamily(family)} size={20} color={colors.textMuted} />
                    </View>
                )}
            </View>
            <View style={styles.rowLeft}>
                <Text style={styles.actionLabel} numberOfLines={1}>
                    {t(`admin.audit.action.${row.action}`, { defaultValue: row.action })}
                </Text>
                <Text style={styles.subject} numberOfLines={2}>{subject}</Text>
                {subtitle && <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>}
                <ActionDiff
                    action={row.action}
                    before={before}
                    after={after}
                    styles={styles}
                    t={t}
                />
                <Text style={styles.meta}>{timeAgo(row.createdAt)}</Text>
            </View>
            {row.reversedAt ? (
                <View style={styles.reversedChip}>
                    <Ionicons name="arrow-undo" size={12} color={colors.textMuted} />
                    <Text style={styles.reversedChipText}>{t('admin.audit.reversed')}</Text>
                </View>
            ) : canRevert ? (
                <TouchableOpacity
                    style={styles.revertBtn}
                    onPress={onRevert}
                    disabled={reverting}
                >
                    {reverting
                        ? <MaterialProgress size="small" color={colors.primary} />
                        : <Text style={styles.revertBtnText}>{t('admin.audit.revertButton')}</Text>}
                </TouchableOpacity>
            ) : null}
        </View>
    );
}

interface ActionDiffProps {
    action: string;
    before: any;
    after: any;
    styles: ReturnType<typeof makeStyles>;
    t: (key: string, opts?: any) => string;
}

/**
 * Compact human-readable diff for each action family. Keeps each
 * variant a single line; the row is already crowded by the thumbnail
 * + subject + revert button.
 */
function ActionDiff({ action, before, after, styles, t }: ActionDiffProps) {
    if (!before && !after) return null;
    // Flag-resolve carries a lot of fields. Surface only the ones
    // that actually changed.
    if (action === 'flag_resolve') {
        const parts: string[] = [];
        if (after?.storeProductName)
            parts.push(t('admin.audit.diff.renamed'));
        if (after?.productId !== undefined && after.productId !== before?.productId)
            parts.push(t('admin.audit.diff.relinked'));
        if (after?.categoryId !== undefined && after.categoryId !== before?.categoryId)
            parts.push(t('admin.audit.diff.recategorised'));
        if (after?.imageUrl !== undefined)
            parts.push(t('admin.audit.diff.imageChanged'));
        if (after?.price !== undefined)
            parts.push(t('admin.audit.diff.price', { v: after.price }));
        if (after?.promoPrice === null)
            parts.push(t('admin.audit.diff.discountRemoved'));
        else if (after?.promoPrice !== undefined)
            parts.push(t('admin.audit.diff.discount', { v: after.promoPrice }));
        if (parts.length === 0) return null;
        return <Text style={styles.delta} numberOfLines={2}>{parts.join(' · ')}</Text>;
    }
    if (action === 'uncategorised_set') {
        const parts: string[] = [];
        if (after?.categoryId)
            parts.push(t('admin.audit.diff.recategorised'));
        if (after?.name)
            parts.push(t('admin.audit.diff.renamed'));
        if (parts.length === 0) return null;
        return <Text style={styles.delta}>{parts.join(' · ')}</Text>;
    }
    if (action === 'uncategorised_delete') {
        return <Text style={styles.deltaDanger}>{t('admin.audit.diff.deleted')}</Text>;
    }
    if (action === 'amount_set') {
        const v =
            after?.amount !== undefined
                ? `${after.amount} ${after.unit ?? ''}`.trim()
                : null;
        if (!v) return null;
        return <Text style={styles.delta}>→ {v}</Text>;
    }
    if (action === 'image_adopt_candidate' || action === 'image_admin_upload' ||
        action === 'image_adopt_pending_upload' || action === 'image_revert') {
        return <Text style={styles.delta}>{t('admin.audit.diff.imageChanged')}</Text>;
    }
    if (action === 'image_remove') {
        return <Text style={styles.deltaDanger}>{t('admin.audit.diff.imageRemoved')}</Text>;
    }
    return null;
}

function familyOf(action: string): 'flags' | 'uncategorised' | 'images' | 'amounts' | 'other' {
    if (action.startsWith('flag_')) return 'flags';
    if (action.startsWith('uncategorised_')) return 'uncategorised';
    if (action.startsWith('image_')) return 'images';
    if (action.startsWith('amount_')) return 'amounts';
    return 'other';
}

function iconForFamily(family: ReturnType<typeof familyOf>): keyof typeof Ionicons.glyphMap {
    switch (family) {
        case 'flags': return 'flag-outline';
        case 'uncategorised': return 'help-circle-outline';
        case 'images': return 'image-outline';
        case 'amounts': return 'scale-outline';
        default: return 'document-text-outline';
    }
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
    page: { flex: 1, backgroundColor: c.pageBackground },
    // White strip housing the filter chips. Matches the Receipts-tab
    // filter bar so the audit log feels native to the rest of the app.
    chipsSurface: {
        backgroundColor: c.cardBackground,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: c.borderSubtle,
    },
    chipsRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 14, paddingVertical: 7,
        borderRadius: 20, borderWidth: 1, borderColor: c.border,
        backgroundColor: c.cardBackground,
    },
    chipSelected: { backgroundColor: c.primary, borderColor: c.primary },
    chipText: { fontSize: 13, color: c.textPrimary },
    chipTextSelected: { color: c.onPrimary, fontWeight: '600' },

    list: { padding: 12, gap: 8 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12, backgroundColor: c.pageBackground },
    emptyText: { fontSize: 14, color: c.textSecondary },

    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        padding: 12,
        backgroundColor: c.cardBackground,
        borderRadius: 10,
    },
    thumbWrap: { width: 48, height: 48 },
    thumb: { width: 48, height: 48, borderRadius: 8, backgroundColor: c.surfaceMuted },
    thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },

    rowLeft: { flex: 1, gap: 2 },
    actionLabel: { fontSize: 11, fontWeight: '700', color: c.primary, textTransform: 'uppercase' },
    subject: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    subtitle: { fontSize: 11, color: c.textSecondary },
    delta: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    deltaDanger: { fontSize: 12, color: c.error, marginTop: 2 },
    meta: { fontSize: 11, color: c.textMuted, marginTop: 4 },

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
