import {
    View, Text, FlatList, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
    Alert, TextInput, RefreshControl, Switch,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useCollapsingHeader, CollapsingHeader } from '../../components/CollapsingHeader';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import { TemplateCoverEditor } from '../../components/TemplateCoverEditor';
import { coverEmoji } from '../../utils/templateCover';
import { formatEuro } from '../../utils/formatCurrency';
import { ScreenBackButton } from '../../components/ScreenBackButton';
import { GlassIconButton } from '../../components/GlassIconButton';
import { ProductImage } from '../../components/ProductImage';
import { SkeletonBox } from '../../components/SkeletonBox';
import { CardActionBar, type CardAction } from '../../components/CardActionBar';
import { TemplateShareSheet } from '../../components/TemplateShareSheet';
import { PublishWallModal } from '../../components/PublishWallModal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { StatsHelpModal } from '../../components/StatsHelpModal';
import { StoreChipBar } from '../../components/StoreChipBar';
import { authedFetch } from '../../utils/authApi';
import { useAuthState, DEV_SESSION_TOKEN } from '../../state/authState';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import {
    getTemplate,
    patchTemplate,
    deleteTemplate as deleteTemplateApi,
    instantiateTemplate,
    duplicateTemplate,
    patchTemplateItem,
    deleteTemplateItem,
    type BasketTemplateDetail,
} from '../../utils/basketTemplatesApi';

/** Result of a visibility change: ok = applied; wall = publish wall opened;
 *  dev = blocked because the DEV fake token can't publish; error = other. */
type VisResult = 'ok' | 'wall' | 'dev' | 'error';

