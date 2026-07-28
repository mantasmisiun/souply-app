import {
    View,
    Text,
    FlatList,
    ScrollView,
    TouchableOpacity,
    StyleSheet,
    Alert,
    TextInput,
    RefreshControl,
    Switch,
    Modal,
    Pressable,
    Platform,
    Linking,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import Animated from 'react-native-reanimated';
import { useCollapsingHeader, CollapsingHeader } from '../../components/CollapsingHeader';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, radius, elevation, DIVIDER_ITEM_HEIGHT, type AppTheme } from '../../constants/theme';
import ProductLineCard from '../../components/ProductLineCard';
import { TemplateCoverEditor } from '../../components/TemplateCoverEditor';
import { coverEmoji } from '../../utils/templateCover';
import { inkOn } from '../../utils/contrastColor';
import { isWeighableDisplay } from '../../utils/weighable';
import { formatEuro } from '../../utils/formatCurrency';
import { ScreenBackButton } from '../../components/ScreenBackButton';
import { ProductImage } from '../../components/ProductImage';
import { SkeletonBox } from '../../components/SkeletonBox';
import { ScalePressable } from '../../components/ScalePressable';
import { DockedGlassSheet, type DockedSheetControls } from '../../components/DockedGlassSheet';
import { DockActionRow } from '../../components/dock/DockActionRow';
import { DockSection } from '../../components/dock/DockSection';
import { SheetCard, SHEET_CARD_SHADOW_RADIUS } from '../../components/SheetCard';
import { TemplateShareSheet } from '../../components/TemplateShareSheet';
import { PublishWallModal } from '../../components/PublishWallModal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { StatsHelpModal } from '../../components/StatsHelpModal';
import { StoreChipBar } from '../../components/StoreChipBar';
import { authedFetch } from '../../utils/authApi';
import { useAuthState, DEV_SESSION_TOKEN } from '../../state/authState';
import { useBasketSession } from '../../state/basketSession';
import { useTemplateAddState } from '../../state/templateAddState';
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

    // The bottom dock: bar row collapsed, actions sheet expanded. Its measured
    // bar height feeds the detents and its collapsed clearance pads the list, so
    // the last item is never stranded under the floating bar.
    const sheetRef = useRef<DockedSheetControls>(null);
    const [barRowH, setBarRowH] = useState(44);
    const [dockClearance, setDockClearance] = useState(120);

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
    // Set to an existing in-progress basket's id when the server says one is
    // resumable → opens the Souply-themed "continue or start new" choice.
    const [resumeBasketId, setResumeBasketId] = useState<number | null>(null);
    /**
     * Staples the shopper says they already have, chosen JUST BEFORE the basket
     * is made. The recipe itself is never edited by this — salt is part of the
     * recipe whether or not the cupboard has any today — so the set lives here
     * and dies with the screen. `null` means the choice has not been offered
     * yet, which is what makes the sheet open exactly once per attempt.
     */
    const [pantryChoice, setPantryChoice] = useState<Set<number> | null>(null);
    const [pantryOpen, setPantryOpen] = useState(false);
    /** Ticked-off staples while the sheet is open; committed on confirm. */
    const [pantryDraft, setPantryDraft] = useState<Set<number>>(new Set());

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
        const isWeighable = isWeighableDisplay(item?.isWeighable, item?.quantity ?? raw);
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
    const runInstantiate = useCallback(async (force: boolean, skip?: number[]) => {
        if (!template) return;
        try {
            setInstantiating(true);
            const userId = await getUserId();
            const result = await instantiateTemplate(template.id, userId, {
                force,
                skipPantryProductIds: skip ?? [...(pantryChoice ?? [])],
            });
            router.replace(`/basket/${result.basketId}` as any);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorInstantiate'));
        } finally {
            setInstantiating(false);
        }
    }, [template, router, t, pantryChoice]);

    /**
     * Build the recipe through the normal Catalog: point the session at this
     * template, then drop into the tab — adds land in the template via
     * addProductToBasket's target branch. Shared by the dashed row inside the list
     * and the footer's primary action on an empty recipe, so both cannot drift.
     */
    const startAddingItems = useCallback(() => {
        if (!template) return;
        useTemplateAddState.getState().hydrate(template.id);
        useBasketSession.getState().setTarget({ kind: 'template', templateId: template.id, name: template.name });
        router.navigate('/(tabs)/catalog' as any);
    }, [template, router]);

    /** The recipe's cupboard staples, in list order. */
    const pantryItems = useMemo(
        () => (template?.items ?? []).filter(it => Number(it.isPantry) === 1),
        [template],
    );

    const handleInstantiate = useCallback(async () => {
        if (!template || instantiating) return;
        /**
         * ASK BEFORE BUYING SALT AGAIN. A recipe carries its staples for good;
         * whether THIS trip needs them is a different question, and it is the
         * shopper's to answer. Offered once per attempt — `pantryChoice` is set
         * (possibly to an empty set) by the sheet, so confirming twice does not
         * re-open it.
         */
        if (pantryItems.length > 0 && pantryChoice === null) {
            setPantryOpen(true);
            return;
        }
        try {
            setInstantiating(true);
            const userId = await getUserId();
            // First attempt: no force flag — server returns action='resume'
            // when an in-progress instance already exists for this template.
            // That's the signal to ask the user whether they want to
            // continue the existing basket or start fresh.
            const result = await instantiateTemplate(template.id, userId, {
                skipPantryProductIds: [...(pantryChoice ?? [])],
            });
            if (result.action === 'resume') {
                setInstantiating(false);
                // Souply-themed choice (not the native Alert).
                setResumeBasketId(result.basketId);
                return;
            }
            router.replace(`/basket/${result.basketId}` as any);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorInstantiate'));
            setInstantiating(false);
            return;
        }
        setInstantiating(false);
    }, [template, instantiating, router, t, runInstantiate, pantryItems, pantryChoice]);

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
    // Ink is CHOSEN against the cover, not assumed white. The palette's amber
    // (#F0AE3F) gives white text a 1.94:1 contrast ratio — below WCAG's 3:1 floor
    // even for large text — which is why a yellow cover's title was unreadable.
    const onCover = template.coverColor
        ? inkOn(template.coverColor, colors.textPrimary)
        : colors.textPrimary;
    const headerEmoji = coverEmoji(template.coverImage) ?? '🫜';

    /**
     * The page a recipe was imported FROM.
     *
     * `BasketTemplate.sourceUrl`/`sourceSite` are real columns now, written by
     * the import flow — so this reads the row instead of the hardcoded null that
     * stood here while the server had nowhere to put the address. A hand-made
     * recipe still has none, which is what keeps the source cards disabled for
     * those; the layout stays honest either way.
     *
     * `sourceSite` is stored alongside the URL so the byline needs no parsing,
     * but it is derived here as a fallback for rows written before that column.
     */
    const sourceUrl: string | null = template.sourceUrl ?? null;
    const sourceSite = template.sourceSite ?? (() => {
        if (!sourceUrl) return null;
        try { return new URL(sourceUrl).hostname.replace(/^www\./, ''); } catch { return null; }
    })();
    const openSource = (url: string | null) => { if (url) Linking.openURL(url).catch(() => {}); };

    // An EMPTY recipe cannot become a basket — a basket with nothing in it has
    // nothing to compare — so the shopping action stays dead until it has items.
    const canShop = template.items.length > 0;

    return (
        <>
            {/* Unified header: cover-coloured bar carrying ONLY back + the
                tappable emoji/name title that collapses on scroll; the Items/Stats
                tabs stay pinned. The actions live in the bottom dock — glass pills
                on a coloured bar wash out into empty white outlines. */}
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
                    headerLeft: () => <ScreenBackButton color={template.coverColor ? onCover : colors.primary} />,
                }}
            />

            {/* Items/Stats switcher — always-pinned real element under the native
                bar (a tab switcher must not scroll away). */}
            {authedUser && !isDefault && (
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
            )}

            <View style={styles.container}>
                {!(authedUser && tab === 'stats') ? (
                <>
                <Animated.FlatList
                    {...header.scroll}
                    style={{ flex: 1 }}
                    data={template.items}
                    keyExtractor={(item: any) => `i-${item.id}`}
                    contentContainerStyle={[styles.list, { paddingTop: 0, paddingBottom: dockClearance + 28 }]}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={async () => { setRefreshing(true); await fetchTemplate(true); setRefreshing(false); }}
                            colors={[colors.primary]}
                            tintColor={colors.primary}
                        />
                    }
                    ListHeaderComponent={
                        <>
                        {<TouchableOpacity
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
                    </TouchableOpacity>}
                        {isDefault ? (
                            <View style={styles.settingRow}>
                                <View style={{ flex: 1, marginRight: 12 }}>
                                    <Text style={styles.settingLabel}>{t('basketTab.templates.learnLabel')}</Text>
                                    <Text style={styles.settingHint}>{t('basketTab.templates.learnHint')}</Text>
                                </View>
                                <Switch
                                    value={template.autoUpdate === 1}
                                    onValueChange={toggleLearning}
                                    trackColor={{ false: colors.border, true: colors.primary }}
                                    thumbColor={colors.onPrimary}
                                />
                            </View>
                        ) : (
                            <TouchableOpacity
                                style={styles.addItemBtn}
                                onPress={startAddingItems}
                                activeOpacity={0.7}
                            >
                                <Ionicons name="add" size={18} color={colors.primary} />
                                <Text style={styles.addItemBtnText}>{t('basketTab.templates.addItemTitle')}</Text>
                            </TouchableOpacity>
                        )}
                        </>
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
                        const numeric = Number(item.quantity);
                        const isWeighable = isWeighableDisplay(item.isWeighable, numeric);
                        const fallbackQty = isWeighable
                            ? numeric.toFixed(1).replace('.', ',')
                            : String(Math.round(numeric));
                        const qty = qtyInputs[item.id] ?? fallbackQty;
                        const step = isWeighable ? 0.1 : 1;
                        return (
                            <ProductLineCard
                                name={item.productName}
                                imageUrls={item.imageUrls}
                                readOnly={isDefault}
                                readOnlyQtyText={`${fallbackQty} ${isWeighable ? 'kg' : 'vnt.'}`}
                                quantityText={qty}
                                unit={isWeighable ? 'kg' : 'vnt.'}
                                weighable={isWeighable}
                                onChangeQuantity={(v) => {
                                    // Piece items: digits only. Weighable: digits +
                                    // one decimal separator with <= 1 digit after it.
                                    if (isWeighable) {
                                        if (!/^[0-9]*[.,]?[0-9]?$/.test(v)) return;
                                    } else {
                                        if (/[^0-9]/.test(v)) return;
                                    }
                                    setQtyInputs(p => ({ ...p, [item.id]: v }));
                                }}
                                onCommitQuantity={(text) => {
                                    const txt = text.replace(',', '.');
                                    const val = isWeighable ? parseFloat(txt) : parseInt(txt, 10);
                                    if (!val || val <= 0) removeItem(item.id);
                                    else setQty(item.id, val);
                                    setQtyInputs(p => { const c = { ...p }; delete c[item.id]; return c; });
                                }}
                                onDecrement={() => setQty(item.id, Number(item.quantity) - step)}
                                onIncrement={() => setQty(item.id, Number(item.quantity) + step)}
                                onRemove={() => removeItem(item.id)}
                            />
                        );
                    }}
                />
                </>
                ) : (
                    // Statistika — real creator metrics. Same data the website
                    // shows on the template card. Only reachable when signed in
                    // (tabs are hidden otherwise).
                    <Animated.ScrollView {...header.scroll} style={{ flex: 1 }} contentContainerStyle={[styles.statsScroll, { paddingTop: 0, paddingBottom: dockClearance + 28 }]}>
                        {<TouchableOpacity
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
                    </TouchableOpacity>}
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

                {/* Bottom dock — the recipe's actions, mirroring basket detail:
                    collapsed it is a bar (add items · Apsipirkimas), swiped up it
                    is the sheet that took over from the nav bar's glass pills. */}
                <DockedGlassSheet
                    ref={sheetRef}
                    colors={colors}
                    onCollapsedClearance={setDockClearance}
                    barRowHeight={barRowH}
                    barRow={
                        <View
                            style={styles.barRow}
                            onLayout={e => { const h = Math.round(e.nativeEvent.layout.height); if (h > 0) setBarRowH(h); }}
                        >
                            {/* The auto template is read-only — nothing to add to. */}
                            {!isDefault && (
                                <TouchableOpacity style={styles.addMoreBtn} onPress={startAddingItems} activeOpacity={0.7}>
                                    <Ionicons name="add" size={20} color={colors.primary} />
                                    <Text style={styles.addMoreText}>{t('basketTab.templates.addItemsCta')}</Text>
                                </TouchableOpacity>
                            )}
                            <ScalePressable
                                style={[styles.shopPill, isDefault && { flex: 1 }, (!canShop || instantiating) && styles.shopPillDisabled]}
                                onPress={handleInstantiate}
                                disabled={!canShop || instantiating}
                                scaleTo={!canShop || instantiating ? 1 : 0.95}
                            >
                                {instantiating
                                    ? <MaterialProgress size="small" color={colors.onPrimary} />
                                    : (
                                        <>
                                            <Text style={styles.shopPillText}>{t('basketTab.templates.shoppingCta')}</Text>
                                            <Ionicons name="chevron-forward" size={16} color={colors.onPrimary} />
                                        </>
                                    )}
                            </ScalePressable>
                        </View>
                    }
                    sheet={{
                        maxStage: 2,
                        content: (
                            <View style={styles.sheetPanelContent}>
                                <Text style={styles.sheetTitle}>{t('basketDetail.actionsTitle')}</Text>
                                {/* Source of the recipe. Both cards need the imported
                                    page's address, which no template row carries — see
                                    `sourceUrl` above — so they sit disabled rather than
                                    lying about where this recipe came from. */}
                                <DockActionRow
                                    colors={colors}
                                    gap={14}
                                    actions={[
                                        {
                                            icon: 'reader-outline',
                                            title: t('basketTab.templates.openRecipeTitle'),
                                            subtitle: sourceSite ?? t('basketTab.templates.sourceUnknown'),
                                            onPress: () => openSource(sourceUrl),
                                            disabled: !sourceUrl,
                                        },
                                        {
                                            icon: 'globe-outline',
                                            title: t('basketTab.templates.websiteTitle'),
                                            subtitle: sourceSite ?? t('basketTab.templates.sourceUnknown'),
                                            // Opens the RECIPE, not the site's front page. There
                                            // used to be a separate "open recipe" card for that;
                                            // with it gone this is the only way back to the
                                            // instructions, and a shopper tapping the source
                                            // wants the page they imported, not lamaistas.lt.
                                            onPress: () => openSource(sourceUrl),
                                            disabled: !sourceUrl,
                                        },
                                    ]}
                                />

                                {/* Share — the trip invite pane's structure (section
                                    card, then ONE filled primary button; the link is
                                    never printed here). The consecutive views — QR,
                                    copyable link, download — live in TemplateShareSheet,
                                    which the button opens. The sheet must collapse
                                    first: a Modal over an expanded dock stacks two
                                    surfaces and flickers on Android. */}
                                {!isDefault && (
                                    <DockSection
                                        colors={colors}
                                        icon="share-social-outline"
                                        title={t('basketTab.templates.shareTitle')}
                                    >
                                        <TouchableOpacity
                                            style={[styles.shareBtn, !canShop && styles.shareBtnDisabled]}
                                            onPress={() => { sheetRef.current?.collapse(); setShareSheetOpen(true); }}
                                            disabled={!canShop}
                                            activeOpacity={0.85}
                                        >
                                            <Ionicons
                                                name={Platform.OS === 'ios' ? 'share-outline' : 'share-social'}
                                                size={17}
                                                color={colors.onPrimary}
                                            />
                                            <Text style={styles.shareBtnText}>{t('basketTab.templates.shareNative')}</Text>
                                        </TouchableOpacity>
                                        {!canShop && (
                                            <Text style={styles.shareHint}>{t('basketTab.templates.shareNoItems')}</Text>
                                        )}
                                    </DockSection>
                                )}

                                {/* What the nav bar's ellipsis used to hold. Copy is
                                    available for every recipe — it is the only way to
                                    "edit" the auto one; the auto one can't be deleted. */}
                                <SheetCard>
                                    <TouchableOpacity
                                        style={styles.sheetRow}
                                        onPress={() => { sheetRef.current?.collapse(); handleDuplicate(); }}
                                    >
                                        <Text style={[styles.sheetRowText, { color: colors.textPrimary }]}>
                                            {t('basketTab.templates.copyTemplate')}
                                        </Text>
                                    </TouchableOpacity>
                                    {!isDefault && (
                                        <>
                                            <View style={styles.sectionSep} />
                                            <TouchableOpacity
                                                style={styles.sheetRow}
                                                onPress={() => { sheetRef.current?.collapse(); confirmDelete(); }}
                                            >
                                                <Text style={[styles.sheetRowText, { color: colors.error }]}>
                                                    {t('basketTab.templates.deleteConfirm')}
                                                </Text>
                                            </TouchableOpacity>
                                        </>
                                    )}
                                </SheetCard>
                            </View>
                        ),
                    }}
                />
            </View>

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

            {/*
              * "What do you already have?" — the ONLY place a staple can be
              * dropped. Default is keep: nothing leaves the basket unless the
              * shopper says so, and the recipe is untouched either way.
              */}
            <Modal
                visible={pantryOpen}
                transparent
                animationType="fade"
                statusBarTranslucent
                onRequestClose={() => setPantryOpen(false)}
            >
                <Pressable style={styles.resumeBackdrop} onPress={() => setPantryOpen(false)}>
                    <Pressable style={styles.resumeCard} onPress={() => {}}>
                        <Text style={styles.resumeTitle}>{t('basketTab.templates.pantryTitle')}</Text>
                        <Text style={styles.resumeBody}>{t('basketTab.templates.pantryBody')}</Text>

                        <ScrollView style={styles.pantryList} bounces={false}>
                            {pantryItems.map(it => {
                                const dropped = pantryDraft.has(it.productId);
                                return (
                                    <TouchableOpacity
                                        key={it.id}
                                        style={styles.pantryRow}
                                        activeOpacity={0.7}
                                        onPress={() => setPantryDraft(prev => {
                                            const next = new Set(prev);
                                            if (next.has(it.productId)) next.delete(it.productId);
                                            else next.add(it.productId);
                                            return next;
                                        })}
                                    >
                                        <Ionicons
                                            name={dropped ? 'checkbox' : 'square-outline'}
                                            size={22}
                                            color={dropped ? colors.primary : colors.textSecondary}
                                        />
                                        <Text
                                            style={[styles.pantryName, dropped && styles.pantryNameDropped]}
                                            numberOfLines={1}
                                        >
                                            {it.productName}
                                        </Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </ScrollView>

                        <TouchableOpacity
                            style={styles.resumeCancelBtn}
                            activeOpacity={0.7}
                            onPress={() => setPantryDraft(prev =>
                                prev.size === pantryItems.length
                                    ? new Set()
                                    : new Set(pantryItems.map(it => it.productId)))}
                        >
                            <Text style={styles.resumeCancelText}>
                                {t(pantryDraft.size === pantryItems.length
                                    ? 'basketTab.templates.pantryKeepAll'
                                    : 'basketTab.templates.pantryRemoveAll')}
                            </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.resumePrimaryBtn}
                            activeOpacity={0.85}
                            onPress={() => {
                                setPantryOpen(false);
                                // Set the choice AND carry it into this attempt:
                                // state has not committed yet when handleInstantiate
                                // reads it, so the list is passed explicitly.
                                setPantryChoice(new Set(pantryDraft));
                                runInstantiate(false, [...pantryDraft]);
                            }}
                        >
                            <Text style={styles.resumePrimaryText}>{t('basketTab.templates.pantryConfirm')}</Text>
                        </TouchableOpacity>
                    </Pressable>
                </Pressable>
            </Modal>

            {/* Resume-or-new choice (Souply-themed, replaces the native Alert). */}
            <Modal
                visible={resumeBasketId !== null}
                transparent
                animationType="fade"
                statusBarTranslucent
                onRequestClose={() => setResumeBasketId(null)}
            >
                <Pressable style={styles.resumeBackdrop} onPress={() => setResumeBasketId(null)}>
                    <Pressable style={styles.resumeCard} onPress={() => {}}>
                        <Text style={styles.resumeTitle}>{t('basketTab.templates.resumeTitle')}</Text>
                        <Text style={styles.resumeBody}>{t('basketTab.templates.resumeBody')}</Text>
                        <TouchableOpacity
                            style={styles.resumePrimaryBtn}
                            activeOpacity={0.85}
                            onPress={() => {
                                const bid = resumeBasketId;
                                setResumeBasketId(null);
                                if (bid != null) router.replace(`/basket/${bid}` as any);
                            }}
                        >
                            <Text style={styles.resumePrimaryText}>{t('basketTab.templates.resumeContinue')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.resumeSecondaryBtn}
                            activeOpacity={0.85}
                            onPress={() => { setResumeBasketId(null); runInstantiate(true); }}
                        >
                            <Text style={styles.resumeSecondaryText}>{t('basketTab.templates.resumeNew')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.resumeCancelBtn} activeOpacity={0.7} onPress={() => setResumeBasketId(null)}>
                            <Text style={styles.resumeCancelText}>{t('basketTab.templates.resumeBasketCancel')}</Text>
                        </TouchableOpacity>
                    </Pressable>
                </Pressable>
            </Modal>

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

    // Resume-or-new choice modal.
    pantryList: { maxHeight: 260, marginBottom: 12 },
    pantryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
    pantryName: { flex: 1, fontSize: 15, fontWeight: '600', color: c.textPrimary },
    pantryNameDropped: { color: c.textSecondary, textDecorationLine: 'line-through' },
    resumeBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 28 },
    resumeCard: { width: '100%', maxWidth: 420, backgroundColor: c.cardBackground, borderRadius: 22, padding: 22 },
    resumeTitle: { fontSize: 18, fontWeight: '800', color: c.textPrimary, textAlign: 'center' },
    resumeBody: { fontSize: 14, color: c.textSecondary, textAlign: 'center', marginTop: 8, marginBottom: 18, lineHeight: 20 },
    resumePrimaryBtn: { backgroundColor: c.primary, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
    resumePrimaryText: { color: c.onPrimary, fontSize: 15, fontWeight: '700' },
    resumeSecondaryBtn: { marginTop: 10, borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 1.5, borderColor: c.primary },
    resumeSecondaryText: { color: c.primary, fontSize: 15, fontWeight: '700' },
    resumeCancelBtn: { marginTop: 6, paddingVertical: 12, alignItems: 'center' },
    resumeCancelText: { color: c.textSecondary, fontSize: 15, fontWeight: '600' },

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
        gap: 12, borderWidth: 4, borderColor: 'transparent', borderLeftColor: c.primary,
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
        backgroundColor: c.cardBackground, borderRadius: radius.lg,
        padding: 12, marginBottom: 8, gap: 12,
        ...elevation.level1,
    },
    productImage: { width: 44, height: 44, borderRadius: radius.md },
    productImagePlaceholder: {
        width: 44, height: 44, borderRadius: radius.md,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    },
    productImageEmoji: { fontSize: 24, opacity: 0.5 },
    cardContent: { flex: 1, gap: 6 },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    controls: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
    },
    controlButton: {
        width: 28, height: 28, borderRadius: radius.md,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.primaryMuted,
    },
    // Box owns the visual border + corner clipping; the TextInput inside
    // is borderless so the Android system underline has nothing to draw
    // against and can't bleed through.
    quantityInputBox: {
        minWidth: 48, borderWidth: 1, borderColor: c.border, borderRadius: radius.md,
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

    // ── Bottom dock ───────────────────────────────────────────────────────
    // Row layout only — the sheet owns the glass surface, pill and radii.
    barRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, paddingHorizontal: 4,
    },
    addMoreBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 6 },
    addMoreText: { fontSize: 15, fontWeight: '700', color: c.primary },
    shopPill: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingHorizontal: 20, paddingVertical: 10,
    },
    shopPillDisabled: { opacity: 0.45 },
    shopPillText: { fontSize: 15, fontWeight: '700', color: c.onPrimary },
    sheetPanelContent: {
        paddingHorizontal: 16,
        // Reserves the cards' shadow halo — the sheet's scroll viewport clips
        // overflow, so a smaller pad cuts the bottom card's shadow off.
        paddingBottom: SHEET_CARD_SHADOW_RADIUS,
        // ONE gap: between the source cards, and between every section below.
        gap: 14,
    },
    sheetTitle: { fontSize: 22, fontWeight: '700', color: c.textPrimary },
    sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
    sheetRowText: { fontSize: 15, fontWeight: '400' },
    sectionSep: { height: DIVIDER_ITEM_HEIGHT, backgroundColor: c.dividerItem },
    // The trip invite pane's primary share button, verbatim.
    shareBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        alignSelf: 'stretch', backgroundColor: c.primary, borderRadius: radius.md,
        paddingVertical: 11, marginTop: 12,
    },
    shareBtnDisabled: { opacity: 0.5 },
    shareBtnText: { color: c.onPrimary, fontSize: 14, fontWeight: '700' },
    shareHint: { fontSize: 12, color: c.textSecondary, textAlign: 'center', marginTop: 8 },

    addItemBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 6, paddingVertical: 12, borderRadius: radius.lg, marginBottom: 12,
        borderWidth: 1, borderColor: c.primary, borderStyle: 'dashed',
    },
    addItemBtnText: { fontSize: 14, fontWeight: '600', color: c.primary },

    // ── Empty states ──────────────────────────────────────────────────────
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 18 },
    hintText: { fontSize: 13, color: c.textMuted, textAlign: 'center' },

});
