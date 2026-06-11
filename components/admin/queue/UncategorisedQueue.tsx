import {
    View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView,
    Image, TextInput, Alert,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { ChainLogoStrip } from '../../ChainLogoStrip';
import {
    claimAdminUncategorisedBatch,
    getAdminUncategorisedQueue,
    confirmAdminUncategorised,
    deleteAdminUncategorised,
    skipAdminUncategorised,
    searchAdminCategories,
    getAdminUncategorisedSourceReceipt,
    getAdminCategorySuggestions,
    fetchFlaggedReceiptCrop,
    type AdminUncategorisedRow,
    type AdminCategorySearchRow,
    type AdminCategorySuggestion,
    type SourceReceiptInfo,
} from '../../../services/adminClient';

function blobToDataUri(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const r = reader.result;
            if (typeof r === 'string') resolve(r);
            else reject(new Error('FileReader returned non-string'));
        };
        reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
        reader.readAsDataURL(blob);
    });
}

const BATCH_SIZE = 10;

interface Props {
    onEmpty?: () => void;
}

export function UncategorisedQueue({ onEmpty }: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();

    const [rows, setRows] = useState<AdminUncategorisedRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [actioning, setActioning] = useState(false);

    const [nameInput, setNameInput] = useState('');
    const [nameSource, setNameSource] = useState<'matched' | 'ocr' | null>('matched');
    const [categoryInput, setCategoryInput] = useState('');
    const [categoryPickedId, setCategoryPickedId] = useState<number | null>(null);
    const [categorySuggestions, setCategorySuggestions] = useState<AdminCategorySearchRow[]>([]);
    const [categorySearchOpen, setCategorySearchOpen] = useState(false);
    const [categoryHints, setCategoryHints] = useState<AdminCategorySuggestion[]>([]);

    const [sourceReceipt, setSourceReceipt] = useState<SourceReceiptInfo | null>(null);
    const [cropUri, setCropUri] = useState<string | null>(null);
    const [cropLoading, setCropLoading] = useState(false);
    const [cropAspectRatio, setCropAspectRatio] = useState<number | null>(null);

    const currentCard = rows[0] ?? null;

    useEffect(() => {
        if (!currentCard) return;
        setNameInput(currentCard.productName);
        setNameSource('matched');
        setCategoryInput('');
        setCategoryPickedId(null);
        setCategorySuggestions([]);
        setCategorySearchOpen(false);
        setCategoryHints([]);
    }, [currentCard?.productId]);

    useEffect(() => {
        if (!currentCard) {
            setSourceReceipt(null);
            setCropUri(null);
            return;
        }
        let cancelled = false;
        setCropLoading(true);
        setSourceReceipt(null);
        setCropUri(null);
        setCropAspectRatio(null);

        (async () => {
            try {
                const info = await getAdminUncategorisedSourceReceipt(currentCard.productId);
                if (cancelled) return;
                setSourceReceipt(info);
                if (!info) { setCropLoading(false); return; }
                const cropRes = await fetchFlaggedReceiptCrop(info.receiptId, info.lineIdx);
                if (cancelled) return;
                if (cropRes) {
                    const uri = await blobToDataUri(cropRes.blob);
                    if (!cancelled) setCropUri(uri);
                }
            } catch (e) {
                console.warn('[admin/uncategorised] source receipt load failed', e);
            } finally {
                if (!cancelled) setCropLoading(false);
            }
        })();

        (async () => {
            try {
                const hints = await getAdminCategorySuggestions(currentCard.productId);
                if (!cancelled) setCategoryHints(hints);
            } catch {
                // Non-critical
            }
        })();
        return () => { cancelled = true; };
    }, [currentCard?.productId]);

    useEffect(() => {
        if (!categorySearchOpen) return;
        const picked = categorySuggestions.find(s => s.id === categoryPickedId);
        if (picked && categoryInput.trim() === picked.name.trim()) {
            setCategorySuggestions([]);
            return;
        }
        const q = categoryInput.trim();
        if (q.length === 0) { setCategorySuggestions([]); return; }
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

    useEffect(() => {
        if (!loading && rows.length === 0 && onEmpty) {
            onEmpty();
        }
    }, [loading, rows.length, onEmpty]);

    const advance = useCallback(() => {
        setRows(prev => prev.slice(1));
    }, []);

    const onMultipleProducts = useCallback(() => {
        if (!currentCard || !sourceReceipt) return;
        router.push({
            pathname: '/admin/receipt-split' as any,
            params: {
                productId: String(currentCard.productId),
                priceId: String(sourceReceipt.priceId),
                receiptId: String(sourceReceipt.receiptId),
                lineIdx: String(sourceReceipt.lineIdx),
                productName: currentCard.productName,
                price: String(sourceReceipt.price),
                promoPrice: sourceReceipt.promoPrice != null ? String(sourceReceipt.promoPrice) : '',
                amount: sourceReceipt.amount != null ? String(sourceReceipt.amount) : '',
                unit: sourceReceipt.unit ?? '',
            },
        });
    }, [currentCard, sourceReceipt, router]);

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
        if (onEmpty) return null;
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
    const progress = done / BATCH_SIZE;
    const canConfirm = categoryPickedId !== null && !actioning;

    return (
        <View style={styles.page}>
            {/* Progress bar */}
            <View style={styles.progressBarTrack}>
                <View style={[styles.progressBarFill, { width: `${progress * 100}%` }]} />
            </View>

            {/* Skip button row — replaces the old native header injection */}
            <View style={styles.skipRow}>
                <Text style={styles.progressText}>
                    {t('admin.amounts.leaseProgress', { done, total: BATCH_SIZE })}
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

            <KeyboardAwareScrollView contentContainerStyle={styles.cardScroll} keyboardShouldPersistTaps="handled" bottomOffset={72}>
                <View style={styles.card}>
                    {(() => {
                        const logo = sourceReceipt
                            ? currentCard.chainLogos.find(l => l.chainId === sourceReceipt.chainId)
                            : currentCard.chainLogos[0];
                        return logo ? (
                            <ChainLogoStrip chainLogos={[logo]} style={styles.chainLogoStrip} />
                        ) : null;
                    })()}

                    <View style={styles.cardHeader}>
                        <View style={styles.cardThumbWrap}>
                            {currentCard.bestImageUrl
                                ? <Image source={{ uri: currentCard.bestImageUrl }} style={styles.cardThumb} resizeMode="cover" />
                                : <View style={[styles.cardThumb, styles.cardThumbPlaceholder]}>
                                      <Ionicons name="image-outline" size={24} color={colors.textMuted} />
                                  </View>}
                        </View>
                        <View style={styles.cardHeaderText}>
                            <Text style={styles.cardName} numberOfLines={2}>{currentCard.productName}</Text>
                            <View style={styles.unsortedBadgeRow}>
                                <View style={styles.unsortedBadge}>
                                    <Text style={styles.unsortedBadgeText}>{t('admin.uncategorised.badgeUnsorted')}</Text>
                                </View>
                            </View>
                        </View>
                    </View>

                    {(currentCard.hasPendingFlags || currentCard.baseProductLinkCount > 0) && (
                        <View style={styles.warningBanner}>
                            {currentCard.hasPendingFlags && (
                                <View style={styles.warningChip}>
                                    <Ionicons name="warning" size={12} color={colors.warning} />
                                    <Text style={styles.warningChipText}>{t('admin.uncategorised.hasPendingFlags')}</Text>
                                </View>
                            )}
                            {currentCard.baseProductLinkCount > 0 && (
                                <View style={styles.warningChip}>
                                    <Ionicons name="link" size={12} color={colors.warning} />
                                    <Text style={styles.warningChipText}>{t('admin.uncategorised.hasBplLinks', { count: currentCard.baseProductLinkCount })}</Text>
                                </View>
                            )}
                        </View>
                    )}

                    {(cropLoading || cropUri) && (
                        <View style={styles.cropSection}>
                            <Text style={styles.cropLabel}>{t('admin.uncategorised.sectionReceipt')}</Text>
                            {cropLoading && !cropUri
                                ? <ActivityIndicator color={colors.primary} style={styles.cropLoader} />
                                : cropUri
                                    ? <Image
                                          source={{ uri: cropUri }}
                                          style={cropAspectRatio
                                              ? { width: '100%', aspectRatio: cropAspectRatio, borderRadius: 8, maxHeight: 200 }
                                              : styles.cropImage}
                                          resizeMode="cover"
                                          onLoad={(e) => setCropAspectRatio(
                                              e.nativeEvent.source.width / e.nativeEvent.source.height,
                                          )}
                                      />
                                    : null}
                            {sourceReceipt && (
                                <View style={styles.splitBtnRow}>
                                    <TouchableOpacity
                                        style={styles.splitBtn}
                                        onPress={onMultipleProducts}
                                        disabled={actioning}
                                    >
                                        <Ionicons name="git-branch-outline" size={13} color={colors.primary} />
                                        <Text style={styles.splitBtnText}>{t('admin.uncategorised.splitAction')}</Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        </View>
                    )}

                    <Section title={t('admin.uncategorised.sectionName')} styles={styles}>
                        {sourceReceipt?.ocrName != null && (
                            <View style={styles.nameSourceRow}>
                                <TouchableOpacity
                                    style={[styles.nameSourceBtn, nameSource === 'matched' && styles.nameSourceBtnActive]}
                                    onPress={() => { setNameSource('matched'); setNameInput(currentCard.productName); }}
                                >
                                    <Text style={[styles.nameSourceBtnText, nameSource === 'matched' && styles.nameSourceBtnTextActive]}>
                                        {t('admin.uncategorised.nameSourceMatched')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.nameSourceBtn, nameSource === 'ocr' && styles.nameSourceBtnActive]}
                                    onPress={() => { setNameSource('ocr'); setNameInput(sourceReceipt.ocrName!); }}
                                >
                                    <Text style={[styles.nameSourceBtnText, nameSource === 'ocr' && styles.nameSourceBtnTextActive]}>
                                        {t('admin.uncategorised.nameSourceOcr')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        )}
                        <TextInput
                            style={styles.textInput}
                            value={nameInput}
                            onChangeText={(v) => { setNameInput(v); setNameSource(null); }}
                        />
                    </Section>

                    <Section title={t('admin.uncategorised.sectionCategory')} styles={styles} required>
                        {categoryHints.length > 0 && (
                            <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                style={styles.hintsScroll}
                                contentContainerStyle={styles.hintsContent}
                            >
                                {categoryHints.map((h) => {
                                    const active = categoryPickedId === h.categoryId;
                                    return (
                                        <TouchableOpacity
                                            key={h.categoryId}
                                            style={[styles.hintChip, active && styles.hintChipActive]}
                                            onPress={() => {
                                                setCategoryInput(h.categoryName);
                                                setCategoryPickedId(h.categoryId);
                                                setCategorySearchOpen(false);
                                                setCategorySuggestions([]);
                                            }}
                                        >
                                            <Text style={[styles.hintChipText, active && styles.hintChipTextActive]} numberOfLines={1}>
                                                {h.categoryName}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        )}
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
                                    onPress={() => { setCategorySearchOpen(false); setCategorySuggestions([]); }}
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
            </KeyboardAwareScrollView>

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

    progressBarTrack: { height: 4, backgroundColor: c.borderSubtle },
    progressBarFill: {
        height: 4, backgroundColor: c.primary,
        shadowColor: c.primary, shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.65, shadowRadius: 8, elevation: 4,
    },

    skipRow: {
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        paddingHorizontal: 16, paddingVertical: 8,
    },
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
    cardThumbWrap: { width: 56, height: 56, position: 'relative' },
    cardThumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: c.surfaceMuted },
    cardThumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
    cardHeaderText: { flex: 1 },
    chainLogoStrip: {
        position: 'absolute', top: 12, left: 12, zIndex: 1,
        backgroundColor: 'transparent', paddingHorizontal: 0, paddingVertical: 0,
        shadowOpacity: 0, elevation: 0,
    },
    cardName: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    unsortedBadgeRow: { flexDirection: 'row', marginTop: 4 },
    unsortedBadge: { backgroundColor: c.warning + '22', borderColor: c.warning, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
    unsortedBadgeText: { color: c.warning, fontSize: 11, fontWeight: '700' },

    warningBanner: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    warningChip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingHorizontal: 8, paddingVertical: 4,
        borderRadius: 8, backgroundColor: c.warning + '18', borderWidth: 1, borderColor: c.warning + '50',
    },
    warningChipText: { fontSize: 11, color: c.warning, fontWeight: '600' },

    section: {
        marginTop: 4, padding: 12, borderRadius: 12,
        borderWidth: 1, borderColor: c.borderSubtle,
        backgroundColor: c.pageBackground, gap: 8,
    },
    sectionRequired: { borderWidth: 4, borderColor: 'transparent', borderLeftColor: c.primary, backgroundColor: c.primary + '12' },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    sectionTitle: { fontSize: 12, fontWeight: '700', color: c.textSecondary, textTransform: 'uppercase' },
    sectionTitleRequired: { color: c.primary },
    requiredPill: { paddingHorizontal: 6, paddingVertical: 1, minWidth: 18, borderRadius: 10, backgroundColor: c.primary, alignItems: 'center' },
    requiredPillText: { color: c.onPrimary, fontSize: 11, fontWeight: '800' },

    textInput: {
        backgroundColor: c.cardBackground, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
        fontSize: 14, color: c.textPrimary, borderWidth: 1, borderColor: c.borderSubtle,
    },
    typeaheadRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
    typeaheadInput: { flex: 1 },
    typeaheadLockBtn: {
        width: 38, height: 38, borderRadius: 8, borderWidth: 1, borderColor: c.primary,
        backgroundColor: c.primary + '12', alignItems: 'center', justifyContent: 'center',
    },
    suggestionList: { marginTop: 4, backgroundColor: c.cardBackground, borderRadius: 8, borderWidth: 1, borderColor: c.borderSubtle },
    suggestionRow: { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle },
    suggestionText: { fontSize: 14, color: c.textPrimary },
    suggestionMeta: { fontSize: 11, color: c.textMuted, marginTop: 2 },

    cropSection: { backgroundColor: c.pageBackground, borderRadius: 10, padding: 10, gap: 8 },
    cropLabel: { fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase' },
    cropLoader: { alignSelf: 'center', marginVertical: 8 },
    cropImage: { width: '100%', height: 80, borderRadius: 8 },
    splitBtnRow: { flexDirection: 'row' },
    splitBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 5,
        paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8,
        borderWidth: 1, borderColor: c.primary, backgroundColor: c.primary + '18',
    },
    splitBtnText: { color: c.primary, fontSize: 12, fontWeight: '600' },

    nameSourceRow: { flexDirection: 'row', gap: 6 },
    nameSourceBtn: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: c.borderSubtle, backgroundColor: c.pageBackground },
    nameSourceBtnActive: { borderColor: c.primary, backgroundColor: c.primary + '18' },
    nameSourceBtnText: { fontSize: 12, fontWeight: '600', color: c.textSecondary },
    nameSourceBtnTextActive: { color: c.primary },

    hintsScroll: { marginBottom: 2 },
    hintsContent: { gap: 6, paddingRight: 4 },
    hintChip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: c.borderSubtle, backgroundColor: c.pageBackground },
    hintChipActive: { borderColor: c.primary, backgroundColor: c.primary + '18' },
    hintChipText: { fontSize: 12, fontWeight: '600', color: c.textSecondary },
    hintChipTextActive: { color: c.primary },

    footer: { padding: 12, backgroundColor: c.cardBackground, borderTopWidth: 1, borderTopColor: c.borderSubtle },
    primaryBtn: { backgroundColor: c.primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
    primaryBtnDisabled: { backgroundColor: c.surfaceMuted },
    primaryBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: '700' },
});
