import {
    View, FlatList, ScrollView, TouchableOpacity, Text, TextInput,
    StyleSheet, ActivityIndicator, RefreshControl
} from 'react-native';
import { useEffect, useMemo, useState, useCallback, useRef, memo } from 'react';
import { useRouter, Stack, useFocusEffect, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../../config/api';
import { useBasketState } from '../../../state/basketState';
import { addProductToBasket } from '../../../utils/basketUtils';
import { resolveCanonicalStep } from '../../../utils/canonicalStep';
import { ProductImage } from '../../../components/ProductImage';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { getUserId } from '../../../config/user';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ComparedBasketChoiceModal, { type ComparedBasketChoice } from '../../../components/ComparedBasketChoiceModal';
import AmountPickerModal from '../../../components/AmountPickerModal';
import { Toast, type ToastHandle } from '../../../components/Toast';
import { ScalePressable } from '../../../components/ScalePressable';
import { SkeletonBox } from '../../../components/SkeletonBox';
import { ChainLogoStrip } from '../../../components/ChainLogoStrip';
import { useTranslation } from 'react-i18next';

interface L2Category {
    id: number;
    name: string;
    parentCategoryId: number;
    l1Id: number;
    l1Name: string;
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

const DiscountProductCard = memo(({
    item, quantity, isAdding, styles, colors,
    onNavigate, onAdd, onDecrement, onIncrement,
}: CardCallbacks & {
    item: DiscountedProduct;
    quantity: number;
    isAdding: boolean;
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
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
                    <Text style={styles.discountBadgeText}>🔥 -{item.bestDiscountPct}%</Text>
                </View>
            </TouchableOpacity>
            <View style={styles.productInfo}>
                <Text style={styles.productName} numberOfLines={3}>{item.name}</Text>
                <Text style={styles.amountText}>{amountText}</Text>
            </View>
            {quantity === 0 ? (
                <ScalePressable style={[styles.addButton, isAdding && { opacity: 0.5 }]} disabled={isAdding} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onAdd(item); }}>
                    <Text style={styles.addButtonText}>{t('browse.addToBasket')}</Text>
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

export default function DiscountsScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();
    const navigation = useNavigation();
    const router = useRouter();

    const [l2Categories, setL2Categories] = useState<L2Category[]>([]);
    const [selectedL2, setSelectedL2] = useState<number | null>(null);
    const [search, setSearch] = useState('');
    const [allProducts, setAllProducts] = useState<DiscountedProduct[]>([]);
    const [initialLoading, setInitialLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [addingIds, setAddingIds] = useState<Set<number>>(() => new Set());
    const toastRef = useRef<ToastHandle>(null);

    const activeL2Ids = useMemo(
        () => new Set(allProducts.map(p => p.l2CategoryId).filter(id => id != null)),
        [allProducts],
    );

    useEffect(() => {
        if (selectedL2 != null && !activeL2Ids.has(selectedL2)) setSelectedL2(null);
    }, [activeL2Ids, selectedL2]);

    const products = useMemo(() => {
        let list = allProducts;
        if (selectedL2 != null) list = list.filter(p => p.l2CategoryId === selectedL2);
        if (search.trim()) {
            const q = search.trim().toLowerCase();
            list = list.filter(p => p.name.toLowerCase().includes(q));
        }
        return list;
    }, [allProducts, selectedL2, search]);

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

    useEffect(() => {
        fetch(`${API_BASE_URL}/api/categories/l2`)
            .then(r => r.json())
            .then(data => setL2Categories(Array.isArray(data) ? data : []));
    }, []);

    const CACHE_KEY = 'discounts_cache_v2';

    const fetchAll = useCallback(async (background = false) => {
        if (!background) setRefreshing(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/products/discounted`);
            const data = await res.json();
            const fresh = Array.isArray(data) ? data : [];
            setAllProducts(fresh);
            AsyncStorage.setItem(CACHE_KEY, JSON.stringify(fresh)).catch(() => {});
        } finally {
            if (!background) setRefreshing(false);
        }
    }, []);

    // On mount: show cached data instantly, refresh in background
    useEffect(() => {
        AsyncStorage.getItem(CACHE_KEY).then(raw => {
            if (raw) {
                try {
                    const cached = JSON.parse(raw);
                    if (Array.isArray(cached) && cached.length > 0) {
                        setAllProducts(cached);
                        setInitialLoading(false);
                        fetchAll(true);
                        return;
                    }
                } catch {}
            }
            fetchAll(false).finally(() => setInitialLoading(false));
        }).catch(() => fetchAll(false).finally(() => setInitialLoading(false)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useFocusEffect(useCallback(() => {
        navigation.getParent()?.setOptions({ tabBarStyle: { display: 'none' } });
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
        return () => { navigation.getParent()?.setOptions({ tabBarStyle: undefined }); };
    }, [navigation, draftBasketId]));

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
        router.push(`/product/${id}` as any);
    }, [router]);

    const onAdd = useCallback((item: DiscountedProduct) => {
        const hasRange = item.minAmount !== null && item.maxAmount !== null && item.minAmount !== item.maxAmount;
        if (hasRange || item.hasWeighable) { setAmountModal({ visible: true, product: item }); return; }
        // First-tap quick-add: send one canonical step as the quantity so
        // server pack-math lands on exactly one pack (1L for a 1L SP, but
        // 0.5L = 1 bottle for a 500ml SP — never half a pack).
        const initialQty = resolveCanonicalStep(item);
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
    }, [setAmountModal]);

    const onDecrement = useCallback((item: DiscountedProduct, qty: number) => {
        const step = resolveCanonicalStep(item);
        const newQty = Math.round((qty - step) / step) * step;
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
    }, [clearSessionBasket]);

    const onIncrement = useCallback((item: DiscountedProduct, qty: number) => {
        const step = resolveCanonicalStep(item);
        const newQty = Math.round((qty + step) / step) * step;
        const bid = draftBasketIdRef.current;
        setBasketQuantities(prev => ({ ...prev, [item.id]: newQty }));
        if (!bid) return;
        fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async items2 => {
            const bi = items2.find((i: any) => i.productId === item.id);
            if (bi) await fetch(`${API_BASE_URL}/api/basket-items/${bi.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: newQty }) });
        }).catch(() => {});
    }, []);

    const renderItem = useCallback(({ item }: { item: DiscountedProduct }) => (
        <DiscountProductCard
            item={item}
            quantity={basketQuantities[item.id] ?? 0}
            isAdding={addingIds.has(item.id)}
            styles={styles}
            colors={colors}
            onNavigate={onNavigate}
            onAdd={onAdd}
            onDecrement={onDecrement}
            onIncrement={onIncrement}
        />
    ), [basketQuantities, addingIds, styles, colors, onNavigate, onAdd, onDecrement, onIncrement]);

    return (
        <>
            <Stack.Screen options={{
                title: 'Nuolaidos',
                headerStyle: { backgroundColor: colors.cardBackground },
                headerShadowVisible: false,
            }} />
            <View style={{ flex: 1 }}>
                <View style={styles.container}>
                    {activeL2Ids.size > 0 && (
                        <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            contentContainerStyle={styles.bubblesContainer}
                            style={styles.bubblesRow}
                        >
                            <TouchableOpacity
                                style={[styles.bubble, selectedL2 === null && styles.bubbleActive]}
                                onPress={() => setSelectedL2(null)}
                            >
                                <Text style={[styles.bubbleText, selectedL2 === null && styles.bubbleTextActive]}>
                                    Visos kategorijos
                                </Text>
                            </TouchableOpacity>
                            {l2Categories.filter(cat => activeL2Ids.has(cat.id)).map(cat => (
                                <TouchableOpacity
                                    key={cat.id}
                                    style={[styles.bubble, selectedL2 === cat.id && styles.bubbleActive]}
                                    onPress={() => setSelectedL2(selectedL2 === cat.id ? null : cat.id)}
                                >
                                    <Text style={[styles.bubbleText, selectedL2 === cat.id && styles.bubbleTextActive]}>
                                        {cat.name}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </ScrollView>
                    )}

                    <View style={styles.searchRow}>
                        <Ionicons name="search" size={18} color={colors.textMuted} style={styles.searchIcon} />
                        <TextInput
                            style={styles.searchInput}
                            placeholder={t('browse.searchPlaceholder')}
                            placeholderTextColor={colors.textMuted}
                            value={search}
                            onChangeText={setSearch}
                            returnKeyType="search"
                            clearButtonMode="while-editing"
                        />
                        {refreshing ? (
                            <ActivityIndicator size="small" color={colors.primary} />
                        ) : search.length > 0 ? (
                            <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                            </TouchableOpacity>
                        ) : null}
                    </View>

                    <View style={{ flex: 1 }}>
                        {initialLoading ? (
                            <View style={{ flex: 1, padding: 12, gap: 12 }}>
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <View key={i} style={{ flexDirection: 'row', gap: 12 }}>
                                        {[0, 1].map(j => (
                                            <View key={j} style={{ flex: 1, backgroundColor: colors.cardBackground, borderRadius: 12, padding: 12, gap: 8 }}>
                                                <SkeletonBox height={100} borderRadius={8} />
                                                <SkeletonBox height={12} borderRadius={6} />
                                                <SkeletonBox width={80} height={12} borderRadius={6} />
                                                <SkeletonBox height={32} borderRadius={8} />
                                            </View>
                                        ))}
                                    </View>
                                ))}
                            </View>
                        ) : (
                            <FlatList
                                data={products}
                                keyExtractor={item => item.id.toString()}
                                contentContainerStyle={styles.list}
                                numColumns={2}
                                columnWrapperStyle={styles.row}
                                refreshControl={
                                    <RefreshControl
                                        refreshing={refreshing}
                                        onRefresh={() => fetchAll(false)}
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

                {sessionBasketId !== null && basketItemCount > 0 && (
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
                    if (product) {
                        const result = await commitAdd(product.id, amount);
                        if (result.success) {
                            setBasketQuantities(prev => ({ ...prev, [product.id]: amount }));
                            setBasketItemCount(prev => prev + 1);
                            toastRef.current?.show(t('browse.addedToast'));
                        }
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
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
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
    list: { padding: 12 },
    row: { gap: 12, marginBottom: 12 },
    productCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 12,
        padding: 12,
        alignItems: 'center',
        elevation: 1,
        shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05, shadowRadius: 2,
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
    productImage: { width: '100%', height: '100%' },
    productImagePlaceholder: {
        width: '100%', height: '100%',
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.surfaceMuted, borderRadius: 8,
    },
    productImageEmoji: { fontSize: 44, opacity: 0.4 },
    discountBadge: {
        position: 'absolute',
        top: 4,
        right: 4,
        backgroundColor: c.primary,
        borderRadius: 8,
        paddingHorizontal: 6,
        paddingVertical: 3,
    },
    discountBadgeText: {
        fontSize: 11,
        fontWeight: '700',
        color: c.onPrimary,
    },
    productInfo: { flex: 1, width: '100%', marginBottom: 10 },
    productName: { fontSize: 13, color: c.textPrimary, lineHeight: 18 },
    amountText: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    addButton: {
        width: '100%',
        backgroundColor: c.primary,
        borderRadius: 8,
        paddingVertical: 10,
        alignItems: 'center',
    },
    addButtonText: { color: c.onPrimary, fontSize: 13, fontWeight: '600' },
    emptyText: { textAlign: 'center', padding: 32, fontSize: 15, color: c.textSecondary },
    quantityControl: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderWidth: 1,
        borderColor: c.primary,
        borderRadius: 8,
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
