import {
    View, FlatList, ScrollView, TouchableOpacity, Text, TextInput,
    StyleSheet, ActivityIndicator, RefreshControl, Keyboard, Modal, Pressable
} from 'react-native';
import { useEffect, useMemo, useState, useCallback, useRef, memo } from 'react';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { GlassIconButton } from '../components/GlassIconButton';
import { ScreenHeading } from '../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../components/CollapsingHeader';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../config/api';
import { useBasketState } from '../state/basketState';
import { addProductToBasket } from '../utils/basketUtils';
import { resolveCanonicalStep } from '../utils/canonicalStep';
import { ProductImage } from '../components/ProductImage';
import { useTheme, radius, elevation, type AppTheme } from '../constants/theme';
import { getUserId } from '../config/user';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ComparedBasketChoiceModal, { type ComparedBasketChoice } from '../components/ComparedBasketChoiceModal';
import AmountPickerModal from '../components/AmountPickerModal';
import { Toast, type ToastHandle } from '../components/Toast';
import { ScalePressable } from '../components/ScalePressable';
import { SkeletonBox } from '../components/SkeletonBox';
import { ChainLogoStrip } from '../components/ChainLogoStrip';
import { ChainLogoChip } from '../components/ChainLogoChip';
import { FilterDropdownModal, type FilterOption } from '../components/FilterDropdownModal';
import { categoryIcon } from '../constants/categoryIcons';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { fetchWithTimeout, TIMEOUT_HEAVY_MS } from '../utils/fetchWithTimeout';
import { fuzzyMatches } from '../utils/fuzzyMatch';
import { TemplateReturnBanner } from '../components/template/TemplateReturnBanner';
import { useTemplateAddState } from '../state/templateAddState';

interface L2Category {
    id: number;
    name: string;
    parentCategoryId: number;
    l1Id: number;
    l1Name: string;
    /** Canonical Lithuanian L1 name — stable emoji-lookup key across UI locales. */
    l1NameKey?: string;
}

interface DiscountedProduct {
    id: number;
    name: string;
    categoryId: number;
    l2CategoryId: number | null;
    imageUrls?: (string | null | undefined)[] | string | null;
    chainLogos?: { chainId: number; logoUrl: string | null }[] | string | null;
    minAmount: number | null;
    maxAmount: number | null;
    unit: string | null;
    hasWeighable: boolean;
    bestDiscountPct: number;
    /** Cross-store real discount (badge v2): cheapest chain's unit price vs the
     *  market average. NULL → single-store / unit-incomparable → 🔥 + bestDiscountPct. */
    realDiscountPct?: number | null;
    cheapestChainId?: number | null;
    /** Canonical-unit fields populated server-side (productCanonical.ts). */
    canonicalUnit: string | null;
    canonicalStep: number | null;
    canonicalFamily: 'fluid' | 'count' | null;
}

interface CardCallbacks {
    onNavigate: (id: number) => void;
    onAdd: (item: DiscountedProduct) => void;
    onDecrement: (item: DiscountedProduct, qty: number) => void;
    onIncrement: (item: DiscountedProduct, qty: number) => void;
}

const CHAIN_NAME_BY_ID: Record<number, string> = { 1: 'Maxima', 2: 'Rimi', 3: 'Iki', 4: 'Norfa', 5: 'Lidl' };

/** chainLogos can arrive as an array, or a single/double-encoded JSON string
 *  from MariaDB — always normalise to an array before reading chainId. */
function parseChainLogos(raw: DiscountedProduct['chainLogos']): { chainId: number; logoUrl: string | null }[] {
    if (!raw) return [];
    let v: unknown = raw;
    for (let i = 0; i < 2 && typeof v === 'string'; i++) {
        try { v = JSON.parse(v); } catch { return []; }
    }
    return Array.isArray(v) ? (v as { chainId: number; logoUrl: string | null }[]) : [];
}

/** A dropdown-trigger pill (store / category / subcategory) with a ▾ caret. */
const FilterChip = memo(({ label, active, onPress, styles, colors }: {
    label: string;
    active: boolean;
    onPress: () => void;
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
}) => (
    <TouchableOpacity
        style={[styles.bubble, styles.filterChip, active && styles.bubbleActive]}
        onPress={onPress}
        activeOpacity={0.7}
    >
        <Text style={[styles.bubbleText, active && styles.bubbleTextActive]} numberOfLines={1}>{label}</Text>
        <Ionicons name="chevron-down" size={14} color={active ? colors.onPrimary : colors.textSecondary} />
    </TouchableOpacity>
));
FilterChip.displayName = 'FilterChip';

