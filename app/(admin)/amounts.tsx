import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    Image,
    TextInput,
    Alert,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import {
    claimAdminAmountBatch,
    getAdminAmountQueue,
    confirmAdminAmount,
    skipAdminAmount,
    type AdminAmountQueueRow,
    type CanonicalUnit,
} from '../../services/adminClient';

/**
 * Amounts cleanup admin tab.
 *
 * Each card surfaces an SP where the regex parser found an amount in
 * the name that disagrees with the stored DB value (priority 2), or a
 * user-flagged mismatch (priority 1). The parser's suggestion pre-
 * fills the inputs; admin tweaks and confirms.
 *
 * Lease behaviour mirrors the images tab — claim 10, work through,
 * auto-claim next batch when stack empties.
 */

const BATCH_SIZE = 10;
const UNITS: CanonicalUnit[] = ['g', 'kg', 'ml', 'l', 'vnt', 'rit'];

export default function AdminAmountsScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [rows, setRows] = useState<AdminAmountQueueRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [actioning, setActioning] = useState(false);

    // Card-local editable form state. Re-initialised from the
    // suggestion whenever the top card changes (see effect below).
    const [amountInput, setAmountInput] = useState('');
    const [unitInput, setUnitInput] = useState<CanonicalUnit>('g');
    // Only relevant + adjustable when amount=1 AND unit=kg (the
    // ambiguous "1 kg" case — could be a packaged bag OR sold loose
    // by weight at the deli counter). For every other combination
    // isWeighable is forced false on submit, so this state only
    // matters when the toggle is visible.
    const [isWeighable, setIsWeighable] = useState(false);

    const currentCard = rows[0] ?? null;

    // The toggle is shown + interactive only when the chosen size is
    // a unit `1 kg`. Anything else (200 g, 500 ml, 2 vnt, …) is
    // unambiguously packaged.
    const canToggleWeighable = unitInput === 'kg' && amountInput.replace(',', '.').trim() === '1';

    useEffect(() => {
        if (!currentCard) return;
        // Suggestion may be null when the parser failed to produce a hint —
        // start with empty inputs so the admin types from scratch.
        setAmountInput(currentCard.suggestion ? String(currentCard.suggestion.amount) : '');
        // Default to 'g' (the initial state value) when no suggestion exists —
        // matches the queue's most common case for packaged goods.
        setUnitInput(currentCard.suggestion?.unit ?? 'g');
        // Seed from the stored value so an already-weighable 1kg item
        // stays weighable until the admin explicitly toggles it.
        setIsWeighable(currentCard.storedIsWeighable);
    }, [currentCard?.spId]);

    const loadQueue = useCallback(async (claimIfEmpty = true) => {
        setLoading(true);
        try {
            let res = await getAdminAmountQueue();
            if (res.rows.length === 0 && claimIfEmpty) {
                res = await claimAdminAmountBatch(BATCH_SIZE);
            }
            setRows(res.rows);
        } catch (e) {
            console.warn('[admin/amounts] queue load failed', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useFocusEffect(useCallback(() => {
        loadQueue();
    }, [loadQueue]));

    const advance = useCallback(() => {
        // Pop the top card and stop. When the local stack drops to 0,
        // the empty-state below renders with "Imti naują paketą" —
        // the admin claims the next batch explicitly, no auto-fetch.
        // Auto-claim used to flash that empty UI for a frame before
        // the next batch arrived; explicit-only is steadier.
        setRows(prev => prev.slice(1));
    }, []);

    const onConfirm = useCallback(async () => {
        if (!currentCard || actioning) return;
        const amountNum = parseFloat(amountInput.replace(',', '.'));
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            Alert.alert(t('admin.amounts.errorToast'));
            return;
        }
        setActioning(true);
        try {
            // isWeighable is admin-controlled only in the ambiguous
            // `1 kg` case. Everything else is a defined package size,
            // so force false.
            const submitWeighable = canToggleWeighable ? isWeighable : false;
            const outcome = await confirmAdminAmount(currentCard.spId, {
                amount: amountNum,
                unit: unitInput,
                isWeighable: submitWeighable,
            });
            if (outcome === 'duplicate_size') {
                // Same chain+product already has an SP at this size.
                // Server has already logged amount_skip + completed
                // the lease. Surface a clearer toast and advance.
                Alert.alert(t('admin.amounts.duplicateSizeToast'));
            }
            advance();
        } catch (e: any) {
            const msg = String(e?.message ?? '');
            Alert.alert(msg.includes('429')
                ? t('admin.amounts.rateLimitToast')
                : t('admin.amounts.errorToast'));
        } finally {
            setActioning(false);
        }
    }, [currentCard, actioning, amountInput, unitInput, advance, t]);

    const onSkip = useCallback(async () => {
        if (!currentCard || actioning) return;
        setActioning(true);
        try {
            await skipAdminAmount(currentCard.spId);
            advance();
        } catch {
            Alert.alert(t('admin.amounts.errorToast'));
        } finally {
            setActioning(false);
        }
    }, [currentCard, actioning, advance, t]);

    if (loading) {
        return (
            <View style={styles.centered}>
                <MaterialProgress size="large" color={colors.primary} />
            </View>
        );
    }
    if (!currentCard) {
        return (
            <View style={styles.centered}>
                <Ionicons name="checkmark-done-circle-outline" size={56} color={colors.success} />
                <Text style={styles.emptyTitle}>{t('admin.amounts.emptyTitle')}</Text>
                <Text style={styles.emptyBody}>{t('admin.amounts.emptyBody')}</Text>
                <TouchableOpacity style={styles.claimBtn} onPress={() => loadQueue()}>
                    <Text style={styles.claimBtnText}>{t('admin.amounts.claimBatch')}</Text>
                </TouchableOpacity>
            </View>
        );
    }

    const done = BATCH_SIZE - rows.length;
    const confirmEnabled = amountInput.trim().length > 0 && !actioning;

    return (
        <View style={styles.page}>
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <Text style={styles.progressText}>
                        {t('admin.amounts.leaseProgress', { done, total: BATCH_SIZE })}
                    </Text>
                </View>
                <TouchableOpacity
                    style={styles.headerSkip}
                    onPress={onSkip}
                    disabled={actioning}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                    <Ionicons name="play-skip-forward" size={18} color={colors.textSecondary} />
                    <Text style={styles.headerSkipText}>{t('admin.amounts.skip')}</Text>
                </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.cardScroll}>
                <View style={styles.card}>
                    <View style={styles.cardHeader}>
                        {currentCard.chainLogoUrl
                            ? <Image source={{ uri: currentCard.chainLogoUrl }} style={styles.chainLogo} resizeMode="contain" />
                            : <View style={[styles.chainLogo, { backgroundColor: colors.surfaceMuted }]} />}
                        <View style={styles.cardHeaderText}>
                            <Text style={styles.cardName} numberOfLines={2}>{currentCard.name}</Text>
                            <Text style={styles.cardMeta}>
                                {currentCard.categoryName} · {currentCard.recentPurchaseCount}
                            </Text>
                        </View>
                    </View>

                    {currentCard.flaggedByUser && (
                        <View style={styles.flagBanner}>
                            <Ionicons name="warning" size={16} color={colors.error} />
                            <Text style={styles.flagBannerText}>
                                {t('admin.amounts.flagBanner')}
                            </Text>
                        </View>
                    )}

                    <Text style={styles.sectionLabel}>{t('admin.amounts.currentLabel')}</Text>
                    <Text style={styles.currentValue}>
                        {currentCard.storedAmount === null
                            ? t('admin.amounts.noStored')
                            : `${currentCard.storedAmount} ${currentCard.storedUnit ?? ''}`.trim()}
                    </Text>

                    <Text style={styles.sectionLabel}>{t('admin.amounts.suggestionLabel')}</Text>
                    <View style={styles.formRow}>
                        <View style={styles.amountFieldWrap}>
                            <Text style={styles.fieldLabel}>{t('admin.amounts.amountField')}</Text>
                            <TextInput
                                style={styles.amountInput}
                                value={amountInput}
                                onChangeText={setAmountInput}
                                keyboardType="decimal-pad"
                                placeholder="0"
                                placeholderTextColor={colors.textMuted}
                            />
                        </View>
                        <View style={styles.unitFieldWrap}>
                            <Text style={styles.fieldLabel}>{t('admin.amounts.unitField')}</Text>
                            <View style={styles.unitChipsRow}>
                                {UNITS.map(u => {
                                    const selected = u === unitInput;
                                    return (
                                        <TouchableOpacity
                                            key={u}
                                            style={[styles.unitChip, selected && styles.unitChipSelected]}
                                            onPress={() => setUnitInput(u)}
                                        >
                                            <Text style={[
                                                styles.unitChipText,
                                                selected && styles.unitChipTextSelected,
                                            ]}>
                                                {u}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </View>
                    </View>

                    {currentCard.suggestion && (
                        <Text style={styles.matchedHint}>
                            {t('admin.amounts.matchedHint', { matched: currentCard.suggestion.matched })}
                        </Text>
                    )}

                    {/* Sveriama / Weighed-at-checkout toggle. Only the
                        unit-`1 kg` combination is ambiguous (loose at
                        deli vs 1 kg packaged bag) — for every other
                        amount/unit the SP is packaged, so the toggle
                        is hidden and the value is forced to false on
                        submit. */}
                    {canToggleWeighable && (
                        <TouchableOpacity
                            style={styles.checkboxRow}
                            onPress={() => setIsWeighable(v => !v)}
                            activeOpacity={0.7}
                        >
                            <View style={[
                                styles.checkbox,
                                isWeighable && styles.checkboxChecked,
                            ]}>
                                {isWeighable && (
                                    <Ionicons name="checkmark" size={14} color={colors.onPrimary} />
                                )}
                            </View>
                            <Text style={styles.checkboxLabel}>
                                {t('admin.amounts.weighable')}
                            </Text>
                        </TouchableOpacity>
                    )}
                </View>
            </ScrollView>

            <View style={styles.footer}>
                <TouchableOpacity
                    style={[styles.primaryBtn, !confirmEnabled && styles.primaryBtnDisabled]}
                    onPress={onConfirm}
                    disabled={!confirmEnabled}
                >
                    {actioning
                        ? <MaterialProgress color={colors.onPrimary} />
                        : <Text style={styles.primaryBtnText}>{t('admin.amounts.confirm')}</Text>}
                </TouchableOpacity>
            </View>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    page: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12, backgroundColor: c.pageBackground },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary, marginTop: 8 },
    emptyBody: { fontSize: 14, color: c.textSecondary, textAlign: 'center' },
    claimBtn: { backgroundColor: c.primary, paddingVertical: 12, paddingHorizontal: 32, borderRadius: 12, marginTop: 12 },
    claimBtnText: { color: c.onPrimary, fontSize: 15, fontWeight: '700' },

    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingBottom: 8 },
    headerLeft: { flex: 1 },
    progressText: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
    headerSkip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingVertical: 6, paddingHorizontal: 10,
        borderRadius: 8, backgroundColor: c.surfaceMuted,
    },
    headerSkipText: { fontSize: 13, color: c.textSecondary, fontWeight: '600' },

    cardScroll: { padding: 12, paddingBottom: 24 },
    card: { backgroundColor: c.cardBackground, borderRadius: 16, padding: 16, gap: 10 },
    cardHeader: { flexDirection: 'row', gap: 12, alignItems: 'center' },
    chainLogo: { width: 32, height: 32, borderRadius: 16 },
    cardHeaderText: { flex: 1 },
    cardName: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    cardMeta: { fontSize: 12, color: c.textSecondary, marginTop: 2 },

    flagBanner: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        backgroundColor: c.error + '15',
        borderColor: c.error, borderWidth: 1, borderRadius: 10, padding: 10,
    },
    flagBannerText: { color: c.error, fontSize: 13, flex: 1 },

    sectionLabel: { fontSize: 11, fontWeight: '600', color: c.textMuted, textTransform: 'uppercase', marginTop: 4 },
    currentValue: { fontSize: 18, fontWeight: '600', color: c.textPrimary },

    formRow: { gap: 12 },
    amountFieldWrap: {},
    unitFieldWrap: {},
    fieldLabel: { fontSize: 12, color: c.textSecondary, marginBottom: 6 },
    amountInput: {
        backgroundColor: c.surfaceMuted, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
        fontSize: 18, fontWeight: '600', color: c.textPrimary,
    },
    unitChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    unitChip: {
        paddingVertical: 10, paddingHorizontal: 16,
        borderRadius: 10, borderWidth: 1, borderColor: c.border,
        backgroundColor: c.surfaceMuted,
        minWidth: 56, alignItems: 'center',
    },
    unitChipSelected: { backgroundColor: c.primary, borderColor: c.primary },
    unitChipText: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    unitChipTextSelected: { color: c.onPrimary },

    matchedHint: { fontSize: 11, color: c.textMuted, fontStyle: 'italic' },
    checkboxRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginTop: 4,
        paddingVertical: 8,
    },
    checkbox: {
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 1.5,
        borderColor: c.border,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.cardBackground,
    },
    checkboxChecked: {
        backgroundColor: c.primary,
        borderColor: c.primary,
    },
    checkboxLabel: {
        fontSize: 14,
        color: c.textPrimary,
        fontWeight: '500',
    },

    footer: {
        padding: 12, backgroundColor: c.cardBackground,
        borderTopWidth: 1, borderTopColor: c.borderSubtle,
    },
    primaryBtn: { backgroundColor: c.primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
    primaryBtnDisabled: { backgroundColor: c.surfaceMuted },
    primaryBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: '700' },
});
