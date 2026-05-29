import { View, Text, FlatList, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, RefreshControl, Modal, TextInput } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TabHeader } from '../../components/TabHeader';
import { StoreChipBar } from '../../components/StoreChipBar';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { useBasketState } from '../../state/basketState';
import { useTheme, type AppTheme } from '../../constants/theme';
import { ScalePressable } from '../../components/ScalePressable';
import { SkeletonBox } from '../../components/SkeletonBox';
import { formatDate, formatEuro } from '../../utils/formatCurrency';
import {
    listTemplates,
    createTemplate,
    ackAutoUpdate,
    type BasketTemplate,
} from '../../utils/basketTemplatesApi';
import { SystemNoticeCard } from '../../components/SystemNoticeCard';

interface Basket {
    id: number;
    userId: string;
    status: string;
    name: string | null;
    createdAt: string;
    updatedAt: string;
    itemCount: number;
    /** Sum of (price × quantity) for the ShoppingList tied to this basket,
     *  rounded to 2dp. Null for draft / compared baskets that haven't had
     *  a store selected yet. */
    selectedStoreTotal: string | number | null;
    /** Cheapest store's total from the most recent comparison run.
     *  Drives the "nuo €X" line on compared baskets. */
    cheapestTotal: string | number | null;
}

type ViewMode = 'baskets' | 'templates';
type BasketStatus = 'draft' | 'compared' | 'inProgress' | 'completed';

const STATUS_PRIORITY: BasketStatus[] = ['draft', 'compared', 'inProgress', 'completed'];

const INITIAL_PAGE_SIZE = 10;
const PAGE_INCREMENT = 10;

/**
 * Accordion section with the same animation feel as Narsyti's L1 categories.
 * Mirrors the ghost-view-measures-natural-height pattern from
 * app/(tabs)/browse/index.tsx — Reanimated shared values drive a height
 * tween + chevron rotation, both 220 ms with `Easing.inOut(quad)`.
 */
