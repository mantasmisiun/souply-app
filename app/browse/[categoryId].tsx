import { View, FlatList, TouchableOpacity, Text, StyleSheet, Switch, Modal } from 'react-native';
import { SkeletonBox } from '../../components/SkeletonBox';
import { useEffect, useMemo, useState, useCallback, useRef, memo } from 'react';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../config/api';
import { useBasketState } from '../../state/basketState';
import { addProductToBasket } from '../../utils/basketUtils';
import AmountPickerModal from '../../components/AmountPickerModal';
import ComparedBasketChoiceModal, { type ComparedBasketChoice } from '../../components/ComparedBasketChoiceModal';
import BasketProductCard from '../../components/browse/BasketProductCard';
import CategoryBubbles from '../../components/browse/CategoryBubbles';
import { TemplateReturnBanner } from '../../components/template/TemplateReturnBanner';
import { useTemplateAddState } from '../../state/templateAddState';
import { useTheme, type AppTheme } from '../../constants/theme';
import { useDisplayMode } from '../../contexts/DisplayPreferenceContext';
import { getUserId } from '../../config/user';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Toast, type ToastHandle } from '../../components/Toast';
import { useTranslation } from 'react-i18next';
import { ScalePressable } from '../../components/ScalePressable';
import { GlassButton } from '../../components/GlassButton';
import { GlassIconButton } from '../../components/GlassIconButton';
import { ScreenBackButton } from '../../components/ScreenBackButton';
import { resolveCanonicalStep } from '../../utils/canonicalStep';

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
}



