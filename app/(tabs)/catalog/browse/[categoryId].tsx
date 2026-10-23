import { View, SectionList, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SkeletonBox } from '@/components/SkeletonBox';
import { useBasketQuantities } from '@/hooks/useBasketQuantities';
import { useEffect, useMemo, useState, useCallback, useRef, memo, Fragment } from 'react';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSafeBottomTabBarHeight } from '@/hooks/useSafeBottomTabBarHeight';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { API_BASE_URL } from '@/config/api';
import { useBasketState } from '@/state/basketState';
import { useBasketSession } from '@/state/basketSession';
import { addProductToBasket } from '@/utils/basketUtils';
import ComparedBasketChoiceModal, { type ComparedBasketChoice } from '@/components/ComparedBasketChoiceModal';
import { ConnectedProductCard } from '@/components/browse/ConnectedProductCard';
import type { UnitPriceBadge } from '@/components/browse/BasketProductCard';
import CategoryBubbles from '@/components/browse/CategoryBubbles';
import { useTemplateAddState } from '@/state/templateAddState';
import { useTheme, radius, elevation, type AppTheme } from '@/constants/theme';
import { useDisplayMode } from '@/contexts/DisplayPreferenceContext';
import { getUserId } from '@/config/user';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Toast, type ToastHandle } from '@/components/Toast';
import { useTranslation } from 'react-i18next';
import { ScalePressable } from '@/components/ScalePressable';
import { GlassIconButton } from '@/components/GlassIconButton';
import { ScreenHeading } from '@/components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '@/components/CollapsingHeader';

interface Category {
    id: number;
    name: string;
}

interface Product {
    id: number;
    name: string;
    brandName: string | null;
    imageUrls?: (string | null | undefined)[] | string | null;
    chainLogos?: { chainId: number; logoUrl: string | null }[] | string | null;
    minAmount: number | null;
    maxAmount: number | null;
    unit: string | null;
    hasWeighable: boolean;
    bestDiscountPct?: number | null;
    /** Canonical-unit fields populated server-side (productCanonical.ts). */
    canonicalUnit: string | null;
    canonicalStep: number | null;
    canonicalFamily: 'fluid' | 'count' | null;
    /** Cheapest-per-unit badge populated server-side (productBadge.ts). */
    badge?: UnitPriceBadge | null;
}



const AnimatedSectionList = Animated.createAnimatedComponent(SectionList as typeof SectionList<Product[]>);