const BasketSection = memo(function BasketSection({
    status, label, count, isExpanded, isEmpty, onToggle, children, styles, colors,
}: {
    status: BasketStatus;
    label: string;
    count: number;
    isExpanded: boolean;
    isEmpty: boolean;
    onToggle: (status: BasketStatus) => void;
    children: React.ReactNode;
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
}) {
    const contentHeightRef = useRef(0);
    const animatedHeight = useSharedValue(0);
    const chevronRotation = useSharedValue(0);

    useLayoutEffect(() => {
        animatedHeight.value = withTiming(isExpanded ? contentHeightRef.current : 0, {
            duration: 220,
            easing: Easing.inOut(Easing.quad),
        });
        chevronRotation.value = withTiming(isExpanded ? 1 : 0, { duration: 220 });
    }, [isExpanded]);

    const animatedContentStyle = useAnimatedStyle(() => ({
        height: animatedHeight.value,
        overflow: 'hidden',
    }));

    const chevronStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${chevronRotation.value * 180}deg` }],
    }));

    // Ghost view measurement — absolutely positioned + invisible. Whenever
    // its layout fires, we capture the natural content height and, if the
    // section is currently expanded, retarget the animation to match.
    const handleLayout = (e: { nativeEvent: { layout: { height: number } } }) => {
        const h = e.nativeEvent.layout.height;
        if (h > 0 && h !== contentHeightRef.current) {
            contentHeightRef.current = h;
            if (isExpanded) {
                animatedHeight.value = withTiming(h, { duration: 150 });
            }
        }
    };

    return (
        <View style={styles.section}>
            <TouchableOpacity
                style={[styles.sectionHeader, isExpanded && styles.sectionHeaderOpen]}
                onPress={() => !isEmpty && onToggle(status)}
                activeOpacity={isEmpty ? 1 : 0.7}
            >
                <Text style={[styles.sectionHeaderTitle, isEmpty && styles.sectionHeaderMuted]}>
                    {label}
                </Text>
                <Text style={[styles.sectionHeaderCount, isEmpty && styles.sectionHeaderMuted]}>
                    {count}
                </Text>
                {!isEmpty && (
                    <Animated.View style={[chevronStyle, { marginLeft: 8 }]}>
                        <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
                    </Animated.View>
                )}
            </TouchableOpacity>
            {/* Ghost view that the layout pass uses to measure natural content
                height. Absolutely positioned so its size doesn't push the
                surrounding layout while it measures. */}
            <View
                style={{ position: 'absolute', opacity: 0, left: 0, right: 0 }}
                pointerEvents="none"
                onLayout={handleLayout}
            >
                {children}
            </View>
            <Animated.View style={animatedContentStyle}>
                {children}
            </Animated.View>
        </View>
    );
});

export default function BasketScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const { setDraftBasketId } = useBasketState();

    const [baskets, setBaskets] = useState<Basket[]>([]);
    const [templates, setTemplates] = useState<BasketTemplate[]>([]);
    // Receipt counts power the onboarding gate: 3 receipts × 2 chains.
    // We track distinct chains client-side rather than asking the server
    // because the receipt list is already small (<100 typical) and the
    // computation is trivial.
    const [receiptCount, setReceiptCount] = useState(0);
    const [distinctChainCount, setDistinctChainCount] = useState(0);
    const [gateDismissed, setGateDismissed] = useState(false);
    // `loading` = full-screen spinner on FIRST mount only.
    // `refreshing` = small header pill shown on subsequent focus refetches
    // so the list doesn't blank out every time the tab regains focus.
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [pullRefreshing, setPullRefreshing] = useState(false);

    // Two top-level chips: baskets / templates. Default depends on what
    // the user actually has — if there are templates but no baskets, open
    // on templates so the empty Krepšeliai accordion doesn't dominate.
    const [view, setView] = useState<ViewMode>('baskets');
    // Set of expanded section statuses. Multi-expand: users can open all,
    // close all, or any combination. Initial state is empty; the
    // auto-expand effect below picks the priority section once baskets
    // have loaded.
    const [expandedSet, setExpandedSet] = useState<Set<BasketStatus>>(() => new Set());
    const [visibleCount, setVisibleCount] = useState(INITIAL_PAGE_SIZE);

    // Blank-template creation: tapping the "+" card opens this modal.
    // Spec 1.1 path A — for users crafting a list without shopping first.
    const [createModalOpen, setCreateModalOpen] = useState(false);
    const [createName, setCreateName] = useState('');
    const [createBusy, setCreateBusy] = useState(false);
    const createInputRef = useRef<TextInput>(null);

    // Announcement card — shown when the server-generated default template
    // (isDefault=1) appears for the first time. Dismissal is per-template-id
    // so a fresh auto-update doesn't re-show the card unless it really is
    // the user's first one. Stored under TEMPLATE_ANNOUNCE_KEY:{id}.
    const [dismissedAnnounceId, setDismissedAnnounceId] = useState<number | null>(null);

    const hasFetchedRef = useRef(false);
    // Auto-expand the priority section the first time baskets land, but
    // never again — subsequent fetches must not stomp the user's manual
    // expand/collapse state. A ref is the simplest way to gate this once.
    const autoExpandedRef = useRef(false);
    const initialViewSetRef = useRef(false);

    const fetchAll = useCallback(async (silent: boolean) => {
        if (silent) setRefreshing(true);
        try {
            const userId = await getUserId();
            const [basketRes, templateRes, receiptRes] = await Promise.all([
                fetch(`${API_BASE_URL}/api/baskets/user/${userId}`).then(r => r.json()).catch(() => []),
                listTemplates(userId).catch(() => []),
                fetch(`${API_BASE_URL}/api/users/${userId}/receipts`).then(r => r.json()).catch(() => []),
            ]);
            const basketList: Basket[] = Array.isArray(basketRes) ? basketRes : [];
            setBaskets(basketList);
            setTemplates(templateRes);
            const receipts: Array<{ chainName?: string | null }> = Array.isArray(receiptRes) ? receiptRes : [];
            setReceiptCount(receipts.length);
            const distinctChains = new Set(receipts.map(r => r.chainName).filter(c => !!c));
            setDistinctChainCount(distinctChains.size);
            const draft = basketList.find(b => b.status === 'draft');
            setDraftBasketId(draft ? draft.id : null);

            // First successful load only: pick a starting chip. If the user
            // has zero baskets but ≥1 template, start on Templates so they
            // see something. Otherwise default to Baskets.
            if (!initialViewSetRef.current) {
                initialViewSetRef.current = true;
                if (basketList.length === 0 && templateRes.length > 0) {
                    setView('templates');
                }
            }
        } catch (error) {
            console.error('Failed to fetch baskets:', error);
        } finally {
            if (silent) setRefreshing(false);
            setLoading(false);
        }
    }, [setDraftBasketId]);

    useFocusEffect(useCallback(() => {
        const silent = hasFetchedRef.current;
        hasFetchedRef.current = true;
        fetchAll(silent);
    }, [fetchAll]));

    // Basket lifecycle is exactly four states: draft (editable), compared
    // (calculated, read-only until reverted), inProgress (shopping list
    // created, basket locked), completed (shopping wrapped up). The per-
    // card status badge is gone (status is communicated by accordion
    // section), but the label lookup stays — section headers reuse it.
    const getStatusText = (status: string) => {
        switch (status) {
            case 'draft': return t('basketTab.statusDraft');
            case 'compared': return t('basketTab.statusCompared');
            case 'inProgress': return t('basketTab.statusInProgress');
            case 'completed': return t('basketTab.statusCompleted');
            default: return status;
        }
    };

    // ─── Grouping for the Krepšeliai accordion ────────────────────────────
    const grouped = useMemo<Record<BasketStatus, Basket[]>>(() => {
        const map: Record<BasketStatus, Basket[]> = {
            draft: [], compared: [], inProgress: [], completed: [],
        };
        baskets.forEach(b => {
            if (b.status in map) map[b.status as BasketStatus].push(b);
        });
        return map;
    }, [baskets]);

    // On first non-empty load, open the priority section so the user
    // lands on something meaningful. After that, expand/collapse is
    // entirely manual — including the option to collapse everything.
    useEffect(() => {
        if (autoExpandedRef.current) return;
        if (baskets.length === 0) return;
        const first = STATUS_PRIORITY.find(s => grouped[s].length > 0);
        if (first) {
            setExpandedSet(new Set([first]));
            autoExpandedRef.current = true;
        }
    }, [baskets.length, grouped]);

    const hasAnyBaskets = baskets.length > 0;

    // Two chips at the top — view toggle only, no count badge because the
    // numbers live on the accordion section headers instead.
    const chips = useMemo(() => [
        { id: 'baskets', label: t('basketTab.chipBaskets') },
        { id: 'templates', label: t('basketTab.chipTemplates') },
    ], [t]);

    // Default (auto-generated) template — what powers the announcement card.
    const defaultTemplate = useMemo(
        () => templates.find(t => t.isDefault === 1) ?? null,
        [templates],
    );

    // Rehydrate the dismissal flag whenever the default template changes
    // so the card doesn't flash on every focus refetch.
    useEffect(() => {
        if (!defaultTemplate) return;
        AsyncStorage.getItem(`template_announce_dismissed:${defaultTemplate.id}`)
            .then(v => { if (v === '1') setDismissedAnnounceId(defaultTemplate.id); });
    }, [defaultTemplate?.id]);

    // Onboarding gate dismissal persists across sessions. Once the user
    // taps "Vėliau" we never bring the full-screen card back; the slim
    // banner replaces it until they hit the 3-receipt × 2-chain bar.
    useEffect(() => {
        AsyncStorage.getItem('template_gate_dismissed')
            .then(v => { if (v === '1') setGateDismissed(true); });
    }, []);

    const dismissGate = useCallback(async () => {
        setGateDismissed(true);
        try { await AsyncStorage.setItem('template_gate_dismissed', '1'); } catch {}
    }, []);

    // Gate logic: show full-screen card if the user has no template
    // AND hasn't dismissed AND hasn't met the threshold. Show the slim
    // banner if dismissed but still short of the threshold. Hide both
    // once a default template exists.
    const meetsThreshold = receiptCount >= 3 && distinctChainCount >= 2;
    const showGate = !defaultTemplate && !meetsThreshold && !gateDismissed;
    const showGateBanner = !defaultTemplate && !meetsThreshold && gateDismissed;

    // Auto-update nudge — appears once when the server-side regeneration
    // produces a delta > 3. Acked via PATCH which clears the counter.
    const nudgeDelta = defaultTemplate?.lastAutoUpdateDelta ?? 0;
    const showNudge = !!defaultTemplate && nudgeDelta > 3;

    const ackNudge = useCallback(async (templateId: number) => {
        try {
            await ackAutoUpdate(templateId);
        } catch {}
        // Optimistically clear locally so the nudge disappears even before
        // the next refetch lands.
        setTemplates(prev => prev.map(t =>
            t.id === templateId ? { ...t, lastAutoUpdateDelta: null } : t
        ));
    }, []);

    const dismissAnnouncement = useCallback(async (templateId: number) => {
        setDismissedAnnounceId(templateId);
        try {
            await AsyncStorage.setItem(`template_announce_dismissed:${templateId}`, '1');
        } catch {}
    }, []);

    const showAnnouncement = !!defaultTemplate && dismissedAnnounceId !== defaultTemplate.id;

    const handleSectionTap = useCallback((status: BasketStatus) => {
        if (grouped[status].length === 0) return;
        setExpandedSet(prev => {
            const next = new Set(prev);
            if (next.has(status)) next.delete(status); else next.add(status);
            return next;
        });
    }, [grouped]);

    const handleTemplateTap = (template: BasketTemplate) => {
        // Tap opens the editor so the user can verify items before
        // spawning a basket. The "Create basket" CTA inside the editor
        // (template/[id].tsx) calls POST /instantiate.
        router.push(`/template/${template.id}` as any);
    };

    const submitCreateTemplate = useCallback(async () => {
        const trimmed = createName.trim();
        if (trimmed.length === 0 || createBusy) return;
        try {
            setCreateBusy(true);
            const userId = await getUserId();
            const created = await createTemplate({ userId, name: trimmed });
            setCreateModalOpen(false);
            setCreateName('');
            // Route straight into the editor so the user can start adding
            // items — blank-template creation only makes sense paired with
            // immediate population.
            router.push(`/template/${created.id}` as any);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        } finally {
            setCreateBusy(false);
        }
    }, [createName, createBusy, router, t]);

    if (loading) return (
        <View style={styles.container}>
            <TabHeader title={t('tabs.basket')} />
            <View style={styles.skelChipRow}>
                {Array.from({ length: 2 }).map((_, i) => (
                    <SkeletonBox key={i} width={96} height={32} borderRadius={20} />
                ))}
            </View>
            <View style={{ padding: 16, gap: 12 }}>
                {Array.from({ length: 4 }).map((_, i) => (
                    <SkeletonBox key={i} width="100%" height={48} borderRadius={10} />
                ))}
            </View>
        </View>
    );

    // ─── Šablonai view ────────────────────────────────────────────────────
    if (view === 'templates') {
        return (
            <View style={styles.container}>
                <TabHeader title={t('tabs.basket')} />
                <StoreChipBar
                    chips={chips}
                    selectedId={view}
                    onSelect={id => id != null && setView(id as ViewMode)}
                />
                {refreshing && (
                    <View style={styles.refreshingBanner}>
                        <ActivityIndicator size="small" color={colors.primary} />
                        <Text style={styles.refreshingText}>{t('basketTab.loading')}</Text>
                    </View>
                )}
                <FlatList
                    data={templates}
                    keyExtractor={item => `t-${item.id}`}
                    contentContainerStyle={styles.list}
                    refreshControl={
                        <RefreshControl
                            refreshing={pullRefreshing}
                            onRefresh={async () => { setPullRefreshing(true); await fetchAll(false); setPullRefreshing(false); }}
                            colors={[colors.primary]}
                            tintColor={colors.primary}
                        />
                    }
                    ListHeaderComponent={
                        <TouchableOpacity
                            style={styles.addTemplateCard}
                            onPress={() => {
                                setCreateModalOpen(true);
                                setCreateName('');
                                setTimeout(() => createInputRef.current?.focus(), 80);
                            }}
                            activeOpacity={0.7}
                        >
                            <Ionicons name="add-circle-outline" size={26} color={colors.primary} />
                            <Text style={styles.addTemplateCardText}>{t('basketTab.templates.addCard')}</Text>
                        </TouchableOpacity>
                    }
                    ListEmptyComponent={
                        <View style={styles.centered}>
                            <Ionicons name="bookmarks-outline" size={56} color={colors.textMuted} />
                            <Text style={styles.emptyText}>{t('basketTab.templates.emptyTitle')}</Text>
                            <Text style={styles.emptySubText}>{t('basketTab.templates.emptyBody')}</Text>
                        </View>
                    }
                    renderItem={({ item }) => {
                        const itemCount = Number(item.itemCount ?? 0);
                        const useCount = Number(item.useCount ?? 0);
                        return (
                            <TouchableOpacity
                                style={styles.templateCard}
                                onPress={() => handleTemplateTap(item)}
                                activeOpacity={0.75}
                            >
                                <View style={styles.cardLeft}>
                                    <View style={styles.templateIcon}>
                                        <Ionicons name="bookmark" size={22} color={colors.primary} />
                                    </View>
                                </View>
                                <View style={styles.cardContent}>
                                    <Text style={styles.cardTitle} numberOfLines={1}>{item.name}</Text>
                                    <Text style={styles.cardDate}>
                                        {t('basketTab.templates.itemCount', { count: itemCount })}
                                        {useCount > 0 && ` · ${t('basketTab.templates.useCount', { count: useCount })}`}
                                    </Text>
                                </View>
                                <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                            </TouchableOpacity>
                        );
                    }}
                />
                <Modal
                    visible={createModalOpen}
                    transparent
                    animationType="fade"
                    onRequestClose={() => !createBusy && setCreateModalOpen(false)}
                >
                    <TouchableOpacity
                        style={styles.modalBackdrop}
                        activeOpacity={1}
                        onPress={() => !createBusy && setCreateModalOpen(false)}
                    >
                        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCard}>
                            <Text style={styles.modalTitle}>
                                {t('basketTab.templates.createTitle')}
                            </Text>
                            <Text style={styles.modalLabel}>{t('basketTab.templates.createNameLabel')}</Text>
                            <TextInput
                                ref={createInputRef}
                                value={createName}
                                onChangeText={setCreateName}
                                placeholder={t('basketTab.templates.createNamePlaceholder')}
                                placeholderTextColor={colors.textMuted}
                                maxLength={100}
                                returnKeyType="done"
                                onSubmitEditing={submitCreateTemplate}
                                style={styles.modalInput}
                            />
                            <View style={styles.modalActions}>
                                <TouchableOpacity
                                    onPress={() => setCreateModalOpen(false)}
                                    disabled={createBusy}
                                    style={styles.modalCancel}
                                >
                                    <Text style={styles.modalCancelText}>
                                        {t('basketTab.templates.createCancel')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    onPress={submitCreateTemplate}
                                    disabled={createBusy || createName.trim().length === 0}
                                    style={[
                                        styles.modalConfirm,
                                        (createBusy || createName.trim().length === 0) && styles.modalConfirmDisabled,
                                    ]}
                                >
                                    {createBusy
                                        ? <ActivityIndicator color={colors.onPrimary} />
                                        : <Text style={styles.modalConfirmText}>{t('basketTab.templates.createConfirm')}</Text>}
                                </TouchableOpacity>
                            </View>
                        </TouchableOpacity>
                    </TouchableOpacity>
                </Modal>
            </View>
        );
    }

    // ─── Krepšeliai view (accordion) ──────────────────────────────────────
    return (
        <View style={styles.container}>
            <TabHeader title={t('tabs.basket')} />
            <StoreChipBar
                chips={chips}
                selectedId={view}
                onSelect={id => id != null && setView(id as ViewMode)}
            />
            {refreshing && (
                <View style={styles.refreshingBanner}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={styles.refreshingText}>{t('basketTab.loading')}</Text>
                </View>
            )}
            <ScrollView
                contentContainerStyle={styles.list}
                refreshControl={
                    <RefreshControl
                        refreshing={pullRefreshing}
                        onRefresh={async () => { setPullRefreshing(true); await fetchAll(false); setPullRefreshing(false); }}
                        colors={[colors.primary]}
                        tintColor={colors.primary}
                    />
                }
            >
                {/* Notification surfaces — gate / banner / announcement / nudge */}
                {showGate && (
                            <SystemNoticeCard
                                variant="info"
                                icon="sparkles"
                                title={t('basketTab.templates.gateTitle')}
                                body={`${t('basketTab.templates.gateBody')}\n\n${t('basketTab.templates.gateBodyDetail')}`}
                                onDismiss={dismissGate}
                                actions={[
                                    {
                                        label: t('basketTab.templates.gateLater'),
                                        onPress: dismissGate,
                                        style: 'secondary',
                                    },
                                    {
                                        label: t('basketTab.templates.gateUpload'),
                                        onPress: () => router.navigate('/(tabs)/receipts' as any),
                                        style: 'primary',
                                    },
                                ]}
                            />
                        )}
                        {showGateBanner && (
                            <SystemNoticeCard
                                layout="banner"
                                variant="info"
                                icon="receipt-outline"
                                title={t('basketTab.templates.gateBannerTitle')}
                                body={t('basketTab.templates.gateBannerBody', {
                                    progress: Math.min(receiptCount, 3),
                                    chains: Math.min(distinctChainCount, 2),
                                })}
                                actions={[{
                                    label: t('basketTab.templates.gateBannerCta'),
                                    onPress: () => router.navigate('/(tabs)/receipts' as any),
                                }]}
                            />
                        )}
                        {showNudge && defaultTemplate && (
                            <SystemNoticeCard
                                variant="success"
                                icon="refresh-outline"
                                title={t('basketTab.templates.autoUpdateNudgeTitle')}
                                body={t('basketTab.templates.autoUpdateNudgeBody')}
                                onDismiss={() => ackNudge(defaultTemplate.id)}
                                actions={[
                                    {
                                        label: t('basketTab.templates.autoUpdateNudgeDismiss'),
                                        onPress: () => ackNudge(defaultTemplate.id),
                                        style: 'secondary',
                                    },
                                    {
                                        label: t('basketTab.templates.autoUpdateNudgeCta'),
                                        onPress: () => {
                                            ackNudge(defaultTemplate.id);
                                            router.push(`/template/${defaultTemplate.id}` as any);
                                        },
                                        style: 'primary',
                                    },
                                ]}
                            />
                        )}
                        {showAnnouncement && defaultTemplate && !showNudge && (
                            <SystemNoticeCard
                                variant="info"
                                icon="sparkles"
                                title={t('basketTab.templates.announceTitle')}
                                body={t('basketTab.templates.announceBody')}
                                onDismiss={() => dismissAnnouncement(defaultTemplate.id)}
                                actions={[
                                    {
                                        label: t('basketTab.templates.announceDismiss'),
                                        onPress: () => dismissAnnouncement(defaultTemplate.id),
                                        style: 'secondary',
                                    },
                                    {
                                        label: t('basketTab.templates.announceCta'),
                                        onPress: () => {
                                            dismissAnnouncement(defaultTemplate.id);
                                            router.push(`/template/${defaultTemplate.id}` as any);
                                        },
                                        style: 'primary',
                                    },
                                ]}
                            />
                        )}

                {/* Accordion sections — rendered inline so LayoutAnimation's
                    parent re-flow drives a real height transition. FlatList's
                    virtualized item renderer doesn't propagate layout changes
                    cleanly enough for the animation to show. */}
                {!hasAnyBaskets ? (
                    <View style={styles.centered}>
                        <Ionicons name="cart-outline" size={56} color={colors.textMuted} />
                        <Text style={styles.emptyText}>{t('basketTab.empty')}</Text>
                        <Text style={styles.emptySubText}>{t('basketTab.emptyBody')}</Text>
                        <ScalePressable style={styles.emptyButton} onPress={() => router.navigate('/(tabs)/browse' as any)}>
                            <Text style={styles.emptyButtonText}>{t('basketTab.emptyCta')}</Text>
                        </ScalePressable>
                    </View>
                ) : (
                    STATUS_PRIORITY.map(status => {
                        const rows = grouped[status];
                        const isOpen = expandedSet.has(status);
                        const isEmpty = rows.length === 0;
                        return (
                            <BasketSection
                                key={`s-${status}`}
                                status={status}
                                label={getStatusText(status)}
                                count={rows.length}
                                isExpanded={isOpen}
                                isEmpty={isEmpty}
                                onToggle={handleSectionTap}
                                styles={styles}
                                colors={colors}
                            >
                                {rows.map(b => {
                                    const selected = b.selectedStoreTotal != null
                                        ? Number(b.selectedStoreTotal)
                                        : null;
                                    const cheapest = b.cheapestTotal != null
                                        ? Number(b.cheapestTotal)
                                        : null;
                                    const showSelected =
                                        (b.status === 'inProgress' || b.status === 'completed')
                                        && Number.isFinite(selected) && (selected as number) > 0;
                                    const showCheapest =
                                        b.status === 'compared'
                                        && Number.isFinite(cheapest) && (cheapest as number) > 0;
                                    return (
                                        <TouchableOpacity
                                            key={b.id}
                                            style={styles.card}
                                            onPress={() => router.push(`/basket/${b.id}`)}
                                        >
                                            <View style={styles.cardLeft}>
                                                <View style={styles.iconContainer}>
                                                    <Ionicons name="cart-outline" size={28} color={colors.primary} />
                                                    {b.itemCount > 0 && (
                                                        <View style={styles.badge}>
                                                            <Text style={styles.badgeText}>{b.itemCount}</Text>
                                                        </View>
                                                    )}
                                                </View>
                                            </View>
                                            <View style={styles.cardContent}>
                                                {b.name ? (
                                                    <>
                                                        <Text style={styles.cardTitle} numberOfLines={1}>{b.name}</Text>
                                                        <Text style={styles.cardDate}>{formatDate(b.updatedAt)}</Text>
                                                    </>
                                                ) : (
                                                    <Text style={styles.cardTitle}>{formatDate(b.updatedAt)}</Text>
                                                )}
                                            </View>
                                            {showSelected && (
                                                <Text style={styles.cardTotal}>{formatEuro(selected as number)}</Text>
                                            )}
                                            {showCheapest && (
                                                <Text style={styles.cardTotal}>
                                                    {t('basketTab.fromPrice', { amount: formatEuro(cheapest as number) })}
                                                </Text>
                                            )}
                                        </TouchableOpacity>
                                    );
                                })}
                            </BasketSection>
                        );
                    })
                )}
            </ScrollView>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16, paddingBottom: 80 },

    // ── Skeleton ──────────────────────────────────────────────────────────
    skelChipRow: {
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5, borderBottomColor: c.border,
        flexDirection: 'row', gap: 8,
        paddingHorizontal: 12, paddingVertical: 10,
    },

    // ── Accordion section ─────────────────────────────────────────────────
    // Outer section: holds the border + corner clipping. Header lives flush
    // inside the top, expandable content + cards inside the bottom. The
    // overflow:'hidden' is what gives us the matching bottom rounding the
    // header has on top.
    section: {
        marginBottom: 10,
        borderRadius: 10, overflow: 'hidden',
        borderWidth: 1, borderColor: c.border,
        backgroundColor: c.cardBackground,
    },
    sectionHeader: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 14, paddingVertical: 12,
        backgroundColor: c.cardBackground,
    },
    sectionHeaderOpen: {
        borderBottomWidth: 0.5, borderBottomColor: c.borderSubtle,
    },
    sectionHeaderTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: c.textPrimary },
    sectionHeaderCount: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
    sectionHeaderMuted: { color: c.textMuted, fontWeight: '500' },

    // ── Basket card ───────────────────────────────────────────────────────
    card: {
        backgroundColor: c.cardBackground, padding: 14,
        flexDirection: 'row', alignItems: 'center',
        borderBottomWidth: 0.5, borderBottomColor: c.borderSubtle,
    },
    cardLeft: { marginRight: 12 },
    cardContent: { flex: 1, minWidth: 0 },
    cardTitle: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
    cardDate: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
    cardTotal: { fontSize: 15, fontWeight: '700', color: c.primary, marginLeft: 8 },

    // ── "+ New template" card on the Šablonai list ────────────────────────
    addTemplateCard: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        backgroundColor: c.cardBackground,
        borderRadius: 12, padding: 16, marginBottom: 12,
        borderWidth: 1.5, borderColor: c.primary, borderStyle: 'dashed',
    },
    addTemplateCardText: { fontSize: 14, fontWeight: '700', color: c.primary },

    // ── Blank-template create modal ───────────────────────────────────────
    modalBackdrop: {
        flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
        alignItems: 'center', justifyContent: 'center', padding: 20,
    },
    modalCard: {
        backgroundColor: c.cardBackground, borderRadius: 16,
        padding: 20, width: '100%', gap: 12,
    },
    modalTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    modalLabel: { fontSize: 12, color: c.textMuted, marginTop: 4 },
    modalInput: {
        borderWidth: 1, borderColor: c.border, borderRadius: 10,
        paddingHorizontal: 12, paddingVertical: 10,
        fontSize: 15, color: c.textPrimary,
    },
    modalActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
    modalCancel: {
        flex: 1, paddingVertical: 12, borderRadius: 10,
        borderWidth: 1, borderColor: c.border, alignItems: 'center',
    },
    modalCancelText: { color: c.textPrimary, fontWeight: '600' },
    modalConfirm: {
        flex: 1, paddingVertical: 12, borderRadius: 10,
        backgroundColor: c.primary, alignItems: 'center',
    },
    modalConfirmDisabled: { backgroundColor: c.border },
    modalConfirmText: { color: c.onPrimary, fontWeight: '700' },

    // ── Template card ─────────────────────────────────────────────────────
    templateCard: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 14, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06, shadowRadius: 2,
        borderLeftWidth: 3, borderLeftColor: c.primary,
    },
    templateIcon: {
        width: 36, height: 36, borderRadius: 8,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },

    // ── Empty ─────────────────────────────────────────────────────────────
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', marginTop: 16, textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 18 },
    emptyButton: { marginTop: 20, backgroundColor: c.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
    emptyButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 14 },

    // ── Misc ──────────────────────────────────────────────────────────────
    iconContainer: {
        position: 'relative',
        width: 36, height: 36,
        alignItems: 'center', justifyContent: 'center',
    },
    badge: {
        position: 'absolute', top: -4, right: -6,
        backgroundColor: c.primary, borderRadius: 10,
        minWidth: 18, height: 18,
        alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
    },
    badgeText: { color: c.onPrimary, fontSize: 10, fontWeight: '700' },
    refreshingBanner: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 6, paddingVertical: 4,
        backgroundColor: c.surfaceSubtle,
    },
    refreshingText: { fontSize: 11, color: c.textSecondary, fontWeight: '500' },
});