export default function CategoryScreen() {
    const colors = useTheme();
    const { t, i18n } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();
    const { categoryId, name, templateId: rawTemplateId } =
        useLocalSearchParams<{ categoryId: string; name: string; templateId?: string }>();
    const templateId = rawTemplateId != null && rawTemplateId.length > 0 ? Number(rawTemplateId) : null;
    const isTemplateMode = templateId != null && Number.isFinite(templateId);
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
    const [basketQuantities, setBasketQuantities] = useState<{[productId: number]: number}>({});
    const [basketItemCount, setBasketItemCount] = useState(0);
    // Products whose "Į krepšelį" POST is currently in flight. Prevents
    // rapid double-taps from firing a second add before the first lands
    // and paints the quantity control over the button.
    const [addingIds, setAddingIds] = useState<Set<number>>(() => new Set());
    const toastRef = useRef<ToastHandle>(null);
    const router = useRouter();
    const { mode, setMode, ready: prefReady } = useDisplayMode();
    const [helpOpen, setHelpOpen] = useState(false);
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

    // Pending mode switch: the Switch component optimistically renders the
    // next position the moment the user taps, but we want to confirm with a
    // modal first if the basket already has items (basket calc differs
    // between modes, existing items have to be converted). `pendingMode`
    // holds the proposed target until the user confirms or cancels.
    const [pendingMode, setPendingMode] = useState<'base' | 'sku' | null>(null);
    const [converting, setConverting] = useState(false);
    const [amountModal, setAmountModal] = useState<{
        visible: boolean;
        product: Product | null;
    }>({ visible: false, product: null });
    useEffect(() => {
        // Wait for the display-mode preference to load before firing fetches;
        // otherwise the screen flashes default-mode results before switching.
        if (!prefReady) return;
        const fetchData = async () => {
            setLoading(true);
            try {
                const userId = await getUserId();
                const [subRes, prodRes] = await Promise.all([
                    fetch(`${API_BASE_URL}/api/categories/${categoryId}/subcategories`),
                    fetch(`${API_BASE_URL}/api/categories/${categoryId}/all-products-with-amounts?mode=${mode}`),
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
            } finally {
                setLoading(false);
            }
        };
        fetchData();
        // i18n.language dep: subcategories carry localised names; re-fetch
        // when the language changes (or on first hydration) so the chips
        // don't lag behind the rest of the UI.
    }, [categoryId, mode, prefReady, i18n.language]);
    useEffect(() => {
        const loadBasketQuantities = async () => {
            if (!draftBasketId) {
                await useBasketState.getState().initDraftBasket();
            }
            const currentDraftId = useBasketState.getState().draftBasketId;
            if (!currentDraftId) return;

            try {
                const res = await fetch(`${API_BASE_URL}/api/baskets/${currentDraftId}/items`);
                const items = await res.json();
                if (Array.isArray(items)) {
                    const quantities: {[productId: number]: number} = {};
                    items.forEach((item: any) => {
                        quantities[item.productId] = parseFloat(item.quantity);
                    });
                    setBasketQuantities(quantities);
                    setBasketItemCount(items.filter((i: any) => parseFloat(i.quantity) > 0).length);
                }
            } catch {}
        };
        loadBasketQuantities();
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
    useFocusEffect(useCallback(() => {
        const currentDraftId = useBasketState.getState().draftBasketId;
        if (currentDraftId) {
            fetch(`${API_BASE_URL}/api/baskets/${currentDraftId}/items`)
                .then(r => r.json())
                .then(items => {
                    if (!Array.isArray(items)) return;
                    const quantities: { [productId: number]: number } = {};
                    items.forEach((item: any) => {
                        quantities[item.productId] = parseFloat(item.quantity);
                    });
                    setBasketQuantities(quantities);
                    setBasketItemCount(items.filter((i: any) => parseFloat(i.quantity) > 0).length);
                })
                .catch(() => {});
        } else {
            setBasketQuantities({});
            setBasketItemCount(0);
        }
    }, []));

    // True when the user has any item in their current draft basket.
    // basketQuantities can hold 0 values after a quantity decrement, so we
    // check for any strictly-positive entry.
    const hasBasketItems = Object.values(basketQuantities).some((q) => q > 0);

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
        if (target.kind === 'cancel') return { success: false, message: t('browse.cancelled') };

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

    const draftBasketIdRef = useRef(draftBasketId);
    useEffect(() => { draftBasketIdRef.current = draftBasketId; }, [draftBasketId]);
    const commitAddRef = useRef(commitAdd);
    useEffect(() => { commitAddRef.current = commitAdd; }, [commitAdd]);

    // Tap-debounce so a rapid double-tap doesn't push /search twice.
    const lastSearchPushAt = useRef(0);
    const pushSearch = useCallback(() => {
        const now = Date.now();
        if (now - lastSearchPushAt.current < 600) return;
        lastSearchPushAt.current = now;
        router.push({
            pathname: '/search',
            params: isTemplateMode
                ? { mode: 'products', source: 'template-add', templateId: String(templateId) }
                : { mode: 'products', source: 'browse' },
        } as any);
    }, [router, isTemplateMode, templateId]);

    const handleModeSwitchRequest = (nextOn: boolean) => {
        const target: 'base' | 'sku' = nextOn ? 'base' : 'sku';
        if (target === mode) return;
        if (!hasBasketItems || !draftBasketId) {
            // Nothing to convert — flip immediately.
            setMode(target);
            return;
        }
        // Defer the actual flip until the user confirms. The Switch will
        // render in its *old* position until then (its `value` prop is
        // bound to `mode`, not the pending target).
        setPendingMode(target);
    };

    const cancelModeSwitch = () => {
        setPendingMode(null);
    };

    const confirmModeSwitch = async () => {
        const target = pendingMode;
        if (!target || !draftBasketId) {
            setPendingMode(null);
            return;
        }
        try {
            setConverting(true);
            const res = await fetch(
                `${API_BASE_URL}/api/baskets/${draftBasketId}/convert-mode`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: target }),
                }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // Reload basket quantities — productIds may have changed on
            // sku→base (items now point at cluster heads), and rows may
            // have merged (duplicates collapsed into one summed row).
            const itemsRes = await fetch(
                `${API_BASE_URL}/api/baskets/${draftBasketId}/items`
            );
            if (itemsRes.ok) {
                const items = await itemsRes.json();
                if (Array.isArray(items)) {
                    const quantities: { [productId: number]: number } = {};
                    items.forEach((item: any) => {
                        quantities[item.productId] = parseFloat(item.quantity);
                    });
                    setBasketQuantities(quantities);
                }
            }
            setMode(target);
        } catch (e) {
            console.warn('convert-mode failed:', e);
        } finally {
            setConverting(false);
            setPendingMode(null);
        }
    };

    const selectL3 = async (l3Id: number | null) => {
        setSelectedL3(l3Id);
        setLoadingProducts(true);
        try {
            const url = l3Id
                ? `${API_BASE_URL}/api/categories/${l3Id}/products-with-amounts?mode=${mode}`
                : `${API_BASE_URL}/api/categories/${categoryId}/all-products-with-amounts?mode=${mode}`;
            const res = await fetch(url);
            const data = await res.json();
            const prods: Product[] = Array.isArray(data) ? data : [];
            setProducts(prods);

            if (mode === 'base' && prods.length > 0) {
                const userId = await getUserId();
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

    const onNavigate = useCallback((id: number) => {
        if (isTemplateMode) {
            router.push(`/product/${id}?templateId=${templateId}` as any);
        } else {
            router.push(`/product/${id}` as any);
        }
    }, [router, isTemplateMode, templateId]);

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

    const onAdd = useCallback((item: Product) => {
        const hasRange = item.minAmount !== null && item.maxAmount !== null && item.minAmount !== item.maxAmount;
        if (hasRange || !!item.hasWeighable) { setAmountModal({ visible: true, product: item }); return; }
        // Send one canonical step as the initial quantity (e.g. 1L for a
        // 1L milk SP, 0.5L for a 500ml SP) so the server pack-math lands
        // on exactly one pack — never half a pack.
        const initialQty = resolveCanonicalStep(item);
        if (isTemplateMode) {
            commitTemplateAdd(item.id, initialQty);
            return;
        }
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
    }, [setAmountModal, isTemplateMode, commitTemplateAdd, t]);

    const onDecrement = useCallback((item: Product, qty: number) => {
        const step = resolveCanonicalStep(item);
        const newQty = Math.round((qty - step) / step) * step;
        const bid = draftBasketIdRef.current;
        if (newQty <= 0) {
            setBasketQuantities(prev => ({ ...prev, [item.id]: 0 }));
            setBasketItemCount(prev => Math.max(0, prev - 1));
            if (!bid) return;
            fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async (allItems: any) => {
                const basketItem = Array.isArray(allItems) ? allItems.find((i: any) => i.productId === item.id) : null;
                if (basketItem) await fetch(`${API_BASE_URL}/api/basket-items/${basketItem.id}`, { method: 'DELETE' });
                const remaining = Array.isArray(allItems) ? allItems.filter((i: any) => i.id !== basketItem?.id) : [];
                if (remaining.length === 0) { await fetch(`${API_BASE_URL}/api/baskets/${bid}`, { method: 'DELETE' }); setDraftBasketId(null); }
            }).catch(() => {});
        } else {
            setBasketQuantities(prev => ({ ...prev, [item.id]: newQty }));
            if (!bid) return;
            fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async (items2: any) => {
                const basketItem = items2.find((i: any) => i.productId === item.id);
                if (basketItem) await fetch(`${API_BASE_URL}/api/basket-items/${basketItem.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: newQty }) });
            }).catch(() => {});
        }
    }, [setDraftBasketId]);

    const onIncrement = useCallback((item: Product, qty: number) => {
        const step = resolveCanonicalStep(item);
        const newQty = Math.round((qty + step) / step) * step;
        const bid = draftBasketIdRef.current;
        setBasketQuantities(prev => ({ ...prev, [item.id]: newQty }));
        if (!bid) return;
        fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async (items2: any) => {
            const basketItem = items2.find((i: any) => i.productId === item.id);
            if (basketItem) await fetch(`${API_BASE_URL}/api/basket-items/${basketItem.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: newQty }) });
        }).catch(() => {});
    }, []);

    const renderItem = useCallback(({ item }: { item: Product }) => {
        const mergedQty = (mergedIntoMe[item.id] ?? [])
            .reduce((sum, hid) => sum + (basketQuantities[hid] ?? 0), 0);
        const quantity = (basketQuantities[item.id] ?? 0) + mergedQty;
        const bigUnit = item.canonicalUnit === 'l' ? 'l' : 'kg';
        const smallUnit = item.canonicalUnit === 'l' ? 'ml' : 'g';
        const fmt = (v: number) => v >= 1000 ? `${v / 1000} ${bigUnit}` : `${v} ${smallUnit}`;
        const amountText = item.minAmount != null && item.maxAmount != null
            ? (() => { const mn = Number(item.minAmount); const mx = Number(item.maxAmount); return mn === mx ? fmt(mn) : `${fmt(mn)} - ${fmt(mx)}`; })()
            : '';
        // In template mode the card's quantity reflects the in-template
        // amount (so already-added products render the stepper instead of
        // the "Į šabloną" CTA). +/− operate on the template, not a basket.
        const templateQty = isTemplateMode ? (templateMap[item.id]?.quantity ?? 0) : 0;
        const cardQuantity = isTemplateMode ? templateQty : quantity;
        const step = resolveCanonicalStep(item);
        return (
            <BasketProductCard
                name={item.name}
                imageUrls={item.imageUrls}
                chainLogos={item.chainLogos}
                amountText={amountText}
                quantity={cardQuantity}
                isAdding={addingIds.has(item.id)}
                addLabel={isTemplateMode ? t('basketTab.templates.addToTemplate') : undefined}
                onOpen={() => onNavigate(item.id)}
                onAdd={() => onAdd(item)}
                onDec={() => {
                    if (isTemplateMode) {
                        const next = Math.max(0, Math.round((templateQty - step) / step) * step);
                        templateSetQty(item.id, next).catch(() => {});
                        return;
                    }
                    onDecrement(item, quantity);
                }}
                onInc={() => {
                    if (isTemplateMode) {
                        const next = Math.round((templateQty + step) / step) * step;
                        templateSetQty(item.id, next).catch(() => {});
                        return;
                    }
                    onIncrement(item, quantity);
                }}
            />
        );
    }, [basketQuantities, mergedIntoMe, addingIds, onNavigate, onAdd, onDecrement, onIncrement, isTemplateMode, templateMap, templateSetQty, t]);

    if (loading) return (
        <>
        <Stack.Screen options={{
            title: decodeURIComponent((name as string) || ''),
            headerStyle: { backgroundColor: colors.cardBackground },
            headerShadowVisible: false,
            headerLeft: () => <ScreenBackButton />,
        }} />
        <View style={styles.container}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 6, backgroundColor: colors.cardBackground }}>
                <SkeletonBox width={170} height={13} borderRadius={6} />
                <View style={{ flex: 1 }} />
                <SkeletonBox width={44} height={26} borderRadius={13} />
            </View>
            <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 8, backgroundColor: colors.cardBackground, borderBottomWidth: 0.5, borderBottomColor: colors.borderSubtle }}>
                {[72, 58, 84, 66].map((w, i) => (
                    <SkeletonBox key={i} width={w} height={30} borderRadius={20} />
                ))}
            </View>
            <View style={{ padding: 12 }}>
                {Array.from({ length: 3 }).map((_, row) => (
                    <View key={row} style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
                        {[0, 1].map(col => (
                            <View key={col} style={{ flex: 1, backgroundColor: colors.cardBackground, borderRadius: 12, padding: 12, alignItems: 'center', gap: 8 }}>
                                <SkeletonBox height={130} borderRadius={8} />
                                <SkeletonBox width={100} height={13} borderRadius={6} />
                                <SkeletonBox width={60} height={11} borderRadius={5} />
                                <SkeletonBox height={34} borderRadius={10} />
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
            <Stack.Screen
                options={{
                    title: decodeURIComponent(name || ''),
                    headerStyle: { backgroundColor: colors.cardBackground },
                    headerShadowVisible: false,
                    headerLeft: () => <ScreenBackButton />,
                    headerRight: () => (
                        <GlassIconButton icon="search" onPress={pushSearch} />
                    ),
                }}
            />
            <View style={{ flex: 1 }}>
            <View style={styles.container}>
                <View style={styles.modeToggleRow}>
                    <Text style={styles.modeToggleLabel}>{t('browse.combineAlternatives')}</Text>
                    <TouchableOpacity
                        onPress={() => setHelpOpen(true)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <Ionicons name="help-circle-outline" size={18} color={colors.textMuted} />
                    </TouchableOpacity>
                    <View style={{ flex: 1 }} />
                    <Switch
                        value={mode === 'base'}
                        onValueChange={handleModeSwitchRequest}
                        trackColor={{ false: colors.border, true: colors.primary }}
                        thumbColor={colors.cardBackground}
                        disabled={converting}
                    />
                </View>
                <CategoryBubbles
                    categories={l3Categories}
                    selectedId={selectedL3}
                    onSelect={selectL3}
                    allLabel={t('browse.allProducts')}
                />

                <View style={{ flex: 1 }}>
                    {loadingProducts ? (
                        <View style={{ padding: 12 }}>
                            {Array.from({ length: 3 }).map((_, row) => (
                                <View key={row} style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
                                    {[0, 1].map(col => (
                                        <View key={col} style={{ flex: 1, backgroundColor: colors.cardBackground, borderRadius: 12, padding: 12, alignItems: 'center', gap: 8 }}>
                                            <SkeletonBox height={130} borderRadius={8} style={{ alignSelf: 'stretch' }} />
                                            <SkeletonBox width={100} height={13} borderRadius={6} />
                                            <SkeletonBox width={60} height={11} borderRadius={5} />
                                            <SkeletonBox height={34} borderRadius={10} style={{ alignSelf: 'stretch' }} />
                                        </View>
                                    ))}
                                </View>
                            ))}
                        </View>
                    ) : (
                        <FlatList
                            data={visibleProducts}
                            keyExtractor={item => item.id.toString()}
                            contentContainerStyle={[
                                styles.list,
                                // Reserve room for the absolute "Šablonas"
                                // banner so the last row's "Į šabloną" CTA
                                // isn't hidden under it.
                                isTemplateMode && { paddingBottom: 96 + bottomInset },
                            ]}
                            numColumns={2}
                            columnWrapperStyle={styles.row}
                            ListEmptyComponent={
                                <Text style={styles.emptyText}>{t('browse.noProducts')}</Text>
                            }
                            renderItem={renderItem}
                        />
                    )}
                </View>
            </View>
            {!isTemplateMode && basketItemCount > 0 && draftBasketId && (
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
                        onPress={() => router.push(`/basket/${draftBasketId}` as any)}
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
            <Modal
                visible={pendingMode !== null}
                transparent
                animationType="fade"
                onRequestClose={cancelModeSwitch}
            >
                <View style={styles.helpBackdrop}>
                    <View style={styles.helpCard}>
                        <Text style={styles.helpTitle}>{t('browse.modeSwitch.title')}</Text>
                        <Text style={styles.helpBody}>
                            {t('browse.modeSwitch.body')}
                        </Text>
                        <View style={styles.helpActionsRow}>
                            <GlassButton
                                title={t('common.cancel')}
                                variant="secondary"
                                onPress={cancelModeSwitch}
                                disabled={converting}
                                flex
                            />
                            <GlassButton
                                title={converting ? '…' : t('browse.modeSwitch.confirm')}
                                variant="primary"
                                onPress={confirmModeSwitch}
                                disabled={converting}
                                flex
                            />
                        </View>
                    </View>
                </View>
            </Modal>
            <Modal
                visible={helpOpen}
                transparent
                animationType="fade"
                onRequestClose={() => setHelpOpen(false)}
            >
                <TouchableOpacity
                    style={styles.helpBackdrop}
                    activeOpacity={1}
                    onPress={() => setHelpOpen(false)}
                >
                    <TouchableOpacity
                        style={styles.helpCard}
                        activeOpacity={1}
                        onPress={() => {}}
                    >
                        <Text style={styles.helpTitle}>
                            {t('browse.modeSwitch.helpTitle')}{'  '}
                            <Text style={styles.helpBadge}>{t('browse.modeSwitch.experimentalBadge')}</Text>
                        </Text>
                        <Text style={styles.helpBody}>
                            {t('browse.modeSwitch.explainer')}
                        </Text>
                        <Text style={styles.helpBody}>
                            {t('browse.modeSwitch.example')}
                        </Text>
                        <GlassButton
                            title={t('browse.modeSwitch.gotIt')}
                            variant="primary"
                            onPress={() => setHelpOpen(false)}
                            style={{ alignSelf: 'flex-end', marginTop: 4, minWidth: 84 }}
                        />

                    </TouchableOpacity>
                </TouchableOpacity>
            </Modal>
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
                        // In template mode the picker is the "set absolute
                        // quantity" surface — overrides any existing row
                        // rather than incrementing it (matches how the
                        // template editor's per-row input works).
                        if (templateMap[product.id]) {
                            await templateSetQty(product.id, amount).catch(() => {});
                        } else {
                            await commitTemplateAdd(product.id, amount);
                        }
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
            <Toast ref={toastRef} />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    modeToggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 6,
        backgroundColor: c.cardBackground,
    },
    modeToggleLabel: {
        fontSize: 13,
        color: c.textPrimary,
        fontWeight: '600',
    },
    helpBackdrop: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
    },
    helpCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 14,
        padding: 20,
        gap: 12,
        width: '100%',
        maxWidth: 420,
    },
    helpTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: c.textPrimary,
    },
    helpBadge: {
        fontSize: 11,
        fontWeight: '700',
        color: c.primary,
        letterSpacing: 0.5,
    },
    helpBody: {
        fontSize: 14,
        color: c.textSecondary,
        lineHeight: 20,
    },
    helpClose: {
        alignSelf: 'flex-end',
        marginTop: 4,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 10,
        backgroundColor: c.primary,
        minWidth: 84,
        alignItems: 'center',
    },
    helpCloseText: {
        color: c.onPrimary,
        fontWeight: '600',
        fontSize: 14,
    },
    helpActionsRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
        marginTop: 4,
    },
    helpCloseSecondary: {
        backgroundColor: c.cardBackground,
        borderWidth: 1,
        borderColor: c.border,
    },
    helpCloseSecondaryText: {
        color: c.textPrimary,
        fontWeight: '600',
        fontSize: 14,
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
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.cardBackground,
    },
    bubbleActive: {
        backgroundColor: c.primary,
        borderColor: c.primary,
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
        gap: 12,
        marginBottom: 12,
    },
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
        width: 36, height: 36, borderRadius: 8,
        backgroundColor: c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
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
        borderRadius: 10,
    },
    basketBarButtonText: {
        fontSize: 14,
        fontWeight: '700',
        color: c.onPrimary,
    },
});