export default function TemplateDetailScreen() {
    const colors = useTheme();
    const header = useCollapsingHeader();
    const { t } = useTranslation();
    const router = useRouter();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { id: rawId } = useLocalSearchParams<{ id: string }>();
    const templateId = Number(rawId);

    const [template, setTemplate] = useState<BasketTemplateDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);

    // Per-row local input buffer so the user can type "0" or "12" without
    // the optimistic-update fight clobbering their input mid-keystroke.
    const [qtyInputs, setQtyInputs] = useState<Record<number, string>>({});

    const [actionBarOpen, setActionBarOpen] = useState(false);
    const [shareSheetOpen, setShareSheetOpen] = useState(false);
    const [publishWallOpen, setPublishWallOpen] = useState(false);
    const [coverEditorOpen, setCoverEditorOpen] = useState(false);
    // Tabs at the top of the editor — "Prekės" = items list (default),
    // "Statistika" = creator-account explainer + CTA. Renamed from the
    // visibility selector; visibility is now derived implicitly (templates
    // become unlisted on first share via the nav-bar share icon, and
    // public via the Statistika tab's sign-up flow).
    const [tab, setTab] = useState<'items' | 'stats'>('items');

    const authedUser = useAuthState(s => s.user);

    const setVisibility = useCallback(async (target: 'private' | 'unlisted' | 'public'): Promise<VisResult> => {
        if (!template) return 'error';
        if (target === template.visibility) return 'ok';
        try {
            // X-User-Id authorises ownership even when the Bearer isn't a real
            // server session (e.g. the DEV quick-login's fake token); the
            // public upgrade still needs a genuine verified user server-side.
            const ownerId = await getUserId();
            const res = await authedFetch(`${API_BASE_URL}/api/basket-templates/${template.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'X-User-Id': ownerId },
                body: JSON.stringify({ visibility: target }),
            });
            if (res.status === 401 || res.status === 412) {
                // Publish wall: server needs auth + username for 'public'. BUT if
                // the user already has a token + handle, the wall would just
                // auto-complete → retry → fail → reopen forever. Report instead.
                // The DEV quick-login uses a fake token the server rejects — call
                // that out specifically so dev testing isn't confusing.
                const auth = useAuthState.getState();
                if (auth.token && auth.user?.username) {
                    return auth.token === DEV_SESSION_TOKEN ? 'dev' : 'error';
                }
                // Close the share sheet first — two RN Modals stacked (sheet +
                // wall) flicker on Android. The wall reopens the sheet on success.
                setShareSheetOpen(false);
                setPublishWallOpen(true);
                return 'wall';
            }
            if (!res.ok) return 'error';
            const data = await res.json();
            setTemplate(prev => prev ? { ...prev, visibility: data.visibility ?? target } : prev);
            return 'ok';
        } catch {
            return 'error';
        }
    }, [template]);

    // After OAuth + username flow completes, retry the 'public' upgrade and
    // reopen the share sheet so the now-public QR/link is right there.
    const handlePublishWallComplete = useCallback(async () => {
        setPublishWallOpen(false);
        if (template && template.visibility !== 'public') {
            const r = await setVisibility('public');
            if (r === 'ok') setShareSheetOpen(true);
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
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorLoad'));
        } finally {
            setLoading(false);
        }
    }, [templateId, t]);

    useFocusEffect(useCallback(() => { fetchTemplate(false); }, [fetchTemplate]));

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
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [statsHelpOpen, setStatsHelpOpen] = useState(false);
    const confirmDelete = useCallback(() => {
        if (!template) return;
        setDeleteOpen(true);
    }, [template]);
    const handleDelete = useCallback(async () => {
        if (!template || deleting) return;
        try {
            setDeleting(true);
            await deleteTemplateApi(template.id);
            setDeleteOpen(false);
            router.back();
        } catch {
            setDeleting(false);
            setDeleteOpen(false);
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorDelete'));
        }
    }, [template, deleting, router, t]);

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

    // ── Copy (duplicate into an editable template) ────────────────────────
    const [duplicating, setDuplicating] = useState(false);
    const handleDuplicate = useCallback(async () => {
        if (!template || duplicating) return;
        try {
            setDuplicating(true);
            const dup = await duplicateTemplate(template.id);
            router.replace(`/template/${dup.id}` as any);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
            setDuplicating(false);
        }
    }, [template, duplicating, router, t]);

    // ── Learning switch (default template only) = autoUpdate ──────────────
    const toggleLearning = useCallback(async (value: boolean) => {
        if (!template) return;
        setTemplate(prev => prev ? { ...prev, autoUpdate: value ? 1 : 0 } : prev);
        try {
            await patchTemplate(template.id, { autoUpdate: value });
        } catch {
            setTemplate(prev => prev ? { ...prev, autoUpdate: value ? 0 : 1 } : prev);
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        }
    }, [template, t]);

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

    // The auto "default" template is read-only: no rename/cover/share/edit/
    // delete — only use (create basket), copy, and the learning switch. Its
    // name is always the branded "Smart template", regardless of the stored
    // value (older defaults were created as "Pirkinių sąrašas").
    const isDefault = template.isDefault === 1;
    const titleText = isDefault
        ? t('basketTab.templates.smartName')
        : (template.name || t('basketTab.templates.fallbackName'));
    // Colour the nav bar with the template's cover colour; text/icons flip to
    // white for contrast. Falls back to the neutral header when no cover set.
    const headerColor = template.coverColor ?? colors.cardBackground;
    const onCover = template.coverColor ? '#FFFFFF' : colors.textPrimary;
    const headerEmoji = coverEmoji(template.coverImage) ?? '🫜';

    return (
        <>
            {/* Unified header: cover-coloured bar (back + share + more), the
                tappable emoji/name title collapses on scroll, the Items/Stats
                tabs stay pinned. Title in the body → never under the buttons. */}
            <CollapsingHeader
                controller={header}
                background={headerColor}
                headerOptions={{
                    headerShown: true,
                    title: '',
                    headerTitle: () => null,
                    headerStyle: { backgroundColor: headerColor },
                    headerTintColor: onCover,
                    headerShadowVisible: false,
                    headerLeft: () => <ScreenBackButton color={template.coverColor ? '#FFFFFF' : colors.primary} />,
                    headerRight: () => (
                        <View style={{ flexDirection: 'row' }}>
                            {!isDefault && (
                                <GlassIconButton
                                    icon="share-social-outline"
                                    color={onCover}
                                    onPress={() => template.items.length > 0 && setShareSheetOpen(true)}
                                    disabled={template.items.length === 0}
                                />
                            )}
                            <GlassIconButton
                                icon="ellipsis-horizontal"
                                color={onCover}
                                onPress={() => setActionBarOpen(true)}
                            />
                        </View>
                    ),
                }}
                collapsing={
                    <TouchableOpacity
                        onPress={isDefault ? undefined : () => setCoverEditorOpen(true)}
                        activeOpacity={isDefault ? 1 : 0.7}
                        disabled={isDefault}
                        style={styles.titleRow}
                    >
                        <View style={[styles.titleEmoji, {
                            backgroundColor: template.coverColor ? 'rgba(255,255,255,0.22)' : (colors.surfaceMuted ?? colors.cardBackground),
                        }]}>
                            {isDefault
                                ? <Ionicons name="sparkles" size={20} color={colors.primary} />
                                : <Text style={{ fontSize: 20 }}>{headerEmoji}</Text>}
                        </View>
                        <Text style={[styles.titleText, { color: onCover }]} numberOfLines={2}>
                            {titleText}
                        </Text>
                    </TouchableOpacity>
                }
                pinned={authedUser && !isDefault ? (
                    <View style={[styles.tabBar, { backgroundColor: colors.cardBackground }]}>
                        <StoreChipBar
                            chips={[
                                { id: 'items', label: t('basketTab.templates.tabItems') },
                                { id: 'stats', label: t('basketTab.templates.tabStats') },
                            ]}
                            selectedId={tab}
                            onSelect={id => { if (id != null) setTab(id as 'items' | 'stats'); }}
                        />
                        {tab === 'stats' && (
                            <TouchableOpacity
                                onPress={() => setStatsHelpOpen(true)}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                style={styles.tabHelpBtn}
                            >
                                <Ionicons name="help-circle-outline" size={22} color={colors.textMuted} />
                            </TouchableOpacity>
                        )}
                    </View>
                ) : undefined}
            />

            <View style={styles.container}>
                {!(authedUser && tab === 'stats') ? (
                <>
                <Animated.FlatList
                    {...header.scroll}
                    style={{ flex: 1 }}
                    data={template.items}
                    keyExtractor={(item: any) => `i-${item.id}`}
                    contentContainerStyle={[styles.list, { paddingTop: header.paddingTop + 12 }]}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={async () => { setRefreshing(true); await fetchTemplate(true); setRefreshing(false); }}
                            colors={[colors.primary]}
                            tintColor={colors.primary}
                        />
                    }
                    ListHeaderComponent={
                        isDefault ? (
                            <View style={styles.settingRow}>
                                <View style={{ flex: 1, marginRight: 12 }}>
                                    <Text style={styles.settingLabel}>{t('basketTab.templates.learnLabel')}</Text>
                                    <Text style={styles.settingHint}>{t('basketTab.templates.learnHint')}</Text>
                                </View>
                                <Switch
                                    value={template.autoUpdate === 1}
                                    onValueChange={toggleLearning}
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
                                    {isDefault ? (
                                        <Text style={styles.readonlyQty}>
                                            {fallbackQty} {isWeighable ? 'kg' : 'vnt.'}
                                        </Text>
                                    ) : (
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
                                    )}
                                </View>
                                {!isDefault && (
                                    <TouchableOpacity style={styles.removeButton} onPress={() => removeItem(item.id)}>
                                        <Ionicons name="trash-outline" size={20} color={colors.error} />
                                    </TouchableOpacity>
                                )}
                            </View>
                        );
                    }}
                />

                <View style={styles.footer}>
                    {/* The auto template is read-only — no adding items. */}
                    {!isDefault && (
                        <TouchableOpacity
                            style={styles.addItemBtn}
                            onPress={() => router.push(`/template-add/${template.id}` as any)}
                        >
                            <Ionicons name="add" size={18} color={colors.primary} />
                            <Text style={styles.addItemBtnText}>{t('basketTab.templates.addItemTitle')}</Text>
                        </TouchableOpacity>
                    )}
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
                    // Statistika — real creator metrics. Same data the website
                    // shows on the template card. Only reachable when signed in
                    // (tabs are hidden otherwise).
                    <Animated.ScrollView {...header.scroll} contentContainerStyle={[styles.statsScroll, { paddingTop: header.paddingTop + 16 }]}>
                        <View style={styles.metricsGrid}>
                            <View style={styles.metricTile}>
                                <Text style={styles.metricValue}>{Number(template.visitCount ?? 0).toLocaleString('lt-LT')}</Text>
                                <Text style={styles.metricLabel}>{t('basketTab.templates.metricVisits')}</Text>
                            </View>
                            <View style={styles.metricTile}>
                                <Text style={styles.metricValue}>{Number(template.useCount ?? 0).toLocaleString('lt-LT')}</Text>
                                <Text style={styles.metricLabel}>{t('basketTab.templates.metricUses')}</Text>
                            </View>
                            <View style={styles.metricTile}>
                                <Text style={[styles.metricValue, { color: colors.primary }]}>
                                    {formatEuro(Number(template.collectiveSavingsEur ?? 0))}
                                </Text>
                                <Text style={styles.metricLabel}>{t('basketTab.templates.metricSaved')}</Text>
                            </View>
                            <View style={styles.metricTile}>
                                {(() => {
                                    // Same rule as the web: `editedAt` is set only on real
                                    // content edits (name/cover/items) → flips Sukurta → Redaguota.
                                    const tplEdited = !!template.editedAt;
                                    return (
                                        <>
                                            <Text style={styles.metricValue}>
                                                {new Date(tplEdited ? template.editedAt! : template.createdAt).toLocaleDateString('lt-LT')}
                                            </Text>
                                            <Text style={styles.metricLabel}>
                                                {t(tplEdited ? 'basketTab.templates.metricUpdated' : 'basketTab.templates.metricCreated')}
                                            </Text>
                                        </>
                                    );
                                })()}
                            </View>
                        </View>
                    </Animated.ScrollView>
                )}
            </View>

            {actionBarOpen && (
                <CardActionBar
                    title={template.name}
                    onDismiss={() => setActionBarOpen(false)}
                    actions={[
                        // Copy → a new editable template. Available for every
                        // template, and the only way to "edit" the auto one.
                        {
                            icon: 'copy-outline',
                            label: t('basketTab.templates.copyTemplate'),
                            onPress: () => { setActionBarOpen(false); handleDuplicate(); },
                        },
                        // The auto default template can't be deleted (learning
                        // switch only); manual templates keep delete.
                        ...(isDefault ? [] : [{
                            icon: 'trash-outline' as const,
                            label: t('basketTab.templates.deleteConfirm'),
                            destructive: true,
                            onPress: () => { setActionBarOpen(false); confirmDelete(); },
                        }]),
                    ]}
                />
            )}

            <TemplateShareSheet
                visible={shareSheetOpen}
                templateId={template.id}
                templateName={template.name}
                itemCount={template.items.length}
                visibility={template.visibility}
                isCreator={!!authedUser?.username}
                onSetVisibility={(next) => setVisibility(next)}
                onClose={() => setShareSheetOpen(false)}
            />

            <PublishWallModal
                visible={publishWallOpen}
                onClose={() => setPublishWallOpen(false)}
                onComplete={handlePublishWallComplete}
            />

            <ConfirmModal
                visible={deleteOpen}
                title={t('basketTab.templates.deleteTitle')}
                body={template ? t('basketTab.templates.deleteBody', { name: template.name }) : undefined}
                confirmLabel={t('basketTab.templates.deleteConfirm')}
                cancelLabel={t('basketTab.templates.deleteCancel')}
                destructive
                busy={deleting}
                onConfirm={handleDelete}
                onClose={() => setDeleteOpen(false)}
            />

            <StatsHelpModal visible={statsHelpOpen} onClose={() => setStatsHelpOpen(false)} />

            <TemplateCoverEditor
                visible={coverEditorOpen}
                onClose={() => setCoverEditorOpen(false)}
                name={template.name}
                coverColor={template.coverColor}
                coverImage={template.coverImage}
                onSubmit={(next) => {
                    setTemplate(prev => prev ? { ...prev, name: next.name, coverColor: next.coverColor, coverImage: next.coverImage } : prev);
                    patchTemplate(template.id, next).catch(() => {});
                }}
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
    settingLabel: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    settingHint: { fontSize: 12, color: c.textSecondary, marginTop: 2 },

    // ── Statistika tab — creator-account explainer ────────────────────────
    statsScroll: { padding: 16, paddingBottom: 32 },
    // Title band (emoji + name), collapses on scroll. Sits on the cover colour.
    titleRow: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12,
    },
    titleEmoji: {
        width: 34, height: 34, borderRadius: 10,
        alignItems: 'center', justifyContent: 'center',
    },
    titleText: { flex: 1, fontSize: 18, fontWeight: '700' },
    tabBar: { position: 'relative' },
    tabHelpBtn: {
        position: 'absolute', right: 0, top: 0, bottom: 0,
        justifyContent: 'center', paddingHorizontal: 14,
        backgroundColor: c.cardBackground,
    },
    metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    metricTile: {
        width: '47%', flexGrow: 1, backgroundColor: c.cardBackground,
        borderRadius: 16, padding: 16,
    },
    metricValue: { fontSize: 22, fontWeight: '800', color: c.textPrimary },
    metricLabel: { fontSize: 12, color: c.textSecondary, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
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
    readonlyQty: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
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