const DiscountProductCard = memo(({
    item, quantity, isAdding, styles, colors, addLabel,
    onNavigate, onAdd, onDecrement, onIncrement,
}: CardCallbacks & {
    item: DiscountedProduct;
    quantity: number;
    isAdding: boolean;
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
    /** Overrides "Į krepšelį" copy — template-add flow uses "Į šabloną". */
    addLabel?: string;
}) => {
    const { t } = useTranslation();
    // minAmount/maxAmount are server-normalised into grams (g/ml as 1000-base).
    // Re-label as l/ml for fluid Products whose canonical unit is l, since
    // kg ≈ l in the canonical-unit transitional simplification — same
    // numeric value, different label.
    const bigUnit = item.canonicalUnit === 'l' ? 'l' : 'kg';
    const smallUnit = item.canonicalUnit === 'l' ? 'ml' : 'g';
    const fmt = (v: number) => v >= 1000 ? `${v / 1000} ${bigUnit}` : `${v} ${smallUnit}`;
    const amountText = item.minAmount != null && item.maxAmount != null
        ? (() => { const min = Number(item.minAmount); const max = Number(item.maxAmount); return min === max ? fmt(min) : `${fmt(min)} - ${fmt(max)}`; })()
        : '';
    return (
        <View style={styles.productCard}>
            <TouchableOpacity onPress={() => onNavigate(item.id)} style={styles.productImageContainer} activeOpacity={0.7}>
                <ProductImage uris={item.imageUrls} imageStyle={styles.productImage} placeholderStyle={styles.productImagePlaceholder} emojiStyle={styles.productImageEmoji} />
                <ChainLogoStrip chainLogos={item.chainLogos} style={{ position: 'absolute', top: 6, left: 6 }} />
                <View style={styles.discountBadge}>
                    {item.realDiscountPct != null && item.cheapestChainId != null ? (
                        // Cross-store real discount: the cheapest chain's logo replaces the
                        // fire — "cheapest HERE, X% below the market average".
                        <View style={styles.discountBadgeInner}>
                            <ChainLogoChip chainId={item.cheapestChainId} size={16} />
                            <Text style={styles.discountBadgeText}>-{item.realDiscountPct}%</Text>
                        </View>
                    ) : (
                        <Text style={styles.discountBadgeText}>🔥 -{item.bestDiscountPct}%</Text>
                    )}
                </View>
            </TouchableOpacity>
            <View style={styles.productInfo}>
                <Text style={styles.productName} numberOfLines={3}>{item.name}</Text>
                <Text style={styles.amountText}>{amountText}</Text>
            </View>
            {quantity === 0 ? (
                <ScalePressable style={[styles.addButton, isAdding && { opacity: 0.5 }]} disabled={isAdding} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onAdd(item); }}>
                    <Text style={styles.addButtonText}>{addLabel ?? t('browse.addToBasket')}</Text>
                </ScalePressable>
            ) : (
                <View style={styles.quantityControl}>
                    <TouchableOpacity style={styles.qtyButton} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onDecrement(item, quantity); }}>
                        <Ionicons name="remove" size={16} color={colors.primary} />
                    </TouchableOpacity>
                    <Text style={styles.qtyText}>{Number.isInteger(quantity) ? quantity : quantity.toFixed(1)}</Text>
                    <TouchableOpacity style={styles.qtyButton} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onIncrement(item, quantity); }}>
                        <Ionicons name="add" size={16} color={colors.primary} />
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
});
DiscountProductCard.displayName = 'DiscountProductCard';

