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
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../../constants/theme';
import {
    claimAdminAmountBatch,
    getAdminAmountQueue,
    confirmAdminAmount,
    skipAdminAmount,
    fetchFlaggedReceiptCrop,
    fetchAmountSpReceiptCrop,
    type AdminAmountQueueRow,
    type CanonicalUnit,
} from '../../../services/adminClient';

const BATCH_SIZE = 10;
const UNITS: CanonicalUnit[] = ['g', 'kg', 'ml', 'l', 'vnt', 'rit'];

interface Props {
    /** Called when the queue is empty and no more items can be claimed.
     *  When provided (i.e. running inside the unified Eilė "Visi" flow),
     *  the empty-state UI is suppressed and the parent advances to the
     *  next queue type automatically. */
    onEmpty?: () => void;
}

export function AmountsQueue({ onEmpty }: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [rows, setRows] = useState<AdminAmountQueueRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [actioning, setActioning] = useState(false);

    const [amountInput, setAmountInput] = useState('');
    const [unitInput, setUnitInput] = useState<CanonicalUnit>('g');
    const [isWeighable, setIsWeighable] = useState(false);
    const [cropUri, setCropUri] = useState<string | null>(null);
    const [cropAspect, setCropAspect] = useState<number | null>(null);

    const currentCard = rows[0] ?? null;
    const canToggleWeighable = unitInput === 'kg' && amountInput.replace(',', '.').trim() === '1';

    useEffect(() => {
        if (!currentCard) return;
        setAmountInput(currentCard.suggestion ? String(currentCard.suggestion.amount) : '');
        setUnitInput(currentCard.suggestion?.unit ?? 'g');
        setIsWeighable(currentCard.storedIsWeighable);
        setCropUri(null);
        setCropAspect(null);
        const blobToUri = (blob: Blob) => new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
        });
        const fetchCrop = currentCard.flaggedByUser && currentCard.flagReceiptId !== null && currentCard.flagLineIdx !== null
            ? fetchFlaggedReceiptCrop(currentCard.flagReceiptId, currentCard.flagLineIdx)
            : fetchAmountSpReceiptCrop(currentCard.spId);
        fetchCrop
            .then(async res => { if (res) setCropUri(await blobToUri(res.blob)); })
            .catch(() => {}); // non-fatal
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

    // Notify parent when empty so the unified queue can advance.
    useEffect(() => {
        if (!loading && rows.length === 0 && onEmpty) {
            onEmpty();
        }
    }, [loading, rows.length, onEmpty]);

    const advance = useCallback(() => {
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
            const submitWeighable = canToggleWeighable ? isWeighable : false;
            const outcome = await confirmAdminAmount(currentCard.spId, {
                amount: amountNum,
                unit: unitInput,
                isWeighable: submitWeighable,
            });
            if (outcome === 'duplicate_size') {
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
        if (onEmpty) return null; // parent handles transition
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

            <KeyboardAwareScrollView contentContainerStyle={styles.cardScroll} keyboardShouldPersistTaps="handled" bottomOffset={72}>
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
                    {cropUri && (
                        <Image
                            source={{ uri: cropUri }}
                            style={[styles.cropImage, cropAspect ? { aspectRatio: cropAspect } : { height: 80 }]}
                            resizeMode="contain"
                            onLoad={({ nativeEvent: { source: { width, height } } }) => {
                                if (width > 0 && height > 0) setCropAspect(width / height);
                            }}
                        />
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

                    {canToggleWeighable && (
                        <TouchableOpacity
                            style={styles.checkboxRow}
                            onPress={() => setIsWeighable(v => !v)}
                            activeOpacity={0.7}
                        >
                            <View style={[styles.checkbox, isWeighable && styles.checkboxChecked]}>
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
            </KeyboardAwareScrollView>

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
    cropImage: { width: '100%', borderRadius: 8 },

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
    checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, paddingVertical: 8 },
    checkbox: {
        width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: c.border,
        alignItems: 'center', justifyContent: 'center', backgroundColor: c.cardBackground,
    },
    checkboxChecked: { backgroundColor: c.primary, borderColor: c.primary },
    checkboxLabel: { fontSize: 14, color: c.textPrimary, fontWeight: '500' },

    footer: { padding: 12, backgroundColor: c.cardBackground, borderTopWidth: 1, borderTopColor: c.borderSubtle },
    primaryBtn: { backgroundColor: c.primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
    primaryBtnDisabled: { backgroundColor: c.surfaceMuted },
    primaryBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: '700' },
});