export default function CategoryScreen() {
    const colors = useTheme();
    const { t, i18n } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();
    const barClearance = useSafeBottomTabBarHeight();
    // Collapsing header: category title hides on scroll; the L3 filter stays pinned.
    const header = useCollapsingHeader();
    const { categoryId, name } = useLocalSearchParams<{ categoryId: string; name: string }>();
    // Template vs basket is driven by the SESSION target now, not a route param —
    // building a template reuses this exact catalog flow.
    const sessionTarget = useBasketSession(s => s.target);
    const templateId = sessionTarget?.kind === 'template' ? sessionTarget.templateId : null;
    const isTemplateMode = templateId != null;
    useEffect(() => { if (templateId != null) useTemplateAddState.getState().hydrate(templateId); }, [templateId]);
    const [l3Categories, setL3Categories] = useState<Category[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    // hideId → keepId: products the user personally merged via 'same' swipe verdicts.
    // Only populated in base mode. Merged products are filtered from the list, and
    // their basket quantities are added to the canonical product's count.
    const [userMergeMap, setUserMergeMap] = useState<Record<number, number>>({});
    const [selectedL3, setSelectedL3] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingProducts, setLoadingProducts] = useState(false);
    const { draftBasketId, setDraftBasketId } = useBasketState();
    // ONE target-aware source: session basket (X → chooser switch included),
    // draft fallback; re-fetches on basketRev. Actions only — the screen must
    // NOT subscribe to the quantities map (every ± tap replaces its identity
    // and would re-render the whole grid over the per-card subscriptions).
    const { commit: commitBasketQty, refresh: refreshBasketQuantities } = useBasketQuantities();
    // Products whose "Į krepšelį" POST is currently in flight. Prevents
    // rapid double-taps from firing a second add before the first lands
    // and paints the quantity control over the button.
    const [addingIds, setAddingIds] = useState<Set<number>>(() => new Set());
    const toastRef = useRef<ToastHandle>(null);
    const router = useRouter();
    // Display mode is read-only here now — the in-screen "combine
    // alternatives" toggle banner was removed; the stored preference decides.
    const { mode, ready: prefReady } = useDisplayMode();
    // When no draft basket exists but the user has ≥1 compared basket,
    // adding a product opens this modal so they can choose "use existing
    // (revert to draft)" or "create new". Fetched on focus alongside
    // basketQuantities.
    const [latestCompared, setLatestCompared] = useState<ComparedBasketChoice | null>(null);
    type ComparedChoice = 'use-existing' | 'new' | 'cancel';
    const [comparedModal, setComparedModal] = useState<{
        visible: boolean;
        resolve: (choice: ComparedChoice) => void;
    }>({ visible: false, resolve: () => {} });

    const [loadFailed, setLoadFailed] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    useEffect(() => {
        // Wait for the display-mode preference to load before firing fetches;
        // otherwise the screen flashes default-mode results before switching.
        if (!prefReady) return;
        const fetchData = async () => {
            setLoading(true);
            setLoadFailed(false);
            try {
                const userId = await getUserId();
                const [subRes, prodRes] = await Promise.all([
                    fetch(`${API_BASE_URL}/api/categories/${categoryId}/subcategories`),
                    fetch(`${API_BASE_URL}/api/categories/${categoryId}/all-products-with-amounts?mode=${mode}&userId=${userId}`),
                ]);
                const subData = await subRes.json();
                setL3Categories(Array.isArray(subData) ? subData : []);

                const prodData = await prodRes.json();
                const prods: Product[] = Array.isArray(prodData) ? prodData : [];
                setProducts(prods);

                if (mode === 'base' && prods.length > 0) {
                    const ids = prods.map(p => p.id).join(',');
                    const mergeRes = await fetch(
                        `${API_BASE_URL}/api/users/${userId}/product-merge-map?productIds=${ids}`
                    );
                    setUserMergeMap(mergeRes.ok ? await mergeRes.json() : {});
                } else {
                    setUserMergeMap({});
                }
            } catch {
                // A failed load must not read as "this category is empty" — the
                // list would show "no products" and never try again.
                setLoadFailed(true);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
        // i18n.language dep: subcategories carry localised names; re-fetch
        // when the language changes (or on first hydration) so the chips
        // don't lag behind the rest of the UI.
    }, [categoryId, mode, prefReady, i18n.language, reloadKey]);
    // Draft init still happens once so the no-session fallback has a basket.
    useEffect(() => {
        if (!draftBasketId) void useBasketState.getState().initDraftBasket();
    }, [draftBasketId]);

    // Fetch the user's most recent compared basket for the add-to-basket
    // choice modal. Only matters when there's no draft — if a draft exists
    // we silently add to it. Refetch on focus via a cheap single request.
    useEffect(() => {
        (async () => {
            if (draftBasketId) {
                setLatestCompared(null);
                return;
            }
            try {
                const userId = await getUserId();
                const res = await fetch(`${API_BASE_URL}/api/baskets/user/${userId}`);
                const baskets = await res.json();
                if (!Array.isArray(baskets)) return;
                const compared = baskets.find((b: any) => b.status === 'compared');
                setLatestCompared(
                    compared
                        ? {
                              id: compared.id,
                              name: compared.name,
                              itemCount: compared.itemCount ?? 0,
                              updatedAt: compared.updatedAt,
                          }
                        : null
                );
            } catch {
                setLatestCompared(null);
            }
        })();
    }, [draftBasketId]);

    // Hide the tab bar while browsing a category — gives products more room
    // and makes space for the basket bar that appears when items are added.
    // Also refreshes basket quantities on every focus so that deletions made
    // on the basket screen are reflected here immediately on return.
    useFocusEffect(useCallback(() => { void refreshBasketQuantities(); }, [refreshBasketQuantities]));

    /**
     * Discriminated resolution for "where does this add go?":
     *   - 'draft'   — existing draft basket, no prep needed
     *   - 'revert'  — user picked an existing compared basket from the
     *                 modal; we need to flip it back to draft first
     *   - 'new'     — create a fresh draft via the basketUtils singleton
     *   - 'cancel'  — user dismissed the modal
     *
     * Earlier draft of this function returned `number | 'new' | null`
     * which collapsed 'draft' and 'revert' into the same branch — every
     * add fired an unnecessary PATCH /status and AsyncStorage work,
     * making every tap 1–20s slower than it needed to be.
     */
    type ResolveResult =
        | { kind: 'draft'; id: number }
        | { kind: 'revert'; id: number }
        | { kind: 'new' }
        | { kind: 'cancel' };

    const resolveBasketForAdd = async (): Promise<ResolveResult> => {
        // Always validate against the server. The cached `draftBasketId` in
        // Zustand can drift out of sync — e.g. its basket flipped to
        // `compared` on another screen, or a previous session left a stale
        // id behind. Trusting it without verification was the bug that
        // caused silent adds to a "draft" that no longer existed, with the
        // backend then minting a brand-new draft (idempotent POST).
        //
        // Decision tree (based on server truth, not cached state):
        //   - server has draft   → silent add to it, no modal
        //   - no draft, has compared → modal
        //   - nothing            → silent create new
        let validatedDraftId: number | null = null;
        let compared: ComparedBasketChoice | null = latestCompared;
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/baskets/user/${userId}`);
            const baskets = await res.json();
            if (Array.isArray(baskets)) {
                const draftHit = baskets.find((b: any) => b.status === 'draft');
                const comparedHit = baskets.find((b: any) => b.status === 'compared');
                validatedDraftId = draftHit ? Number(draftHit.id) : null;
                compared = comparedHit
                    ? {
                          id: comparedHit.id,
                          name: comparedHit.name,
                          itemCount: comparedHit.itemCount ?? 0,
                          updatedAt: comparedHit.updatedAt,
                      }
                    : null;
                // Sync local state with reality so subsequent renders are correct.
                if (validatedDraftId !== draftBasketId) setDraftBasketId(validatedDraftId);
                setLatestCompared(compared);
            }
        } catch {
            // Network down — fall back to last-known state.
            validatedDraftId = draftBasketId;
        }

        if (validatedDraftId) return { kind: 'draft', id: validatedDraftId };
        if (!compared) return { kind: 'new' };

        const choice = await new Promise<ComparedChoice>((resolve) => {
            setComparedModal({
                visible: true,
                resolve: (c) => {
                    setComparedModal({ visible: false, resolve: () => {} });
                    resolve(c);
                },
            });
        });
        if (choice === 'use-existing') return { kind: 'revert', id: compared.id };
        if (choice === 'new') return { kind: 'new' };
        return { kind: 'cancel' };
    };

    const commitAdd = async (productId: number, quantity: number) => {
        const target = await resolveBasketForAdd();
        if (target.kind === 'cancel') return { success: false, message: t('catalog.cancelled') };

        if (target.kind === 'revert') {
            // Reusing a compared basket: flip it back to draft first.
            try {
                await fetch(`${API_BASE_URL}/api/baskets/${target.id}/status`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'draft' }),
                });
                await AsyncStorage.removeItem(`basket_results_${target.id}`);
                setDraftBasketId(target.id);
                setLatestCompared(null);
            } catch {
                // Fall through — add will fail with 400 if revert didn't land,
                // and addProductToBasket's catch surfaces a user-visible error.
            }
            return addProductToBasket(productId, target.id, setDraftBasketId, quantity, mode);
        }

        // 'draft' (existing) or 'new' (singleton creates) — both go straight
        // to addProductToBasket with zero pre-work. This is the hot path and
        // must not do extra network hops.
        const existing = target.kind === 'draft' ? target.id : null;
        return addProductToBasket(productId, existing, setDraftBasketId, quantity, mode);
    };

    // Set/remove must hit the basket the cards DISPLAY (session target first) —
    // writing to the draft while a session targets another basket silently
    // edited the wrong basket.
    const commitAddRef = useRef(commitAdd);
    useEffect(() => { commitAddRef.current = commitAdd; }, [commitAdd]);

    // Tap-debounce so a rapid double-tap doesn't push /search twice.
    const lastSearchPushAt = useRef(0);
    const pushSearch = useCallback(() => {
        const now = Date.now();
        if (now - lastSearchPushAt.current < 600) return;
        lastSearchPushAt.current = now;
        router.push({
            pathname: '/catalog/search',
            params: { mode: 'products', source: 'catalog' },
        } as any);
    }, [router]);

    const selectL3 = async (l3Id: number | null) => {
        setSelectedL3(l3Id);
        setLoadingProducts(true);
        try {
            const userId = await getUserId();
            const url = l3Id
                ? `${API_BASE_URL}/api/categories/${l3Id}/products-with-amounts?mode=${mode}&userId=${userId}`
                : `${API_BASE_URL}/api/categories/${categoryId}/all-products-with-amounts?mode=${mode}&userId=${userId}`;
            const res = await fetch(url);
            const data = await res.json();
            const prods: Product[] = Array.isArray(data) ? data : [];
            setProducts(prods);

            if (mode === 'base' && prods.length > 0) {
                const ids = prods.map(p => p.id).join(',');
                const mergeRes = await fetch(
                    `${API_BASE_URL}/api/users/${userId}/product-merge-map?productIds=${ids}`
                );
                setUserMergeMap(mergeRes.ok ? await mergeRes.json() : {});
            } else {
                setUserMergeMap({});
            }
        } finally {
            setLoadingProducts(false);
        }
    };

    // Chip taps: ignore a tap on the chip that's already active — its results
    // are already loaded, so re-fetching would just flash the list for nothing.
    // (The mode-toggle effect below still calls selectL3 directly to force a
    // refresh when the granularity changes.)
    const handleChipSelect = (l3Id: number | null) => {
        if (l3Id === selectedL3) return;
        selectL3(l3Id);
    };

    // When the user flips the detalumas toggle on this screen, re-run the
    // currently-selected L3 fetch so the list reflects the new granularity
    // without a full navigation reset.
    useEffect(() => {
        if (!prefReady) return;
        if (selectedL3 !== null) selectL3(selectedL3);
        // The first (initial) fetch already reacts to `mode` in the earlier
        // effect; this hook covers the post-initial-render case where a user
        // has drilled into an L3 and THEN changes mode.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    // Build reverse map: keepId → [hideIds] so we can sum quantities correctly.
    const mergedIntoMe = useMemo(() => {
        const m: Record<number, number[]> = {};
        for (const [hideIdStr, keepId] of Object.entries(userMergeMap)) {
            const hideId = Number(hideIdStr);
            if (!m[keepId]) m[keepId] = [];
            m[keepId].push(hideId);
        }
        return m;
    }, [userMergeMap]);

    const visibleProducts = useMemo(
        () => products.filter(p => !(p.id in userMergeMap)),
        [products, userMergeMap]
    );

    // 2-up rows for the SectionList (no numColumns) — pair up the products.
    const productRows = useMemo(() => {
        const out: Product[][] = [];
        for (let i = 0; i < visibleProducts.length; i += 2) out.push(visibleProducts.slice(i, i + 2));
        return out;
    }, [visibleProducts]);

    const productById = useMemo(() => {
        const m = new Map<number, Product>();
        for (const p of products) m.set(p.id, p);
        return m;
    }, [products]);

    // Chain logos for a kept row = union of its own chains + the chains of the
    // products the user personally merged into it — so a merged "Bananai" shows
    // both Maxima + Rimi in the list, matching what the detail screen unions.
    const mergedChainLogos = useCallback((product: Product) => {
        const hideIds = mergedIntoMe[product.id];
        if (!hideIds || hideIds.length === 0) return product.chainLogos;
        const parse = (cl: Product['chainLogos']): { chainId: number; logoUrl: string | null }[] => {
            if (!cl) return [];
            if (typeof cl === 'string') { try { return JSON.parse(cl) || []; } catch { return []; } }
            return cl;
        };
        const byChain = new Map<number, { chainId: number; logoUrl: string | null }>();
        for (const cl of parse(product.chainLogos)) byChain.set(cl.chainId, cl);
        for (const hid of hideIds) {
            const hp = productById.get(hid);
            if (hp) for (const cl of parse(hp.chainLogos)) if (!byChain.has(cl.chainId)) byChain.set(cl.chainId, cl);
        }
        return Array.from(byChain.values());
    }, [mergedIntoMe, productById]);

    const onNavigate = useCallback((id: number) => {
        router.push(`/catalog/product/${id}` as any);
    }, [router]);

    const templateItems = useTemplateAddState(s => s.items);
    const templateAdd = useTemplateAddState(s => s.add);
    const templateSetQty = useTemplateAddState(s => s.setQuantity);
    /** productId → in-template entry (for the current template only). */
    const templateMap = useMemo(() => {
        const m: Record<number, { quantity: number }> = {};
        if (!isTemplateMode) return m;
        for (const it of templateItems) m[it.productId] = { quantity: it.quantity };
        return m;
    }, [templateItems, isTemplateMode]);

    const commitTemplateAdd = useCallback(async (productId: number, quantity: number) => {
        if (!isTemplateMode || templateId == null) return;
        setAddingIds(prev => { const n = new Set(prev); n.add(productId); return n; });
        try {
            await templateAdd(productId, quantity);
            toastRef.current?.show(t('basketTab.templates.addedToTemplateToast'));
        } catch {
            // Silent: the template editor will reload on focus and pick up
            // whatever did land. Aggressive error UI here would surprise
            // users mid-shop.
        } finally {
            setAddingIds(prev => { const n = new Set(prev); n.delete(productId); return n; });
        }
    }, [isTemplateMode, templateId, templateAdd, t]);

    // Fresh add (non-picker path; the picker — when the item is weighable/range
    // — is owned by AddOrStepper and also lands here via onCommit). Optimistic.
    // Single commit for AddOrStepper: add / set / remove (or the template store).
    // The basket side is ONE call into the shared quantities store — optimistic,
    // coalesced, and immune to a slow refresh landing on top of it.
    const commitCardQty = useCallback((productId: number, currentQty: number, qty: number) => {
        if (isTemplateMode) {
            if (qty <= 0) { templateSetQty(productId, 0).catch(() => {}); return; }
            if (currentQty === 0) { commitTemplateAdd(productId, qty); return; }
            templateSetQty(productId, qty).catch(() => {});
            return;
        }
        // The screen's own add resolves a COMPARED basket first (use it / start
        // new); steps skip it and go straight to the by-product write.
        commitBasketQty(productId, currentQty, qty, commitAddRef.current);
    }, [isTemplateMode, templateSetQty, commitTemplateAdd, commitBasketQty]);

    const renderCard = useCallback(({ item }: { item: Product }) => {
        // Size-line dimension comes from the listing's `unit` ('ml' when the
        // product's SPs are volume) — canonicalUnit alone misses single-pack
        // liquids reclassified to 'vnt' (they'd print "1 kg" for a 1 l pack).
        const isVolume = item.unit === 'ml' || item.canonicalUnit === 'l';
        const bigUnit = isVolume ? 'l' : 'kg';
        const smallUnit = isVolume ? 'ml' : 'g';
        const fmt = (v: number) => v >= 1000 ? `${v / 1000} ${bigUnit}` : `${v} ${smallUnit}`;
        const amountText = item.minAmount != null && item.maxAmount != null
            ? (() => { const mn = Number(item.minAmount); const mx = Number(item.maxAmount); return mn === mx ? fmt(mn) : `${fmt(mn)} - ${fmt(mx)}`; })()
            : '';
        // In template mode the card's quantity reflects the in-template
        // amount (so already-added products render the stepper instead of
        // the "Į šabloną" CTA). +/− operate on the template, not a basket.
        const templateQty = isTemplateMode ? (templateMap[item.id]?.quantity ?? 0) : 0;
        return (
            <ConnectedProductCard
                name={item.name}
                imageUrls={item.imageUrls}
                chainLogos={mergedChainLogos(item)}
                badge={item.badge}
                amountText={amountText}
                product={item}
                isTemplateMode={isTemplateMode}
                templateQuantity={templateQty}
                mergedProductIds={mergedIntoMe[item.id]}
                // Basket adds are optimistic (the card flips on tap); only a
                // template add still waits on the server, so only it spins.
                isAdding={isTemplateMode && addingIds.has(item.id)}
                addLabel={isTemplateMode ? t('basketTab.templates.addToTemplate') : undefined}
                onOpen={() => onNavigate(item.id)}
                onCommit={commitCardQty}
            />
        );
    }, [mergedIntoMe, addingIds, onNavigate, commitCardQty, mergedChainLogos, isTemplateMode, templateMap, t]);

    if (loading) return (
        <>
        {/* Same static chrome as the loaded screen (no native bar, no banner
            backgrounds): floating back chip + a transparent chips-skeleton row
            pinned under it; title + card skeletons on the page. */}
        <CollapsingHeader controller={header} back smallTitle={decodeURIComponent((name as string) || '')} />
        <View style={[styles.container, { paddingTop: 0 }]}>
            <ScreenHeading title={decodeURIComponent((name as string) || '')} />
            <View style={{ padding: 12 }}>
                {Array.from({ length: 3 }).map((_, row) => (
                    <View key={row} style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
                        {[0, 1].map(col => (
                            <View key={col} style={{ flex: 1, backgroundColor: colors.cardBackground, borderRadius: radius.lg, padding: 12, alignItems: 'center', gap: 8 }}>
                                <SkeletonBox height={130} borderRadius={radius.md} />
                                <SkeletonBox width={100} height={13} borderRadius={6} />
                                <SkeletonBox width={60} height={11} borderRadius={5} />
                                <SkeletonBox height={34} borderRadius={radius.pill} />
                            </View>
                        ))}
                    </View>
                ))}
            </View>
        </View>
        </>
    );

    return (
        <>
            {/* Static chrome + pinned L3 filter; the category TITLE is list
                content (scrolls natively with the items). */}
            <CollapsingHeader
                controller={header}
                back
                smallTitle={decodeURIComponent(name || '')}
                right={<GlassIconButton icon="search" onPress={pushSearch} />}
            />
            <View style={{ flex: 1 }}>
            <View style={styles.container}>
                <View style={{ flex: 1 }}>
                    {loadingProducts ? (
                        <View style={{ padding: 12, paddingTop: 0 }}>
                            <ScreenHeading title={decodeURIComponent(name || '')} bleedX={12} />
                            {Array.from({ length: 3 }).map((_, row) => (
                                <View key={row} style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
                                    {[0, 1].map(col => (
                                        <View key={col} style={{ flex: 1, backgroundColor: colors.cardBackground, borderRadius: radius.lg, padding: 12, alignItems: 'center', gap: 8 }}>
                                            <SkeletonBox height={130} borderRadius={radius.md} style={{ alignSelf: 'stretch' }} />
                                            <SkeletonBox width={100} height={13} borderRadius={6} />
                                            <SkeletonBox width={60} height={11} borderRadius={5} />
                                            <SkeletonBox height={34} borderRadius={radius.pill} style={{ alignSelf: 'stretch' }} />
                                        </View>
                                    ))}
                                </View>
                            ))}
                        </View>
                    ) : (
                        <>
                        {/* ALWAYS-PINNED chips (real chrome, not a sticky section
                            header): Fabric mis-hit-tests transformed sticky headers —
                            touches on the stuck chips fell through to the list, so
                            horizontal chip scrolling died after any vertical scroll.
                            onPinnedLayout: report the row's height so the header's
                            dissolve strip lands BELOW it — without this pinnedHeight
                            stays 0 and the strip washes the chips' top edge. */}
                        <View onLayout={header.onPinnedLayout} style={{ backgroundColor: colors.pageBackground, zIndex: 1 }}>
                            <CategoryBubbles
                                categories={l3Categories}
                                selectedId={selectedL3}
                                onSelect={handleChipSelect}
                                allLabel={t('catalog.allProducts')}
                            />
                        </View>
                        <AnimatedSectionList
                            {...header.scroll}
                            keyboardShouldPersistTaps="handled"
                            keyboardDismissMode="on-drag"
                            sections={[{ data: productRows }]}
                            // Key rows by their PRODUCT IDS: with index keys every
                            // L3-filter change reshuffled content under stable keys
                            // and force-rebound every mounted image cell.
                            keyExtractor={(row) => 'r-' + row.map(p => p.id).join('-')}
                            contentContainerStyle={{ paddingTop: 0, paddingBottom: barClearance }}
                            ListHeaderComponent={
                                <ScreenHeading title={decodeURIComponent(name || '')} onLayout={header.onTitleLayout} />
                            }
                            ListEmptyComponent={
                                loadFailed ? (
                                    <View style={styles.loadFailWrap}>
                                        <Ionicons name="cloud-offline-outline" size={40} color={colors.textMuted} />
                                        <Text style={styles.emptyText}>{t('catalog.loadFailed')}</Text>
                                        <TouchableOpacity
                                            style={styles.loadFailBtn}
                                            onPress={() => setReloadKey(k => k + 1)}
                                            activeOpacity={0.85}
                                        >
                                            <Text style={styles.loadFailBtnText}>{t('discounts.retry')}</Text>
                                        </TouchableOpacity>
                                    </View>
                                ) : (
                                    <Text style={styles.emptyText}>{t('catalog.noProducts')}</Text>
                                )
                            }
                            renderItem={({ item: pair }) => (
                                <View style={styles.row}>
                                    {pair.map(p => (
                                        <Fragment key={p.id}>{renderCard({ item: p })}</Fragment>
                                    ))}
                                </View>
                            )}
                        />
                        </>
                    )}
                </View>
            </View>
            {/* Legacy per-screen basket bar removed — the universal root-level
                BasketListSheet is the single "collecting items" indicator now. */}
            </View>
            <ComparedBasketChoiceModal
                visible={comparedModal.visible}
                compared={latestCompared}
                onUseExisting={() => comparedModal.resolve('use-existing')}
                onCreateNew={() => comparedModal.resolve('new')}
                onCancel={() => comparedModal.resolve('cancel')}
            />
            <Toast ref={toastRef} />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    bubblesRow: {
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
        flexGrow: 0,
        flexShrink: 0,
    },
    bubblesContainer: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 8,
    },
    bubble: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.cardBackground,
    },
    bubbleActive: {
        backgroundColor: c.primary,
        borderColor: c.primary,
        ...elevation.level1,
    },
    bubbleText: {
        fontSize: 13,
        color: c.textPrimary,
    },
    bubbleTextActive: {
        color: c.onPrimary,
        fontWeight: '600',
    },
    list: {
        padding: 12,
    },
    row: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 12,
        paddingHorizontal: 12,
    },
    loadFailWrap: { alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 40 },
    loadFailBtn: {
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingHorizontal: 22, paddingVertical: 11, minWidth: 140, alignItems: 'center',
    },
    loadFailBtnText: { color: c.onPrimary, fontSize: 15, fontWeight: '700' },
    emptyText: { textAlign: 'center', padding: 32, fontSize: 15, color: c.textSecondary },
    productRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: c.cardBackground,
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
    },
    productIcon: {
        width: 36, height: 36, borderRadius: radius.md,
        backgroundColor: c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    basketBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 12,
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        ...elevation.level3,
        gap: 12,
    },
    basketBarLeft: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    basketBarCount: {
        fontSize: 14,
        fontWeight: '600',
        color: c.primary,
    },
    basketBarButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: c.primary,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: radius.pill,
    },
    basketBarButtonText: {
        fontSize: 14,
        fontWeight: '700',
        color: c.onPrimary,
    },
});