export default function DiscountsScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();
    // Collapsing header: "Nuolaidos" title hides on scroll, L2 filter stays pinned.
    const header = useCollapsingHeader();
    const router = useRouter();
    const { templateId: rawTemplateId } = useLocalSearchParams<{ templateId?: string }>();
    const templateId = rawTemplateId != null && rawTemplateId.length > 0 ? Number(rawTemplateId) : null;
    const isTemplateMode = templateId != null && Number.isFinite(templateId);
    const templateItems = useTemplateAddState(s => s.items);
    const templateAddFn = useTemplateAddState(s => s.add);
    const templateSetQty = useTemplateAddState(s => s.setQuantity);
    const templateMap = useMemo(() => {
        const m: Record<number, { quantity: number }> = {};
        if (!isTemplateMode) return m;
        for (const it of templateItems) m[it.productId] = { quantity: it.quantity };
        return m;
    }, [templateItems, isTemplateMode]);

    const [selectedL2, setSelectedL2] = useState<number | null>(null);
    const [selectedL1, setSelectedL1] = useState<number | null>(null);
    /** null = all stores (the default); a Set is the explicit checked subset. */
    const [selectedChainIds, setSelectedChainIds] = useState<Set<number> | null>(null);
    const [openFilter, setOpenFilter] = useState<null | 'store' | 'l1' | 'l2'>(null);
    const [anchorY, setAnchorY] = useState(0);
    const filterRowRef = useRef<View>(null);
    const [search, setSearch] = useState('');
    /** When true the nav-bar title flips to a TextInput that filters the
     *  in-screen list (no navigation). Mirrors the template editor's
     *  inline-edit pattern; chosen over pushing /search to keep React
     *  Query's cached data and freshness indicator on screen. */
    const [searchOpen, setSearchOpen] = useState(false);
    const searchInputRef = useRef<TextInput>(null);
    const [addingIds, setAddingIds] = useState<Set<number>>(() => new Set());
    const [infoOpen, setInfoOpen] = useState(false);
    const toastRef = useRef<ToastHandle>(null);

    // L2 categories — small, never changes during a session. Cached
    // alongside the discounts payload so the bubble row paints from
    // disk on cold start.
    const { data: l2Categories = [] } = useQuery<L2Category[]>({
        queryKey: ['l2-categories'],
        queryFn: async () => {
            const res = await fetchWithTimeout(`${API_BASE_URL}/api/categories/l2`);
            const data = await res.json();
            return Array.isArray(data) ? data : [];
        },
        staleTime: 24 * 60 * 60 * 1000,
    });

    // Discounts — React Query handles stale-while-revalidate, persistence
    // (via PersistQueryClientProvider in _layout.tsx), retry/backoff, and
    // request dedup. ETag/304 wiring is server-side only for now; client
    // doesn't read or echo back If-None-Match yet.
    const {
        data: allProducts = [],
        isLoading,
        isFetching,
        isError,
        refetch,
    } = useQuery<DiscountedProduct[]>({
        queryKey: ['discounts'],
        queryFn: async () => {
            const res = await fetchWithTimeout(
                `${API_BASE_URL}/api/products/discounted`,
                { timeoutMs: TIMEOUT_HEAVY_MS },
            );
            const data = await res.json();
            return Array.isArray(data) ? data : [];
        },
        staleTime: 30 * 60 * 1000,
    });
    const refreshing = isFetching && !isLoading;

    const activeL2Ids = useMemo(
        () => new Set(allProducts.map(p => p.l2CategoryId).filter(id => id != null)),
        [allProducts],
    );

    // The /api/categories/l2 payload already carries l1Id/l1Name per row, so the
    // L1 "Kategorijos" list, the per-L1 "Subkategorijos" list, and the l2->l1
    // lookup all derive from it — no extra endpoint.
    const l2ToL1 = useMemo(() => {
        const m = new Map<number, number>();
        for (const c of l2Categories) m.set(c.id, c.l1Id);
        return m;
    }, [l2Categories]);

    const activeL1Ids = useMemo(() => {
        const s = new Set<number>();
        for (const c of l2Categories) if (activeL2Ids.has(c.id)) s.add(c.l1Id);
        return s;
    }, [l2Categories, activeL2Ids]);

    const l1Options = useMemo<FilterOption[]>(() => {
        const seen = new Map<number, { label: string; icon: string }>();
        for (const c of l2Categories) {
            if (activeL1Ids.has(c.l1Id) && !seen.has(c.l1Id)) {
                // Same emoji + lookup rule as Naršyti's category list (shared map).
                seen.set(c.l1Id, { label: c.l1Name, icon: categoryIcon(c.l1NameKey, c.l1Name) });
            }
        }
        return [...seen.entries()].map(([id, { label, icon }]) => ({
            id, label,
            leading: <Text style={{ fontSize: 18 }}>{icon}</Text>,
        }));
    }, [l2Categories, activeL1Ids]);

    const l2Options = useMemo<FilterOption[]>(() => {
        if (selectedL1 == null) return [];
        return l2Categories
            .filter(c => c.l1Id === selectedL1 && activeL2Ids.has(c.id))
            .map(c => ({ id: c.id, label: c.name }));
    }, [l2Categories, selectedL1, activeL2Ids]);

    // STORE filter: a discount item has no scalar chainId — its stores live in
    // chainLogos[] (a product can be in several). Derive the selectable chains
    // from the union present in the loaded discounts.
    const availableChainIds = useMemo(() => {
        const set = new Set<number>();
        for (const p of allProducts) {
            for (const cl of parseChainLogos(p.chainLogos)) {
                if (cl && typeof cl.chainId === 'number') set.add(cl.chainId);
            }
        }
        return [...set].sort((a, b) => a - b);
    }, [allProducts]);

    const storeOptions = useMemo<FilterOption[]>(
        () => availableChainIds.map(id => ({
            id,
            label: CHAIN_NAME_BY_ID[id] ?? `#${id}`,
            leading: <ChainLogoChip chainId={id} size={24} />,
        })),
        [availableChainIds],
    );

    const allStoresSelected = !selectedChainIds || selectedChainIds.size >= availableChainIds.length;
    // "All stores" is a STATE, not "everything checked": while it is active the store
    // checkboxes render unchecked — they mean explicit narrowing. One tap on any store
    // then selects JUST that store (see toggleChain) instead of excluding it from all.
    const isChainChecked = useCallback(
        (id: number) => selectedChainIds != null && selectedChainIds.has(id),
        [selectedChainIds],
    );

    // First logoUrl seen per chain, so the store chip can render the selected
    // chains' logos (same ChainLogoStrip rules as the product cards).
    const chainLogoUrlById = useMemo(() => {
        const m = new Map<number, string | null>();
        for (const p of allProducts) {
            for (const cl of parseChainLogos(p.chainLogos)) {
                if (cl && typeof cl.chainId === 'number' && !m.has(cl.chainId)) m.set(cl.chainId, cl.logoUrl ?? null);
            }
        }
        return m;
    }, [allProducts]);

    const selectedStoreLogos = useMemo(() => {
        if (allStoresSelected) return [];
        const ids = (selectedChainIds ? [...selectedChainIds] : availableChainIds).slice().sort((a, b) => a - b);
        return ids.map(id => ({ chainId: id, logoUrl: chainLogoUrlById.get(id) ?? null }));
    }, [allStoresSelected, selectedChainIds, availableChainIds, chainLogoUrlById]);

    useEffect(() => {
        if (selectedL2 != null && !activeL2Ids.has(selectedL2)) setSelectedL2(null);
    }, [activeL2Ids, selectedL2]);

    // If the chosen L1 vanishes from the loaded discounts, drop it (and its L2).
    useEffect(() => {
        if (selectedL1 != null && !activeL1Ids.has(selectedL1)) { setSelectedL1(null); setSelectedL2(null); }
    }, [activeL1Ids, selectedL1]);

    const products = useMemo(() => {
        let list = allProducts;
        // STORE: keep items offered by at least one checked chain. Skipped when
        // all chains are selected (default) so items survive even if their
        // chainLogos is empty/unparseable.
        if (selectedChainIds && selectedChainIds.size < availableChainIds.length) {
            list = list.filter(p => parseChainLogos(p.chainLogos).some(cl => selectedChainIds.has(cl.chainId)));
        }
        // L1 category, derived per item via l2CategoryId -> l1Id.
        if (selectedL1 != null) {
            list = list.filter(p => p.l2CategoryId != null && l2ToL1.get(p.l2CategoryId) === selectedL1);
        }
        // L2 subcategory.
        if (selectedL2 != null) list = list.filter(p => p.l2CategoryId === selectedL2);
        const trimmed = search.trim();
        if (trimmed) {
            // Diacritic-fold + token-AND + per-token Levenshtein so
            // "zvake" hits "žvakė", "kapu zvake" finds "Kapų raudona
            // žvakė" (missed middle word), and small typos like "zkae"
            // still resolve. Cost stays sub-ms per row for typical
            // product names.
            list = list.filter((p) => fuzzyMatches(p.name, trimmed));
        }
        return list;
    }, [allProducts, selectedChainIds, availableChainIds, selectedL1, selectedL2, l2ToL1, search]);

    const toggleChain = useCallback((id: number) => {
        setSelectedChainIds(prev => {
            // From "All stores": the first tap selects ONLY the tapped store — the
            // one-tap narrowing start (never "all minus one").
            if (prev == null) return new Set([id]);
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            // Auto-collapse both edges back to "All stores": an empty selection would
            // show zero products, and a full selection IS all stores.
            if (next.size === 0 || next.size >= availableChainIds.length) return null;
            return next;
        });
    }, [availableChainIds]);

    const selectAllStores = useCallback(() => setSelectedChainIds(null), []);

    const selectL1 = useCallback((id: number | null) => {
        setSelectedL1(id);
        setSelectedL2(null); // changing the L1 resets the subcategory to "Visi"
    }, []);

    const openDropdown = useCallback((which: 'store' | 'l1' | 'l2') => {
        const node = filterRowRef.current;
        if (node?.measureInWindow) {
            node.measureInWindow((_x, y, _w, h) => { setAnchorY((y || 0) + (h || 0)); setOpenFilter(which); });
        } else {
            setOpenFilter(which);
        }
    }, []);

    const l1Label = selectedL1 != null
        ? (() => {
            const label = l1Options.find(o => o.id === selectedL1)?.label;
            if (!label) return t('discounts.filterCategories');
            // Same emoji as the dropdown option (and Naršyti) — carried into the chip.
            const c = l2Categories.find(c => c.l1Id === selectedL1);
            return `${categoryIcon(c?.l1NameKey, c?.l1Name)} ${label}`;
        })()
        : t('discounts.filterCategories');
    const l2Label = selectedL2 != null
        ? (l2Options.find(o => o.id === selectedL2)?.label ?? t('discounts.filterSubcategories'))
        : t('discounts.filterSubcategories');
    const hasFilters = storeOptions.length > 1 || l1Options.length > 0;

    const { draftBasketId, setDraftBasketId, sessionBasketId, clearSessionBasket } = useBasketState();
    const [basketQuantities, setBasketQuantities] = useState<Record<number, number>>({});
    const [basketItemCount, setBasketItemCount] = useState(0);
    const [latestCompared, setLatestCompared] = useState<ComparedBasketChoice | null>(null);
    type ComparedChoice = 'use-existing' | 'new' | 'cancel';
    const [comparedModal, setComparedModal] = useState<{
        visible: boolean;
        resolve: (c: ComparedChoice) => void;
    }>({ visible: false, resolve: () => {} });
    const [amountModal, setAmountModal] = useState<{
        visible: boolean;
        product: DiscountedProduct | null;
    }>({ visible: false, product: null });

    // Stale `discounts_cache_v2` data lived in AsyncStorage from before the
    // React Query rollout. Drop it once so the old bytes don't sit forever
    // on devices that have upgraded.
    useEffect(() => {
        AsyncStorage.removeItem('discounts_cache_v2').catch(() => {});
    }, []);

    useFocusEffect(useCallback(() => {
        const loadBasket = async () => {
            if (!draftBasketId) await useBasketState.getState().initDraftBasket();
            const { draftBasketId: draft, sessionBasketId: session } = useBasketState.getState();
            const bid = session;
            if (!bid) {
                setBasketItemCount(0);
                setBasketQuantities({});
                return;
            }
            try {
                const res = await fetch(`${API_BASE_URL}/api/baskets/${bid}/items`);
                const items = await res.json();
                if (Array.isArray(items)) {
                    if (draft === bid) {
                        const q: Record<number, number> = {};
                        items.forEach((i: any) => { q[i.productId] = parseFloat(i.quantity); });
                        setBasketQuantities(q);
                    }
                    setBasketItemCount(items.filter((i: any) => parseFloat(i.quantity) > 0).length);
                }
            } catch {}
        };
        loadBasket();
    }, [draftBasketId]));

    useEffect(() => {
        if (draftBasketId) { setLatestCompared(null); return; }
        (async () => {
            try {
                const userId = await getUserId();
                const res = await fetch(`${API_BASE_URL}/api/baskets/user/${userId}`);
                const baskets = await res.json();
                if (!Array.isArray(baskets)) return;
                const compared = baskets.find((b: any) => b.status === 'compared');
                setLatestCompared(compared ? { id: compared.id, name: compared.name, itemCount: compared.itemCount ?? 0, updatedAt: compared.updatedAt } : null);
            } catch { setLatestCompared(null); }
        })();
    }, [draftBasketId]);

    const resolveBasketForAdd = async () => {
        let validatedDraftId: number | null = null;
        let compared = latestCompared;
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/baskets/user/${userId}`);
            const baskets = await res.json();
            if (Array.isArray(baskets)) {
                const draftHit = baskets.find((b: any) => b.status === 'draft');
                const comparedHit = baskets.find((b: any) => b.status === 'compared');
                validatedDraftId = draftHit ? Number(draftHit.id) : null;
                compared = comparedHit ? { id: comparedHit.id, name: comparedHit.name, itemCount: comparedHit.itemCount ?? 0, updatedAt: comparedHit.updatedAt } : null;
                if (validatedDraftId !== draftBasketId) setDraftBasketId(validatedDraftId);
                setLatestCompared(compared);
            }
        } catch { validatedDraftId = draftBasketId; }

        if (validatedDraftId) return { kind: 'draft' as const, id: validatedDraftId };
        if (!compared) return { kind: 'new' as const };
        const choice = await new Promise<ComparedChoice>(resolve => {
            setComparedModal({ visible: true, resolve: c => { setComparedModal({ visible: false, resolve: () => {} }); resolve(c); } });
        });
        if (choice === 'use-existing') return { kind: 'revert' as const, id: compared!.id };
        if (choice === 'new') return { kind: 'new' as const };
        return { kind: 'cancel' as const };
    };

    const commitAdd = async (productId: number, quantity: number) => {
        const target = await resolveBasketForAdd();
        if (target.kind === 'cancel') return { success: false };
        if (target.kind === 'revert') {
            try {
                await fetch(`${API_BASE_URL}/api/baskets/${target.id}/status`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'draft' }),
                });
                await AsyncStorage.removeItem(`basket_results_${target.id}`);
                setDraftBasketId(target.id);
                setLatestCompared(null);
            } catch {}
            return addProductToBasket(productId, target.id, setDraftBasketId, quantity, 'sku');
        }
        const existing = target.kind === 'draft' ? target.id : null;
        return addProductToBasket(productId, existing, setDraftBasketId, quantity, 'sku');
    };

    const hasBasketItems = Object.values(basketQuantities).some(q => q > 0);

    const draftBasketIdRef = useRef(draftBasketId);
    useEffect(() => { draftBasketIdRef.current = draftBasketId; }, [draftBasketId]);
    const commitAddRef = useRef(commitAdd);
    useEffect(() => { commitAddRef.current = commitAdd; }, [commitAdd]);

    const onNavigate = useCallback((id: number) => {
        router.push(isTemplateMode
            ? `/product/${id}?templateId=${templateId}`
            : `/product/${id}` as any);
    }, [router, isTemplateMode, templateId]);

    const onAdd = useCallback((item: DiscountedProduct) => {
        const hasRange = item.minAmount !== null && item.maxAmount !== null && item.minAmount !== item.maxAmount;
        if (hasRange || item.hasWeighable) { setAmountModal({ visible: true, product: item }); return; }
        const initialQty = resolveCanonicalStep(item);
        if (isTemplateMode) {
            setAddingIds(prev => { const n = new Set(prev); n.add(item.id); return n; });
            templateAddFn(item.id, initialQty)
                .then(() => toastRef.current?.show(t('basketTab.templates.addedToTemplateToast')))
                .catch(() => {})
                .finally(() => {
                    setAddingIds(prev => { const n = new Set(prev); n.delete(item.id); return n; });
                });
            return;
        }
        // First-tap quick-add: send one canonical step as the quantity so
        // server pack-math lands on exactly one pack (1L for a 1L SP, but
        // 0.5L = 1 bottle for a 500ml SP — never half a pack).
        setAddingIds(prev => { const n = new Set(prev); n.add(item.id); return n; });
        commitAddRef.current(item.id, initialQty).then(result => {
            if (result.success) {
                setBasketQuantities(prev => ({ ...prev, [item.id]: initialQty }));
                setBasketItemCount(prev => prev + 1);
                toastRef.current?.show(t('browse.addedToast'));
            }
        }).finally(() => {
            setAddingIds(prev => { const n = new Set(prev); n.delete(item.id); return n; });
        });
    }, [setAmountModal, isTemplateMode, templateAddFn, t]);

    const onDecrement = useCallback((item: DiscountedProduct, qty: number) => {
        const step = resolveCanonicalStep(item);
        const newQty = Math.round((qty - step) / step) * step;
        if (isTemplateMode) {
            const clamped = Math.max(0, newQty);
            templateSetQty(item.id, clamped).catch(() => {});
            return;
        }
        const bid = draftBasketIdRef.current;
        if (newQty <= 0) {
            setBasketQuantities(prev => ({ ...prev, [item.id]: 0 }));
            setBasketItemCount(prev => Math.max(0, prev - 1));
            if (!bid) return;
            fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async allItems => {
                const bi = Array.isArray(allItems) ? allItems.find((i: any) => i.productId === item.id) : null;
                if (bi) await fetch(`${API_BASE_URL}/api/basket-items/${bi.id}`, { method: 'DELETE' });
                const remaining = Array.isArray(allItems) ? allItems.filter((i: any) => i.id !== bi?.id) : [];
                if (remaining.length === 0) { await fetch(`${API_BASE_URL}/api/baskets/${bid}`, { method: 'DELETE' }); clearSessionBasket(); }
            }).catch(() => {});
        } else {
            setBasketQuantities(prev => ({ ...prev, [item.id]: newQty }));
            if (!bid) return;
            fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async items2 => {
                const bi = items2.find((i: any) => i.productId === item.id);
                if (bi) await fetch(`${API_BASE_URL}/api/basket-items/${bi.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: newQty }) });
            }).catch(() => {});
        }
    }, [clearSessionBasket, isTemplateMode, templateSetQty]);

    const onIncrement = useCallback((item: DiscountedProduct, qty: number) => {
        const step = resolveCanonicalStep(item);
        const newQty = Math.round((qty + step) / step) * step;
        if (isTemplateMode) {
            templateSetQty(item.id, newQty).catch(() => {});
            return;
        }
        const bid = draftBasketIdRef.current;
        setBasketQuantities(prev => ({ ...prev, [item.id]: newQty }));
        if (!bid) return;
        fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async items2 => {
            const bi = items2.find((i: any) => i.productId === item.id);
            if (bi) await fetch(`${API_BASE_URL}/api/basket-items/${bi.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: newQty }) });
        }).catch(() => {});
    }, [isTemplateMode, templateSetQty]);

    const renderItem = useCallback(({ item }: { item: DiscountedProduct }) => {
        const quantity = isTemplateMode
            ? (templateMap[item.id]?.quantity ?? 0)
            : (basketQuantities[item.id] ?? 0);
        return (
            <DiscountProductCard
                item={item}
                quantity={quantity}
                isAdding={addingIds.has(item.id)}
                styles={styles}
                colors={colors}
                addLabel={isTemplateMode ? t('basketTab.templates.addToTemplate') : undefined}
                onNavigate={onNavigate}
                onAdd={onAdd}
                onDecrement={onDecrement}
                onIncrement={onIncrement}
            />
        );
    }, [basketQuantities, addingIds, styles, colors, onNavigate, onAdd, onDecrement, onIncrement, isTemplateMode, templateMap, t]);

    const closeSearch = useCallback(() => {
        setSearch('');
        setSearchOpen(false);
    }, []);

    return (
        <>
            {/* "Nuolaidos" collapses on scroll; the L2 filter stays pinned. The
                bar keeps its glass back + search/close buttons; in search mode
                the input is a pinned field in the body (a TextInput in the bar
                title strips the iOS-26 glass off the bar buttons). */}
            <CollapsingHeader
                controller={header}
                background={colors.cardBackground}
                back
                right={searchOpen
                    ? <GlassIconButton icon="close" onPress={closeSearch} />
                    : <GlassIconButton icon="search" onPress={() => setSearchOpen(true)} />}
                collapsing={searchOpen ? null : (
                    <ScreenHeading
                        title={t('discounts.title')}
                        trailing={
                            <TouchableOpacity
                                onPress={() => setInfoOpen(true)}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                accessibilityLabel={t('discounts.infoTitle')}
                            >
                                <Ionicons name="help-circle-outline" size={26} color={colors.textSecondary} />
                            </TouchableOpacity>
                        }
                    />
                )}
                pinned={(searchOpen || hasFilters) ? (
                    <>
                        {searchOpen && (
                            <View style={styles.searchFieldWrap}>
                                <TextInput
                                    ref={searchInputRef}
                                    autoFocus
                                    value={search}
                                    onChangeText={setSearch}
                                    placeholder={t('browse.searchPlaceholder')}
                                    placeholderTextColor={colors.textMuted}
                                    returnKeyType="search"
                                    onSubmitEditing={() => Keyboard.dismiss()}
                                    style={styles.searchField}
                                />
                            </View>
                        )}
                        {hasFilters && (
                            <View ref={filterRowRef} style={styles.bubblesRow}>
                                <ScrollView
                                    horizontal
                                    showsHorizontalScrollIndicator={false}
                                    contentContainerStyle={styles.bubblesContainer}
                                >
                                    {storeOptions.length > 1 && (
                                        (allStoresSelected || selectedStoreLogos.length === 0) ? (
                                            <FilterChip
                                                styles={styles} colors={colors}
                                                label={t('discounts.filterStores')} active={!allStoresSelected}
                                                onPress={() => openDropdown('store')}
                                            />
                                        ) : (
                                            <TouchableOpacity
                                                style={[styles.bubble, styles.filterChip, { borderColor: colors.primary }]}
                                                onPress={() => openDropdown('store')}
                                                activeOpacity={0.7}
                                            >
                                                <ChainLogoStrip chainLogos={selectedStoreLogos} />
                                                <Ionicons name="chevron-down" size={14} color={colors.primary} />
                                            </TouchableOpacity>
                                        )
                                    )}
                                    {l1Options.length > 0 && (
                                        <FilterChip
                                            styles={styles} colors={colors}
                                            label={l1Label} active={selectedL1 != null}
                                            onPress={() => openDropdown('l1')}
                                        />
                                    )}
                                    {selectedL1 != null && l2Options.length > 0 && (
                                        <FilterChip
                                            styles={styles} colors={colors}
                                            label={l2Label} active={selectedL2 != null}
                                            onPress={() => openDropdown('l2')}
                                        />
                                    )}
                                </ScrollView>
                            </View>
                        )}
                    </>
                ) : undefined}
            />
            <View style={{ flex: 1 }}>
                <View style={styles.container}>
                    <View style={{ flex: 1 }}>
                        {isLoading ? (
                            <View style={{ flex: 1, padding: 12, gap: 12, paddingTop: header.paddingTop + 12 }}>
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <View key={i} style={{ flexDirection: 'row', gap: 12 }}>
                                        {[0, 1].map(j => (
                                            <View key={j} style={{ flex: 1, backgroundColor: colors.cardBackground, borderRadius: radius.lg, padding: 12, gap: 8, ...elevation.level2 }}>
                                                <SkeletonBox height={110} borderRadius={radius.md} />
                                                <SkeletonBox height={12} borderRadius={6} />
                                                <SkeletonBox width={80} height={12} borderRadius={6} />
                                                <SkeletonBox height={36} borderRadius={radius.pill} />
                                            </View>
                                        ))}
                                    </View>
                                ))}
                            </View>
                        ) : isError && allProducts.length === 0 ? (
                            <View style={[styles.coldError, { paddingTop: header.paddingTop }]}>
                                <Ionicons name="cloud-offline-outline" size={48} color={colors.textMuted} />
                                <Text style={styles.coldErrorTitle}>{t('discounts.loadFailed')}</Text>
                                <ScalePressable style={styles.coldErrorButton} onPress={() => refetch()}>
                                    <Text style={styles.coldErrorButtonText}>{t('discounts.retry')}</Text>
                                </ScalePressable>
                            </View>
                        ) : (
                            <Animated.FlatList
                                {...header.scroll}
                                data={products}
                                keyExtractor={(item: any) => item.id.toString()}
                                contentContainerStyle={[
                                    styles.list,
                                    // + 12 restores the list's natural top padding (styles.list)
                                    // as a small gap below the pinned filter, matching product.
                                    { paddingTop: header.paddingTop + 12 },
                                    // Reserve space for the absolute "Šablonas"
                                    // banner so the last row's "Į šabloną" CTA
                                    // isn't hidden under it.
                                    isTemplateMode && { paddingBottom: 96 + bottomInset },
                                ]}
                                numColumns={2}
                                columnWrapperStyle={styles.row}
                                keyboardDismissMode="on-drag"
                                ListHeaderComponent={
                                    isError && allProducts.length > 0 ? (
                                        <TouchableOpacity style={styles.errorBanner} onPress={() => refetch()} activeOpacity={0.7}>
                                            <Ionicons name="warning-outline" size={16} color={colors.onPrimary} style={{ marginRight: 6 }} />
                                            <Text style={styles.errorBannerText} numberOfLines={2}>
                                                {t('discounts.loadFailedWithCache')}
                                            </Text>
                                            <Text style={styles.errorBannerRetry}>{t('discounts.retry')}</Text>
                                        </TouchableOpacity>
                                    ) : null
                                }
                                refreshControl={
                                    <RefreshControl
                                        refreshing={refreshing}
                                        onRefresh={() => refetch()}
                                        colors={[colors.primary]}
                                        tintColor={colors.primary}
                                    />
                                }
                                ListEmptyComponent={
                                    <Text style={styles.emptyText}>
                                        {search ? t('browse.noResultsSearch') : t('browse.noResults')}
                                    </Text>
                                }
                                renderItem={renderItem}
                            />
                        )}
                    </View>
                </View>

                {!isTemplateMode && sessionBasketId !== null && basketItemCount > 0 && (
                    <Animated.View
                        entering={FadeInDown.duration(200)}
                        exiting={FadeOutDown.duration(150)}
                        style={[styles.basketBar, { paddingBottom: Math.max(12, bottomInset) }]}
                    >
                        <View style={styles.basketBarLeft}>
                            <Ionicons name="cart" size={20} color={colors.primary} />
                            <Text style={styles.basketBarCount}>
                                {t('items.count', { count: basketItemCount })}
                            </Text>
                        </View>
                        <ScalePressable
                            style={styles.basketBarButton}
                            onPress={() => router.push(`/basket/${sessionBasketId}` as any)}
                        >
                            <Text style={styles.basketBarButtonText}>{t('browse.basketShortcut')}</Text>
                            <Ionicons name="chevron-forward" size={16} color={colors.onPrimary} />
                        </ScalePressable>
                    </Animated.View>
                )}
                {isTemplateMode && templateId != null && (
                    <TemplateReturnBanner templateId={templateId} />
                )}
            </View>

            <ComparedBasketChoiceModal
                visible={comparedModal.visible}
                compared={latestCompared}
                onUseExisting={() => comparedModal.resolve('use-existing')}
                onCreateNew={() => comparedModal.resolve('new')}
                onCancel={() => comparedModal.resolve('cancel')}
            />
            <AmountPickerModal
                visible={amountModal.visible}
                productName={amountModal.product?.name || ''}
                canonicalUnit={amountModal.product?.canonicalUnit ?? null}
                canonicalStep={amountModal.product?.canonicalStep ?? null}
                canonicalFamily={amountModal.product?.canonicalFamily ?? null}
                minAmount={amountModal.product?.minAmount || 0}
                maxAmount={amountModal.product?.maxAmount || 0}
                unit={amountModal.product?.unit || 'g'}
                isWeighable={!!amountModal.product?.hasWeighable}
                onCancel={() => setAmountModal({ visible: false, product: null })}
                onConfirm={async (amount) => {
                    const product = amountModal.product;
                    setAmountModal({ visible: false, product: null });
                    if (!product) return;
                    if (isTemplateMode) {
                        try {
                            if (templateMap[product.id]) {
                                await templateSetQty(product.id, amount);
                            } else {
                                await templateAddFn(product.id, amount);
                                toastRef.current?.show(t('basketTab.templates.addedToTemplateToast'));
                            }
                        } catch {}
                        return;
                    }
                    const result = await commitAdd(product.id, amount);
                    if (result.success) {
                        setBasketQuantities(prev => ({ ...prev, [product.id]: amount }));
                        setBasketItemCount(prev => prev + 1);
                        toastRef.current?.show(t('browse.addedToast'));
                    }
                }}
            />
            <FilterDropdownModal
                visible={openFilter !== null}
                title={openFilter === 'store' ? t('discounts.filterStores') : openFilter === 'l1' ? t('discounts.filterCategories') : t('discounts.filterSubcategories')}
                anchorY={anchorY}
                options={openFilter === 'store' ? storeOptions : openFilter === 'l1' ? l1Options : l2Options}
                onClose={() => setOpenFilter(null)}
                config={openFilter === 'store'
                    ? { mode: 'multi', isChecked: isChainChecked, allChecked: allStoresSelected, allLabel: t('discounts.filterAllStores'), onToggle: toggleChain, onAll: selectAllStores }
                    : openFilter === 'l1'
                    ? { mode: 'single', selectedId: selectedL1, allLabel: t('discounts.filterAllCategories'), onSelect: selectL1 }
                    : { mode: 'single', selectedId: selectedL2, allLabel: t('discounts.filterAllSubcategories'), onSelect: setSelectedL2 }}
            />
            <Modal visible={infoOpen} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setInfoOpen(false)}>
                <Pressable style={styles.infoOverlay} onPress={() => setInfoOpen(false)}>
                    <Pressable style={styles.infoCard} onPress={() => {}}>
                        <Text style={styles.infoTitle}>{t('discounts.infoTitle')}</Text>
                        {([
                            [1, <Text key="i1" style={styles.infoBulletIcon}>🏷️</Text>],
                            [2, <Text key="i2" style={styles.infoBulletIcon}>🔄</Text>],
                            // A miniature of the ACTUAL cross-store badge (pink pill, -30%)
                            // so the reader instantly knows which badge is meant.
                            [3, <View key="i3" style={styles.infoBadgeSample}><Text style={styles.infoBadgeSampleText}>-30%</Text></View>],
                            [4, <Text key="i4" style={styles.infoBulletIcon}>🔥</Text>],
                        ] as const).map(([n, icon]) => (
                            <View key={n} style={styles.infoBulletRow}>
                                <View style={styles.infoBulletLead}>{icon}</View>
                                <Text style={styles.infoBulletText}>{t(`discounts.infoBullet${n}`)}</Text>
                            </View>
                        ))}
                        <ScalePressable style={styles.infoButton} onPress={() => setInfoOpen(false)}>
                            <Text style={styles.infoButtonText}>{t('common.gotIt')}</Text>
                        </ScalePressable>
                    </Pressable>
                </Pressable>
            </Modal>
            <Toast ref={toastRef} />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    loadingText: {
        marginTop: 12,
        fontSize: 14,
        color: c.textMuted,
        textAlign: 'center',
    },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: c.cardBackground,
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 4,
        borderRadius: radius.pill,
        paddingHorizontal: 14,
        paddingVertical: 9,
        gap: 8,
        borderWidth: 1,
        borderColor: c.border,
    },
    searchIcon: { flexShrink: 0 },
    searchInput: {
        flex: 1,
        fontSize: 14,
        color: c.textPrimary,
        padding: 0,
    },
    searchFieldWrap: {
        backgroundColor: c.cardBackground,
        paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10,
    },
    searchField: {
        borderWidth: 1, borderColor: c.border, borderRadius: radius.pill,
        paddingHorizontal: 16, paddingVertical: 10,
        fontSize: 16, color: c.textPrimary,
    },
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
    filterChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    infoOverlay: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    infoCard: {
        backgroundColor: c.cardBackground,
        borderRadius: radius.xl,
        padding: 24,
        width: '100%',
        maxWidth: 360,
        ...elevation.level3,
    },
    infoTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: c.textPrimary,
        textAlign: 'center',
        marginBottom: 16,
    },
    infoBulletRow: { flexDirection: 'row', gap: 10, marginBottom: 12, alignItems: 'flex-start' },
    infoBulletLead: { minWidth: 44, alignItems: 'center', paddingTop: 1 },
    infoBulletIcon: { fontSize: 17, lineHeight: 21 },
    infoBadgeSample: {
        backgroundColor: c.primary,
        borderRadius: radius.pill,
        paddingHorizontal: 8,
        paddingVertical: 3,
    },
    infoBadgeSampleText: { color: c.onPrimary, fontSize: 11, fontWeight: '700' },
    infoBulletText: { flex: 1, fontSize: 14, lineHeight: 21, color: c.textPrimary },
    infoButton: {
        marginTop: 8,
        backgroundColor: c.primary,
        borderRadius: radius.pill,
        paddingVertical: 12,
        alignItems: 'center',
    },
    infoButtonText: { color: c.onPrimary, fontSize: 15, fontWeight: '600' },
    list: { padding: 12 },
    row: { gap: 12, marginBottom: 12 },
    productCard: {
        backgroundColor: c.cardBackground,
        borderRadius: radius.lg,
        padding: 12,
        alignItems: 'center',
        ...elevation.level2,
        flex: 1,
        maxWidth: '50%',
    },
    productImageContainer: {
        width: '100%',
        height: 130,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 8,
    },
    productImage: { width: '100%', height: '100%', borderRadius: radius.md },
    productImagePlaceholder: {
        width: '100%', height: '100%',
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.surfaceMuted, borderRadius: radius.md,
    },
    productImageEmoji: { fontSize: 44, opacity: 0.4 },
    discountBadge: {
        position: 'absolute',
        top: 6,
        right: 6,
        backgroundColor: c.primary,
        borderRadius: radius.pill,
        paddingHorizontal: 9,
        paddingVertical: 4,
        ...elevation.level1,
    },
    discountBadgeInner: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    discountBadgeText: {
        fontSize: 12,
        fontWeight: '800',
        color: c.onPrimary,
        letterSpacing: 0.2,
    },
    productInfo: { flex: 1, width: '100%', marginBottom: 10 },
    productName: { fontSize: 13, color: c.textPrimary, lineHeight: 18 },
    amountText: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    addButton: {
        width: '100%',
        backgroundColor: c.primary,
        borderRadius: radius.pill,
        paddingVertical: 10,
        alignItems: 'center',
    },
    addButtonText: { color: c.onPrimary, fontSize: 13, fontWeight: '600' },
    emptyText: { textAlign: 'center', padding: 32, fontSize: 15, color: c.textSecondary },
    freshness: {
        fontSize: 11,
        color: c.textMuted,
        textAlign: 'center',
        paddingTop: 4,
        paddingBottom: 2,
    },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: c.primary,
        marginHorizontal: 16,
        marginTop: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 8,
    },
    errorBannerText: { flex: 1, fontSize: 13, color: c.onPrimary },
    errorBannerRetry: { fontSize: 13, fontWeight: '700', color: c.onPrimary, marginLeft: 8 },
    coldError: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
    },
    coldErrorTitle: { fontSize: 16, color: c.textPrimary, textAlign: 'center' },
    coldErrorButton: {
        backgroundColor: c.primary,
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 10,
        marginTop: 4,
    },
    coldErrorButtonText: { color: c.onPrimary, fontSize: 14, fontWeight: '600' },
    quantityControl: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderWidth: 1,
        borderColor: c.primary,
        borderRadius: radius.pill,
        paddingVertical: 6,
        paddingHorizontal: 10,
    },
    qtyButton: { padding: 2 },
    qtyText: {
        fontSize: 14, fontWeight: '700', color: c.primary,
        minWidth: 20, textAlign: 'center',
    },
    basketBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 12,
        backgroundColor: c.cardBackground,
        borderTopWidth: 1,
        borderTopColor: c.border,
        gap: 12,
    },
    basketBarLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
    basketBarCount: { fontSize: 14, fontWeight: '600', color: c.primary },
    basketBarButton: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: c.primary,
        paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10,
    },
    basketBarButtonText: { fontSize: 14, fontWeight: '700', color: c.onPrimary },
});
