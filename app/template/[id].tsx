import {
    View, Text, FlatList, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
    Alert, TextInput, Switch, RefreshControl,
} from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import { ScreenBackButton } from '../../components/ScreenBackButton';
import { GlassIconButton } from '../../components/GlassIconButton';
import { ProductImage } from '../../components/ProductImage';
import { SkeletonBox } from '../../components/SkeletonBox';
import { CardActionBar, type CardAction } from '../../components/CardActionBar';
import { TemplateShareSheet } from '../../components/TemplateShareSheet';
import { PublishWallModal } from '../../components/PublishWallModal';
import { StoreChipBar } from '../../components/StoreChipBar';
import { authedFetch } from '../../utils/authApi';
import { useAuthState } from '../../state/authState';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import {
    getTemplate,
    patchTemplate,
    deleteTemplate as deleteTemplateApi,
    instantiateTemplate,
    patchTemplateItem,
    deleteTemplateItem,
    type BasketTemplateDetail,
} from '../../utils/basketTemplatesApi';

export default function TemplateDetailScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const router = useRouter();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { id: rawId } = useLocalSearchParams<{ id: string }>();
    const templateId = Number(rawId);

    const [template, setTemplate] = useState<BasketTemplateDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [nameDraft, setNameDraft] = useState('');
    const [editingName, setEditingName] = useState(false);
    const nameInputRef = useRef<TextInput>(null);

    // Per-row local input buffer so the user can type "0" or "12" without
    // the optimistic-update fight clobbering their input mid-keystroke.
    const [qtyInputs, setQtyInputs] = useState<Record<number, string>>({});

    const [actionBarOpen, setActionBarOpen] = useState(false);
    const [shareSheetOpen, setShareSheetOpen] = useState(false);
    const [publishWallOpen, setPublishWallOpen] = useState(false);
    // Tabs at the top of the editor — "Prekės" = items list (default),
    // "Statistika" = creator-account explainer + CTA. Renamed from the
    // visibility selector; visibility is now derived implicitly (templates
    // become unlisted on first share via the nav-bar share icon, and
    // public via the Statistika tab's sign-up flow).
    const [tab, setTab] = useState<'items' | 'stats'>('items');

    const authedUser = useAuthState(s => s.user);

    const setVisibility = useCallback(async (target: 'private' | 'unlisted' | 'public') => {
        if (!template) return;
        if (target === template.visibility) return;
        try {
            const res = await authedFetch(`${API_BASE_URL}/api/basket-templates/${template.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ visibility: target }),
            });
            if (res.status === 401 || res.status === 412) {
                // Publish wall: server says we need auth + username for 'public'.
                setPublishWallOpen(true);
                return;
            }
            if (!res.ok) {
                Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
                return;
            }
            const data = await res.json();
            setTemplate(prev => prev ? { ...prev, visibility: data.visibility ?? target } : prev);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        }
    }, [template, t]);

    // After OAuth + username flow completes, retry the 'public' upgrade.
    const handlePublishWallComplete = useCallback(() => {
        setPublishWallOpen(false);
        if (template && template.visibility !== 'public') {
            setVisibility('public');
        }
    }, [template, setVisibility]);

    const [instantiating, setInstantiating] = useState(false);

    // ── Data load ─────────────────────────────────────────────────────────
    const fetchTemplate = useCallback(async (silent: boolean) => {
        if (!Number.isFinite(templateId)) return;
        if (!silent) setLoading(true);
        try {
            const data = await getTemplate(templateId);
            setTemplate(data);
            setNameDraft(data.name);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorLoad'));
        } finally {
            setLoading(false);
        }
    }, [templateId, t]);

    useFocusEffect(useCallback(() => { fetchTemplate(false); }, [fetchTemplate]));

    // ── Name editing ──────────────────────────────────────────────────────
    const saveName = useCallback(async () => {
        const trimmed = nameDraft.trim();
        if (!template) return;
        if (trimmed.length === 0 || trimmed === template.name) {
            setNameDraft(template.name);
            setEditingName(false);
            return;
        }
        try {
            await patchTemplate(template.id, { name: trimmed });
            setTemplate(prev => prev ? { ...prev, name: trimmed } : prev);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
            setNameDraft(template.name);
        } finally {
            setEditingName(false);
        }
    }, [nameDraft, template, t]);

    // ── Auto-update toggle ────────────────────────────────────────────────
    const toggleAutoUpdate = useCallback(async (value: boolean) => {
        if (!template) return;
        // Optimistic: flip in state immediately, revert on error.
        setTemplate(prev => prev ? { ...prev, autoUpdate: value ? 1 : 0 } : prev);
        try {
            await patchTemplate(template.id, { autoUpdate: value });
        } catch {
            setTemplate(prev => prev ? { ...prev, autoUpdate: value ? 0 : 1 } : prev);
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        }
    }, [template, t]);

    // ── Item quantity ─────────────────────────────────────────────────────
    const setQty = useCallback(async (itemId: number, raw: number) => {
        if (!template) return;
        const item = template.items.find(it => it.id === itemId);
        // Round to integer for piece-counted items, 1 decimal place for
        // weighable. Mirrors the basket detail UX so the template editor
        // behaves the same way for the same product class.
        const isWeighable = item?.isWeighable === 1;
        let rounded = isWeighable
            ? Math.round(raw * 10) / 10
            : Math.round(raw);
        const next = Math.max(0, Math.min(9999, rounded));
        if (next <= 0) {
            await removeItem(itemId);
            return;
        }
        setTemplate(prev => prev ? {
            ...prev,
            items: prev.items.map(it => it.id === itemId ? { ...it, quantity: String(next) } : it),
        } : prev);
        try {
            await patchTemplateItem(template.id, itemId, { quantity: next });
        } catch {
            // Reload on error so we don't end up with a phantom quantity.
            fetchTemplate(true);
        }
    }, [template, fetchTemplate]);

    const removeItem = useCallback(async (itemId: number) => {
        if (!template) return;
        setTemplate(prev => prev ? {
            ...prev,
            items: prev.items.filter(it => it.id !== itemId),
        } : prev);
        try {
            await deleteTemplateItem(template.id, itemId);
        } catch {
            fetchTemplate(true);
        }
    }, [template, fetchTemplate]);

    // ── Delete template ───────────────────────────────────────────────────
    const confirmDelete = useCallback(() => {
        if (!template) return;
        Alert.alert(
            t('basketTab.templates.deleteTitle'),
            t('basketTab.templates.deleteBody', { name: template.name }),
            [
                { text: t('basketTab.templates.deleteCancel'), style: 'cancel' },
                {
                    text: t('basketTab.templates.deleteConfirm'),
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await deleteTemplateApi(template.id);
                            router.back();
                        } catch {
                            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorDelete'));
                        }
                    },
                },
            ],
        );
    }, [template, t, router]);

    // ── Instantiate ───────────────────────────────────────────────────────
    const runInstantiate = useCallback(async (force: boolean) => {
        if (!template) return;
        try {
            setInstantiating(true);
            const userId = await getUserId();
            const result = await instantiateTemplate(template.id, userId, { force });
            router.replace(`/basket/${result.basketId}` as any);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorInstantiate'));
        } finally {
            setInstantiating(false);
        }
    }, [template, router, t]);

    const handleInstantiate = useCallback(async () => {
        if (!template || instantiating) return;
        try {
            setInstantiating(true);
            const userId = await getUserId();
            // First attempt: no force flag — server returns action='resume'
            // when an in-progress instance already exists for this template.
            // That's the signal to ask the user whether they want to
            // continue the existing basket or start fresh.
            const result = await instantiateTemplate(template.id, userId);
            if (result.action === 'resume') {
                setInstantiating(false);
                Alert.alert(
                    t('basketTab.templates.resumeTitle'),
                    t('basketTab.templates.resumeBody'),
                    [
                        { text: t('basketTab.templates.resumeBasketCancel'), style: 'cancel' },
                        {
                            text: t('basketTab.templates.resumeNew'),
                            style: 'destructive',
                            onPress: () => runInstantiate(true),
                        },
                        {
                            text: t('basketTab.templates.resumeContinue'),
                            onPress: () => router.replace(`/basket/${result.basketId}` as any),
                        },
                    ],
                );
                return;
            }
            router.replace(`/basket/${result.basketId}` as any);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorInstantiate'));
            setInstantiating(false);
            return;
        }
        setInstantiating(false);
    }, [template, instantiating, router, t, runInstantiate]);

    // ── Skeleton ──────────────────────────────────────────────────────────
    if (loading || !template) {
        return (
            <>
                <Stack.Screen options={{
                    title: t('basketTab.templates.editTitle'),
                    headerStyle: { backgroundColor: colors.cardBackground },
                    headerShadowVisible: false,
                    headerLeft: () => <ScreenBackButton />,
                }} />
                <View style={[styles.container, { padding: 16, gap: 12 }]}>
                    {Array.from({ length: 5 }).map((_, i) => (
                        <SkeletonBox key={i} width="100%" height={62} borderRadius={12} />
                    ))}
                </View>
            </>
        );
    }

    const titleText = editingName ? '' : (template.name || t('basketTab.templates.fallbackName'));

    return (
        <>
            <Stack.Screen options={{
                title: titleText,
                headerTitle: editingName
                    ? () => (
                        <TextInput
                            ref={nameInputRef}
                            defaultValue={nameDraft}
                            onChangeText={setNameDraft}
                            onEndEditing={saveName}
                            onSubmitEditing={saveName}
                            onBlur={saveName}
                            placeholder={t('basketTab.templates.fallbackName')}
                            placeholderTextColor={colors.textMuted}
                            maxLength={100}
                            style={{
                                fontSize: 17, fontWeight: '600',
                                color: colors.textPrimary, minWidth: 200,
                                paddingVertical: 2,
                                borderBottomWidth: 1, borderBottomColor: colors.primary,
                            }}
                        />
                    )
                    : () => (
                        <TouchableOpacity onPress={() => setEditingName(true)} activeOpacity={0.6}>
                            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.textPrimary }} numberOfLines={1}>
                                {titleText}
                            </Text>
                        </TouchableOpacity>
                    ),
                headerStyle: { backgroundColor: colors.cardBackground },
                headerShadowVisible: false,
                headerLeft: () => <ScreenBackButton />,
                headerRight: () => (
                    <View style={{ flexDirection: 'row' }}>
                        {/* Dalintis lives on the nav bar so a single tap
                            opens the share sheet. Disabled when the template
                            is empty — sharing an item-less template is
                            meaningless (the server would reject it anyway). */}
                        <GlassIconButton
                            icon="share-social-outline"
                            onPress={() => template.items.length > 0 && setShareSheetOpen(true)}
                            disabled={template.items.length === 0}
                        />
                        <GlassIconButton
                            icon="ellipsis-horizontal"
                            onPress={() => setActionBarOpen(true)}
                        />
                    </View>
                ),
            }} />

            <View style={styles.container}>
                <StoreChipBar
                    chips={[
                        { id: 'items', label: t('basketTab.templates.tabItems') },
                        { id: 'stats', label: t('basketTab.templates.tabStats') },
                    ]}
                    selectedId={tab}
                    onSelect={id => { if (id != null) setTab(id as 'items' | 'stats'); }}
                />
                {tab === 'items' ? (
                <>
                <FlatList
                    data={template.items}
                    keyExtractor={item => `i-${item.id}`}
                    contentContainerStyle={styles.list}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={async () => { setRefreshing(true); await fetchTemplate(true); setRefreshing(false); }}
                            colors={[colors.primary]}
                            tintColor={colors.primary}
                        />
                    }
                    ListHeaderComponent={
                        template.isDefault === 1 ? (
                            <View style={styles.settingRow}>
                                <Text style={styles.settingLabel}>{t('basketTab.templates.autoUpdateLabel')}</Text>
                                <Switch
                                    value={template.autoUpdate === 1}
                                    onValueChange={toggleAutoUpdate}
                                    trackColor={{ false: colors.border, true: colors.primary }}
                                    thumbColor={colors.cardBackground}
                                />
                            </View>
                        ) : null
                    }
                    ListEmptyComponent={
                        <View style={styles.centered}>
                            <Ionicons name="albums-outline" size={56} color={colors.textMuted} />
                            <Text style={styles.emptyText}>{t('basketTab.templates.emptyItemsTitle')}</Text>
                            <Text style={styles.emptySubText}>{t('basketTab.templates.emptyItemsBody')}</Text>
                        </View>
                    }
                    renderItem={({ item }) => {
                        // Format the displayed quantity by class. Weighable
                        // items (kg) show one decimal; piece items strip the
                        // trailing ".0" the DB stores (DECIMAL(10,3)).
                        const isWeighable = item.isWeighable === 1;
                        const numeric = Number(item.quantity);
                        const fallbackQty = isWeighable
                            ? numeric.toFixed(1).replace('.', ',')
                            : String(Math.round(numeric));
                        const qty = qtyInputs[item.id] ?? fallbackQty;
                        const step = isWeighable ? 0.1 : 1;
                        return (
                            <View style={styles.card}>
                                <ProductImage
                                    uris={item.imageUrls}
                                    imageStyle={styles.productImage}
                                    placeholderStyle={styles.productImagePlaceholder}
                                    emojiStyle={styles.productImageEmoji}
                                />
                                <View style={styles.cardContent}>
                                    <Text style={styles.itemName} numberOfLines={2}>{item.productName}</Text>
                                    <View style={styles.controls}>
                                        <TouchableOpacity
                                            style={styles.controlButton}
                                            onPress={() => setQty(item.id, Number(item.quantity) - step)}
                                        >
                                            <Ionicons name="remove" size={18} color={colors.primary} />
                                        </TouchableOpacity>
                                        {/* Wrapper owns the visual border so the
                                            Android system TextInput can't draw its
                                            ~2 pt accent underline on top — that
                                            underline isn't always killable via
                                            `underlineColorAndroid` on the new
                                            architecture / Fabric. */}
                                        <View style={styles.quantityInputBox}>
                                            <TextInput
                                                style={styles.quantityInput}
                                                value={qty}
                                                onChangeText={v => {
                                                    // Piece items: digits only.
                                                    // Weighable: digits + one
                                                    // decimal separator with ≤ 1
                                                    // digit after it.
                                                    if (isWeighable) {
                                                        if (!/^[0-9]*[.,]?[0-9]?$/.test(v)) return;
                                                    } else {
                                                        if (/[^0-9]/.test(v)) return;
                                                    }
                                                    setQtyInputs(p => ({ ...p, [item.id]: v }));
                                                }}
                                                onEndEditing={e => {
                                                    const txt = e.nativeEvent.text.replace(',', '.');
                                                    const val = isWeighable ? parseFloat(txt) : parseInt(txt, 10);
                                                    if (!val || val <= 0) removeItem(item.id);
                                                    else setQty(item.id, val);
                                                    setQtyInputs(p => { const c = { ...p }; delete c[item.id]; return c; });
                                                }}
                                                keyboardType={isWeighable ? 'decimal-pad' : 'number-pad'}
                                                selectTextOnFocus
                                                underlineColorAndroid="transparent"
                                            />
                                        </View>
                                        <Text style={styles.unitLabel}>
                                            {isWeighable ? 'kg' : 'vnt.'}
                                        </Text>
                                        <TouchableOpacity
                                            style={styles.controlButton}
                                            onPress={() => setQty(item.id, Number(item.quantity) + step)}
                                        >
                                            <Ionicons name="add" size={18} color={colors.primary} />
                                        </TouchableOpacity>
                                    </View>
                                </View>
                                <TouchableOpacity style={styles.removeButton} onPress={() => removeItem(item.id)}>
                                    <Ionicons name="trash-outline" size={20} color={colors.error} />
                                </TouchableOpacity>
                            </View>
                        );
                    }}
                />

                <View style={styles.footer}>
                    <TouchableOpacity
                        style={styles.addItemBtn}
                        onPress={() => router.push(`/template-add/${template.id}` as any)}
                    >
                        <Ionicons name="add" size={18} color={colors.primary} />
                        <Text style={styles.addItemBtnText}>{t('basketTab.templates.addItemTitle')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.cta, (instantiating || template.items.length === 0) && styles.ctaDisabled]}
                        onPress={handleInstantiate}
                        disabled={instantiating || template.items.length === 0}
                    >
                        {instantiating
                            ? <ActivityIndicator color={colors.onPrimary} />
                            : <Text style={styles.ctaText}>{t('basketTab.templates.instantiateCta')}</Text>}
                    </TouchableOpacity>
                </View>
                </>
                ) : (
                    // Statistika tab — creator-account explainer + sign-up CTA.
                    // Renders inline (no modal) so users can read at their own
                    // pace and the "regular users don't need this" framing is
                    // visible up front.
                    <ScrollView contentContainerStyle={styles.statsScroll}>
                        <View style={styles.statsCard}>
                            <Ionicons
                                name="people-circle-outline"
                                size={42}
                                color={colors.primary}
                                style={{ alignSelf: 'flex-start' }}
                            />
                            <Text style={styles.statsTitle}>
                                {t('basketTab.templates.statsCreatorTitle')}
                            </Text>
                            <Text style={styles.statsIntro}>
                                {t('basketTab.templates.statsCreatorIntro')}
                            </Text>
                            {[
                                t('basketTab.templates.statsCreatorBullet1'),
                                t('basketTab.templates.statsCreatorBullet2'),
                                t('basketTab.templates.statsCreatorBullet3'),
                                t('basketTab.templates.statsCreatorBullet4'),
                            ].map((line, i) => (
                                <View key={i} style={styles.statsBulletRow}>
                                    <Ionicons name="checkmark-circle" size={16} color={colors.success} style={{ marginTop: 2 }} />
                                    <Text style={styles.statsBulletText}>{line}</Text>
                                </View>
                            ))}
                            {authedUser?.username ? (
                                <Text style={styles.statsAlready}>
                                    {t('basketTab.templates.statsAlreadyCreator', { handle: authedUser.username })}
                                </Text>
                            ) : (
                                <TouchableOpacity
                                    style={styles.statsCta}
                                    onPress={() => setPublishWallOpen(true)}
                                >
                                    <Ionicons name="logo-electron" size={16} color={colors.onPrimary} />
                                    <Text style={styles.statsCtaText}>
                                        {t('basketTab.templates.statsCreatorCta')}
                                    </Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    </ScrollView>
                )}
            </View>

            {actionBarOpen && (
                <CardActionBar
                    title={template.name}
                    onDismiss={() => setActionBarOpen(false)}
                    actions={[
                        // Share moved to the nav-bar share icon. Only the
                        // destructive action remains in the overflow menu.
                        {
                            icon: 'trash-outline',
                            label: t('basketTab.templates.deleteConfirm'),
                            destructive: true,
                            onPress: () => { setActionBarOpen(false); confirmDelete(); },
                        },
                    ]}
                />
            )}

            <TemplateShareSheet
                visible={shareSheetOpen}
                templateId={template.id}
                templateName={template.name}
                itemCount={template.items.length}
                onClose={() => setShareSheetOpen(false)}
            />

            <PublishWallModal
                visible={publishWallOpen}
                onClose={() => setPublishWallOpen(false)}
                onComplete={handlePublishWallComplete}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    list: { padding: 12, paddingBottom: 24 },
    centered: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },

    // ── Setting row ───────────────────────────────────────────────────────
    settingRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 14, marginBottom: 12,
    },
    settingLabel: { flex: 1, fontSize: 14, color: c.textPrimary, marginRight: 12 },

    // ── Statistika tab — creator-account explainer ────────────────────────
    statsScroll: { padding: 16, paddingBottom: 32 },
    statsCard: {
        backgroundColor: c.cardBackground, borderRadius: 16, padding: 18,
        gap: 12, borderLeftWidth: 4, borderLeftColor: c.primary,
    },
    statsTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary },
    statsIntro: { fontSize: 14, color: c.textSecondary, lineHeight: 20 },
    statsBulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    statsBulletText: { flex: 1, fontSize: 14, color: c.textPrimary, lineHeight: 20 },
    statsCta: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        backgroundColor: c.primary, paddingVertical: 12, borderRadius: 10,
        marginTop: 8,
    },
    statsCtaText: { fontSize: 14, fontWeight: '700', color: c.onPrimary },
    statsAlready: {
        fontSize: 13, fontWeight: '600', color: c.success,
        textAlign: 'center', marginTop: 8,
    },

    // ── Item card ─────────────────────────────────────────────────────────
    card: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: c.cardBackground, borderRadius: 12,
        padding: 12, marginBottom: 8, gap: 12,
    },
    productImage: { width: 44, height: 44, borderRadius: 8 },
    productImagePlaceholder: {
        width: 44, height: 44, borderRadius: 8,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    },
    productImageEmoji: { fontSize: 24, opacity: 0.5 },
    cardContent: { flex: 1, gap: 6 },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    controls: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
    },
    controlButton: {
        width: 28, height: 28, borderRadius: 6,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.primaryMuted,
    },
    // Box owns the visual border + corner clipping; the TextInput inside
    // is borderless so the Android system underline has nothing to draw
    // against and can't bleed through.
    quantityInputBox: {
        minWidth: 48, borderWidth: 1, borderColor: c.border, borderRadius: 6,
        overflow: 'hidden', backgroundColor: c.cardBackground,
    },
    quantityInput: {
        paddingHorizontal: 8, paddingVertical: 4,
        textAlign: 'center', fontSize: 14, fontWeight: '600',
        color: c.textPrimary,
        // Belt-and-braces for the underline: padding ate the underline area
        // already, but on a few skinned Android keyboards the accent line
        // still tries to render — keep these zero to defeat any leftover.
        borderWidth: 0,
        ...(({} as any)),
    },
    unitLabel: { fontSize: 13, fontWeight: '600', color: c.textSecondary, minWidth: 28 },
    removeButton: { padding: 4 },

    // ── Footer ────────────────────────────────────────────────────────────
    footer: {
        padding: 12, gap: 8,
        backgroundColor: c.cardBackground,
        borderTopWidth: 0.5, borderTopColor: c.border,
    },
    addItemBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 6, paddingVertical: 12, borderRadius: 10,
        borderWidth: 1, borderColor: c.primary, borderStyle: 'dashed',
    },
    addItemBtnText: { fontSize: 14, fontWeight: '600', color: c.primary },
    cta: {
        paddingVertical: 14, borderRadius: 10,
        backgroundColor: c.primary, alignItems: 'center',
    },
    ctaDisabled: { backgroundColor: c.border },
    ctaText: { fontSize: 15, fontWeight: '700', color: c.onPrimary },

    // ── Empty states ──────────────────────────────────────────────────────
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 18 },
    hintText: { fontSize: 13, color: c.textMuted, textAlign: 'center' },

});
