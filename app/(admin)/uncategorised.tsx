import {
    View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView,
    Image, TextInput, Alert,
} from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import {
    claimAdminUncategorisedBatch,
    getAdminUncategorisedQueue,
    confirmAdminUncategorised,
    deleteAdminUncategorised,
    skipAdminUncategorised,
    searchAdminCategories,
    type AdminUncategorisedRow,
    type AdminCategorySearchRow,
} from '../../services/adminClient';

/**
 * Uncategorised (Nepriskirti) admin tab — Tab 4.
 *
 * Surfaces Products sitting in the Nepriskirta fallback bucket
 * (categoryId = 688 by default). Per-Product card. Required action:
 * assign a real category. Optional: edit the Product name. Destructive:
 * delete the Product entirely (with FK-safe pre-check).
 *
 * Reuses the Flags tab's Section + typeahead patterns; no image
 * candidate picker here (image cleanup lives in the Nuotraukos tab).
 */

const BATCH_SIZE = 10;

export default function AdminUncategorisedScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [rows, setRows] = useState<AdminUncategorisedRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [actioning, setActioning] = useState(false);

    // Editable form state — re-seeded when the top card changes.
    const [nameInput, setNameInput] = useState('');
    const [categoryInput, setCategoryInput] = useState('');
    const [categoryPickedId, setCategoryPickedId] = useState<number | null>(null);
    const [categorySuggestions, setCategorySuggestions] = useState<AdminCategorySearchRow[]>([]);
    const [categorySearchOpen, setCategorySearchOpen] = useState(false);

    const currentCard = rows[0] ?? null;

    useEffect(() => {
        if (!currentCard) return;
        setNameInput(currentCard.productName);
        setCategoryInput('');
        setCategoryPickedId(null);
        setCategorySuggestions([]);
        setCategorySearchOpen(false);
    }, [currentCard?.productId]);

    // Debounced category search — same pattern as the Flags tab.
    useEffect(() => {
        if (!categorySearchOpen) return;
        const picked = categorySuggestions.find(s => s.id === categoryPickedId);
        if (picked && categoryInput.trim() === picked.name.trim()) {
            setCategorySuggestions([]);
            return;
        }
        const q = categoryInput.trim();
        if (q.length === 0) {
            setCategorySuggestions([]);
            return;
        }
        const timer = setTimeout(async () => {
            try {
                const matches = await searchAdminCategories(q);
                setCategorySuggestions(matches);
            } catch (e) {
                console.warn('[admin/uncategorised] category search failed', e);
            }
        }, 220);
        return () => clearTimeout(timer);
    }, [categoryInput, categorySearchOpen, categoryPickedId]);

    const loadQueue = useCallback(async (claimIfEmpty = true) => {
        setLoading(true);
        try {
            let res = await getAdminUncategorisedQueue();
            if (res.rows.length === 0 && claimIfEmpty) {
                res = await claimAdminUncategorisedBatch(BATCH_SIZE);
            }
            setRows(res.rows);
        } catch (e) {
            console.warn('[admin/uncategorised] queue load failed', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useFocusEffect(useCallback(() => { loadQueue(); }, [loadQueue]));

    const advance = useCallback(() => {
        setRows(prev => prev.slice(1));
    }, []);

    const onConfirm = useCallback(async () => {
        if (!currentCard || actioning || categoryPickedId === null) return;
        setActioning(true);
        try {
            const trimmedName = nameInput.trim();
            const payload: { categoryId: number; name?: string } = { categoryId: categoryPickedId };
            if (trimmedName.length > 0 && trimmedName !== currentCard.productName.trim()) {
                payload.name = trimmedName;
            }
            await confirmAdminUncategorised(currentCard.productId, payload);
            advance();
        } catch (e: any) {
            const msg = String(e?.message ?? '');
            Alert.alert(msg.includes('429')
                ? t('admin.uncategorised.rateLimitToast')
                : t('admin.uncategorised.errorToast'));
        } finally {
            setActioning(false);
        }
    }, [currentCard, actioning, nameInput, categoryPickedId, advance, t]);

    const onDelete = useCallback(() => {
        if (!currentCard || actioning) return;
        Alert.alert(
            t('admin.uncategorised.deleteConfirmTitle'),
            t('admin.uncategorised.deleteConfirmBody', { name: currentCard.productName }),
            [
                { text: t('admin.uncategorised.cancel'), style: 'cancel' },
                {
                    text: t('admin.uncategorised.deleteConfirm'),
                    style: 'destructive',
                    onPress: async () => {
                        setActioning(true);
                        try {
                            const r = await deleteAdminUncategorised(currentCard.productId);
                            if (!r.ok) {
                                Alert.alert(
                                    t('admin.uncategorised.deleteBlockedTitle'),
                                    t('admin.uncategorised.deleteBlockedBody', {
                                        prices: r.blockers.prices,
                                        baskets: r.blockers.basketItems,
                                        lists: r.blockers.shoppingListItems,
                                    }),
                                );
                                return;
                            }
                            advance();
                        } catch {
                            Alert.alert(t('admin.uncategorised.errorToast'));
                        } finally {
                            setActioning(false);
                        }
                    },
                },
            ],
        );
    }, [currentCard, actioning, advance, t]);

    const onSkip = useCallback(async () => {
        if (!currentCard || actioning) return;
        setActioning(true);
        try {
            await skipAdminUncategorised(currentCard.productId);
            advance();
        } catch {
            Alert.alert(t('admin.uncategorised.errorToast'));
        } finally {
            setActioning(false);
        }
    }, [currentCard, actioning, advance, t]);

    if (loading) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" color={colors.primary} />
            </View>
        );
    }
    if (!currentCard) {
        return (
            <View style={styles.centered}>
                <Ionicons name="checkmark-done-circle-outline" size={56} color={colors.success} />
                <Text style={styles.emptyTitle}>{t('admin.uncategorised.emptyTitle')}</Text>
                <Text style={styles.emptyBody}>{t('admin.uncategorised.emptyBody')}</Text>
                <TouchableOpacity style={styles.claimBtn} onPress={() => loadQueue()}>
                    <Text style={styles.claimBtnText}>{t('admin.uncategorised.claimBatch')}</Text>
                </TouchableOpacity>
            </View>
        );
    }

    const done = BATCH_SIZE - rows.length;
    const canConfirm = categoryPickedId !== null && !actioning;

    return (
        <View style={styles.page}>
            <View style={styles.header}>
                <Text style={styles.progressText}>
                    {t('admin.uncategorised.leaseProgress', { done, total: BATCH_SIZE })}
                </Text>
                <TouchableOpacity
                    style={styles.headerSkip}
                    onPress={onSkip}
                    disabled={actioning}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                    <Ionicons name="play-skip-forward" size={18} color={colors.textSecondary} />
                    <Text style={styles.headerSkipText}>{t('admin.uncategorised.skip')}</Text>
                </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.cardScroll}>
                <View style={styles.card}>
                    {/* Header row */}
                    <View style={styles.cardHeader}>
                        {currentCard.bestImageUrl
                            ? <Image source={{ uri: currentCard.bestImageUrl }} style={styles.cardThumb} resizeMode="cover" />
                            : <View style={[styles.cardThumb, styles.cardThumbPlaceholder]}>
                                  <Ionicons name="image-outline" size={24} color={colors.textMuted} />
                              </View>}
                        <View style={styles.cardHeaderText}>
                            <Text style={styles.cardName} numberOfLines={2}>{currentCard.productName}</Text>
                            <View style={styles.unsortedBadgeRow}>
                                <View style={styles.unsortedBadge}>
                                    <Text style={styles.unsortedBadgeText}>{t('admin.uncategorised.badgeUnsorted')}</Text>
                                </View>
                            </View>
                        </View>
                    </View>

                    {/* Coverage banner — gives admin context before action */}
                    <View style={styles.coverageBanner}>
                        <Text style={styles.coverageLine}>
                            {t('admin.uncategorised.coverageLine', {
                                purchases: currentCard.recentPurchaseCount,
                                chains: currentCard.chainCoverage || '—',
                                sps: currentCard.spCount,
                            })}
                        </Text>
                        {currentCard.hasPendingFlags && (
                            <Text style={styles.warningLine}>
                                <Ionicons name="warning" size={12} color={colors.warning} /> {t('admin.uncategorised.hasPendingFlags')}
                            </Text>
                        )}
                        {currentCard.baseProductLinkCount > 0 && (
                            <Text style={styles.warningLine}>
                                <Ionicons name="link" size={12} color={colors.warning} /> {t('admin.uncategorised.hasBplLinks', { count: currentCard.baseProductLinkCount })}
                            </Text>
                        )}
                    </View>

                    {/* Name (optional edit) */}
                    <Section title={t('admin.uncategorised.sectionName')} styles={styles}>
                        <TextInput
                            style={styles.textInput}
                            value={nameInput}
                            onChangeText={setNameInput}
                        />
                    </Section>

                    {/* Category — REQUIRED; pink-accented because this is the whole point */}
                    <Section
                        title={t('admin.uncategorised.sectionCategory')}
                        styles={styles}
                        required
                    >
                        <View style={styles.typeaheadRow}>
                            <TextInput
                                style={[styles.textInput, styles.typeaheadInput]}
                                value={categoryInput}
                                onChangeText={(text) => {
                                    setCategoryInput(text);
                                    setCategorySearchOpen(true);
                                    setCategoryPickedId(null);
                                }}
                                onFocus={() => setCategorySearchOpen(true)}
                                placeholder={t('admin.uncategorised.categoryPlaceholder')}
                                placeholderTextColor={colors.textMuted}
                            />
                            {categorySearchOpen && (
                                <TouchableOpacity
                                    style={styles.typeaheadLockBtn}
                                    onPress={() => {
                                        setCategorySearchOpen(false);
                                        setCategorySuggestions([]);
                                    }}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                >
                                    <Ionicons name="checkmark" size={18} color={colors.primary} />
                                </TouchableOpacity>
                            )}
                        </View>
                        {categorySearchOpen && categorySuggestions.length > 0 && (
                            <View style={styles.suggestionList}>
                                {categorySuggestions.map((s) => (
                                    <TouchableOpacity
                                        key={s.id}
                                        style={styles.suggestionRow}
                                        onPress={() => {
                                            setCategoryInput(s.name);
                                            setCategoryPickedId(s.id);
                                            setCategorySearchOpen(false);
                                            setCategorySuggestions([]);
                                        }}
                                    >
                                        <Text style={styles.suggestionText} numberOfLines={1}>{s.name}</Text>
                                        <Text style={styles.suggestionMeta} numberOfLines={1}>{s.path}</Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                    </Section>
                </View>
            </ScrollView>

            <View style={styles.footer}>
                <TouchableOpacity
                    style={[styles.primaryBtn, !canConfirm && styles.primaryBtnDisabled]}
                    onPress={onConfirm}
                    disabled={!canConfirm}
                >
                    {actioning
                        ? <ActivityIndicator color={colors.onPrimary} />
                        : <Text style={styles.primaryBtnText}>{t('admin.uncategorised.confirm')}</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                    style={styles.deleteBtn}
                    onPress={onDelete}
                    disabled={actioning}
                >
                    <Ionicons name="trash-outline" size={16} color={colors.error} />
                    <Text style={styles.deleteBtnText}>{t('admin.uncategorised.delete')}</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
}

interface SectionProps {
    title: string;
    required?: boolean;
    children: React.ReactNode;
    styles: ReturnType<typeof makeStyles>;
}
function Section({ title, required, children, styles }: SectionProps) {
    return (
        <View style={[styles.section, required && styles.sectionRequired]}>
            <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, required && styles.sectionTitleRequired]}>{title}</Text>
                {required && (
                    <View style={styles.requiredPill}>
                        <Text style={styles.requiredPillText}>!</Text>
                    </View>
                )}
            </View>
            {children}
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
    progressText: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
    headerSkip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingVertical: 6, paddingHorizontal: 10,
        borderRadius: 8, backgroundColor: c.surfaceMuted,
    },
    headerSkipText: { fontSize: 13, color: c.textSecondary, fontWeight: '600' },

    cardScroll: { padding: 12, paddingBottom: 24 },
    card: { backgroundColor: c.cardBackground, borderRadius: 16, padding: 16, gap: 12 },
    cardHeader: { flexDirection: 'row', gap: 12, alignItems: 'center' },
    cardThumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: c.surfaceMuted },
    cardThumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
    cardHeaderText: { flex: 1 },
    cardName: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    unsortedBadgeRow: { flexDirection: 'row', marginTop: 4 },
    unsortedBadge: { backgroundColor: c.warning + '22', borderColor: c.warning, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
    unsortedBadgeText: { color: c.warning, fontSize: 11, fontWeight: '700' },

    coverageBanner: { backgroundColor: c.pageBackground, borderRadius: 10, padding: 10, gap: 4 },
    coverageLine: { fontSize: 12, color: c.textSecondary },
    warningLine: { fontSize: 11, color: c.warning, marginTop: 2 },

    section: {
        marginTop: 4,
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: c.borderSubtle,
        backgroundColor: c.pageBackground,
        gap: 8,
    },
    sectionRequired: {
        borderColor: c.primary,
        borderLeftWidth: 4,
        backgroundColor: c.primary + '12',
    },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    sectionTitle: { fontSize: 12, fontWeight: '700', color: c.textSecondary, textTransform: 'uppercase' },
    sectionTitleRequired: { color: c.primary },
    requiredPill: {
        paddingHorizontal: 6, paddingVertical: 1, minWidth: 18,
        borderRadius: 10, backgroundColor: c.primary, alignItems: 'center',
    },
    requiredPillText: { color: c.onPrimary, fontSize: 11, fontWeight: '800' },

    textInput: {
        backgroundColor: c.cardBackground, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
        fontSize: 14, color: c.textPrimary, borderWidth: 1, borderColor: c.borderSubtle,
    },
    typeaheadRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
    typeaheadInput: { flex: 1 },
    typeaheadLockBtn: {
        width: 38, height: 38, borderRadius: 8,
        borderWidth: 1, borderColor: c.primary,
        backgroundColor: c.primary + '12',
        alignItems: 'center', justifyContent: 'center',
    },
    suggestionList: {
        marginTop: 4,
        backgroundColor: c.cardBackground,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.borderSubtle,
    },
    suggestionRow: {
        paddingHorizontal: 12, paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: c.borderSubtle,
    },
    suggestionText: { fontSize: 14, color: c.textPrimary },
    suggestionMeta: { fontSize: 11, color: c.textMuted, marginTop: 2 },

    footer: {
        padding: 12, backgroundColor: c.cardBackground,
        borderTopWidth: 1, borderTopColor: c.borderSubtle,
        gap: 8,
    },
    primaryBtn: { backgroundColor: c.primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
    primaryBtnDisabled: { backgroundColor: c.surfaceMuted },
    primaryBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: '700' },
    deleteBtn: {
        flexDirection: 'row',
        alignSelf: 'center',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 8,
    },
    deleteBtnText: { color: c.error, fontSize: 13, fontWeight: '600' },
});
