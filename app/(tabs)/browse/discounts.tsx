import {
    View, FlatList, ScrollView, TouchableOpacity, Text, TextInput,
    StyleSheet, ActivityIndicator
} from 'react-native';
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useRouter, Stack, useFocusEffect, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../../config/api';
import { useBasketState } from '../../../state/basketState';
import { addProductToBasket } from '../../../utils/basketUtils';
import { ProductImage } from '../../../components/ProductImage';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { getUserId } from '../../../config/user';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ComparedBasketChoiceModal, { type ComparedBasketChoice } from '../../../components/ComparedBasketChoiceModal';
import AmountPickerModal from '../../../components/AmountPickerModal';

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
    imageUrls?: (string | null | undefined)[] | string | null;
    minAmount: number | null;
    maxAmount: number | null;
    unit: string | null;
    hasWeighable: boolean;
    bestDiscountPct: number;
}

export default function DiscountsScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();
    const navigation = useNavigation();
    const router = useRouter();

    const [l2Categories, setL2Categories] = useState<L2Category[]>([]);
    const [selectedL2, setSelectedL2] = useState<number | null>(null);
    const [search, setSearch] = useState('');
    const [products, setProducts] = useState<DiscountedProduct[]>([]);
    // initialLoading: true until the very first fetch completes (full-screen spinner)
    // refreshing: true on subsequent fetches — keeps existing products visible
    const [initialLoading, setInitialLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [addingIds, setAddingIds] = useState<Set<number>>(() => new Set());

    const PAGE_SIZE = 30;

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

    const hasLoadedOnce = useRef(false);
    const CACHE_KEY = 'discounts_cache_v1';

    const fetchProducts = useCallback(async (l2: number | null, q: string, background = false) => {
        if (!background) {
            if (!hasLoadedOnce.current) setInitialLoading(true);
            else setRefreshing(true);
        }
        try {
            const params = new URLSearchParams();
            if (l2 != null) params.set('l2CategoryId', String(l2));
            if (q.trim()) params.set('search', q.trim());
            params.set('limit', String(PAGE_SIZE));
            params.set('offset', '0');
            const res = await fetch(`${API_BASE_URL}/api/products/discounted?${params}`);
            const data = await res.json();
            const fresh = Array.isArray(data) ? data : [];
            setProducts(fresh);
            setHasMore(fresh.length === PAGE_SIZE);
            // Persist unfiltered first page so next open is instant
            if (l2 == null && !q.trim()) {
                AsyncStorage.setItem(CACHE_KEY, JSON.stringify(fresh)).catch(() => {});
            }
        } finally {
            if (!background) {
                if (!hasLoadedOnce.current) {
                    hasLoadedOnce.current = true;
                    setInitialLoading(false);
                } else {
                    setRefreshing(false);
                }
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [PAGE_SIZE]);

    const productsCountRef = useRef(0);
    useEffect(() => { productsCountRef.current = products.length; }, [products.length]);

    const loadMore = useCallback(async () => {
        if (loadingMore || !hasMore) return;
        setLoadingMore(true);
        try {
            const params = new URLSearchParams();
            if (selectedL2 != null) params.set('l2CategoryId', String(selectedL2));
            if (search.trim()) params.set('search', search.trim());
            params.set('limit', String(PAGE_SIZE));
            params.set('offset', String(productsCountRef.current));
            const res = await fetch(`${API_BASE_URL}/api/products/discounted?${params}`);
            const data = await res.json();
            const fresh = Array.isArray(data) ? data : [];
            setProducts(prev => [...prev, ...fresh]);
            setHasMore(fresh.length === PAGE_SIZE);
        } catch {}
        finally { setLoadingMore(false); }
    }, [loadingMore, hasMore, selectedL2, search, PAGE_SIZE]);

    // On mount: load AsyncStorage cache instantly, then fetch fresh in background
    useEffect(() => {
        AsyncStorage.getItem(CACHE_KEY).then(raw => {
            if (raw) {
                try {
                    const cached = JSON.parse(raw);
                    if (Array.isArray(cached) && cached.length > 0) {
                        setProducts(cached);
                        hasLoadedOnce.current = true;
                        setInitialLoading(false);
                        // Refresh silently in background
                        fetchProducts(null, '', true);
                        return;
                    }
                } catch {}
            }
            // No usable cache — do a normal (spinner) fetch
            fetchProducts(null, '');
        }).catch(() => fetchProducts(null, ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!hasLoadedOnce.current) return; // mount effect handles first load
        const timer = setTimeout(() => fetchProducts(selectedL2, search), search ? 300 : 0);
        return () => clearTimeout(timer);
    }, [selectedL2, search, fetchProducts]);

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

    const renderItem = useCallback(({ item }: { item: DiscountedProduct }) => {
        const quantity = basketQuantities[item.id] ?? 0;
        return (
            <View style={styles.productCard}>
                <TouchableOpacity
                    onPress={() => router.push(`/product/${item.id}` as any)}
                    style={styles.productImageContainer}
                    activeOpacity={0.7}
                >
                    <ProductImage
                        uris={item.imageUrls}
                        imageStyle={styles.productImage}
                        placeholderStyle={styles.productImagePlaceholder}
                        emojiStyle={styles.productImageEmoji}
                    />
                    <View style={styles.discountBadge}>
                        <Text style={styles.discountBadgeText}>
                            🔥 -{item.bestDiscountPct}%
                        </Text>
                    </View>
                </TouchableOpacity>
                <View style={styles.productInfo}>
                    <Text style={styles.productName} numberOfLines={3}>{item.name}</Text>
                    <Text style={styles.amountText}>
                        {item.minAmount != null && item.maxAmount != null ? (() => {
                            const min = Number(item.minAmount);
                            const max = Number(item.maxAmount);
                            const fmt = (v: number) => v >= 1000 ? `${v / 1000} kg` : `${v} g`;
                            return min === max ? fmt(min) : `${fmt(min)} - ${fmt(max)}`;
                        })() : ''}
                    </Text>
                </View>
                {quantity === 0 ? (
                    <TouchableOpacity
                        style={[styles.addButton, addingIds.has(item.id) && { opacity: 0.5 }]}
                        disabled={addingIds.has(item.id)}
                        onPress={async () => {
                            if (addingIds.has(item.id)) return;
                            const hasRange = item.minAmount !== null && item.maxAmount !== null && item.minAmount !== item.maxAmount;
                            const needsPicker = hasRange || !!item.hasWeighable;
                            if (needsPicker) {
                                setAmountModal({ visible: true, product: item });
                            } else {
                                setAddingIds(prev => { const n = new Set(prev); n.add(item.id); return n; });
                                try {
                                    const result = await commitAdd(item.id, 1);
                                    if (result.success) {
                                        setBasketQuantities(prev => ({ ...prev, [item.id]: 1 }));
                                        setBasketItemCount(prev => prev + 1);
                                    }
                                } finally {
                                    setAddingIds(prev => { const n = new Set(prev); n.delete(item.id); return n; });
                                }
                            }
                        }}
                    >
                        <Text style={styles.addButtonText}>Į krepšelį</Text>
                    </TouchableOpacity>
                ) : (
                    <View style={styles.quantityControl}>
                        <TouchableOpacity
                            style={styles.qtyButton}
                            onPress={async () => {
                                const step = item.hasWeighable ? 0.1 : 1;
                                const newQty = Math.round((quantity - step) * 10) / 10;
                                if (newQty <= 0) {
                                    setBasketQuantities(prev => ({ ...prev, [item.id]: 0 }));
                                    setBasketItemCount(prev => Math.max(0, prev - 1));
                                    try {
                                        const res = await fetch(`${API_BASE_URL}/api/baskets/${draftBasketId}/items`);
                                        const allItems = await res.json();
                                        const bi = Array.isArray(allItems) ? allItems.find((i: any) => i.productId === item.id) : null;
                                        if (bi) await fetch(`${API_BASE_URL}/api/basket-items/${bi.id}`, { method: 'DELETE' });
                                        const remaining = Array.isArray(allItems) ? allItems.filter((i: any) => i.id !== bi?.id) : [];
                                        if (remaining.length === 0 && draftBasketId) {
                                            await fetch(`${API_BASE_URL}/api/baskets/${draftBasketId}`, { method: 'DELETE' });
                                            clearSessionBasket();
                                        }
                                    } catch {}
                                } else {
                                    setBasketQuantities(prev => ({ ...prev, [item.id]: newQty }));
                                    try {
                                        const res = await fetch(`${API_BASE_URL}/api/baskets/${draftBasketId}/items`);
                                        const items2 = await res.json();
                                        const bi = items2.find((i: any) => i.productId === item.id);
                                        if (bi) await fetch(`${API_BASE_URL}/api/basket-items/${bi.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: newQty }) });
                                    } catch {}
                                }
                            }}
                        >
                            <Ionicons name="remove" size={16} color={colors.primary} />
                        </TouchableOpacity>
                        <Text style={styles.qtyText}>
                            {Number.isInteger(quantity) ? quantity : quantity.toFixed(1)}
                        </Text>
                        <TouchableOpacity
                            style={styles.qtyButton}
                            onPress={async () => {
                                const step = item.hasWeighable ? 0.1 : 1;
                                const newQty = Math.round((quantity + step) * 10) / 10;
                                setBasketQuantities(prev => ({ ...prev, [item.id]: newQty }));
                                try {
                                    const res = await fetch(`${API_BASE_URL}/api/baskets/${draftBasketId}/items`);
                                    const items2 = await res.json();
                                    const bi = items2.find((i: any) => i.productId === item.id);
                                    if (bi) await fetch(`${API_BASE_URL}/api/basket-items/${bi.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: newQty }) });
                                } catch {}
                            }}
                        >
                            <Ionicons name="add" size={16} color={colors.primary} />
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        );
    }, [basketQuantities, addingIds, styles, colors, router, draftBasketId, commitAdd, setDraftBasketId]);

    return (
        <>
            <Stack.Screen options={{
                title: 'Nuolaidos',
                headerStyle: { backgroundColor: colors.cardBackground },
                headerShadowVisible: false,
            }} />
            <View style={{ flex: 1 }}>
                <View style={styles.container}>
                    {l2Categories.length > 0 && (
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
                            {l2Categories.map(cat => (
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
                            placeholder="Ieškoti prekių su nuolaidomis…"
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
                            <View style={styles.centered}>
                                <ActivityIndicator size="large" color={colors.primary} />
                                <Text style={styles.loadingText}>Įkeliamos prekės su nuolaidomis…</Text>
                            </View>
                        ) : (
                            <FlatList
                                data={products}
                                keyExtractor={item => item.id.toString()}
                                contentContainerStyle={styles.list}
                                numColumns={2}
                                columnWrapperStyle={styles.row}
                                onEndReached={loadMore}
                                onEndReachedThreshold={0.5}
                                ListFooterComponent={loadingMore ? (
                                    <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 12 }} />
                                ) : null}
                                ListEmptyComponent={
                                    <Text style={styles.emptyText}>
                                        {search ? 'Nerasta akcijinių prekių pagal paiešką' : 'Šiuo metu nėra akcijinių prekių'}
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
                                {basketItemCount} {pluralizeItems(basketItemCount)}
                            </Text>
                        </View>
                        <TouchableOpacity
                            style={styles.basketBarButton}
                            onPress={() => router.push(`/basket/${sessionBasketId}` as any)}
                        >
                            <Text style={styles.basketBarButtonText}>Krepšelis</Text>
                            <Ionicons name="chevron-forward" size={16} color={colors.onPrimary} />
                        </TouchableOpacity>
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
                minAmount={amountModal.product?.minAmount || 0}
                maxAmount={amountModal.product?.maxAmount || 0}
                unit={amountModal.product?.unit || 'g'}
                isWeighable={!!amountModal.product?.hasWeighable}
                onCancel={() => setAmountModal({ visible: false, product: null })}
                onConfirm={async (amount) => {
                    if (amountModal.product) {
                        const result = await commitAdd(amountModal.product.id, amount);
                        if (result.success) {
                            setBasketQuantities(prev => ({ ...prev, [amountModal.product!.id]: amount }));
                            setBasketItemCount(prev => prev + 1);
                        }
                    }
                    setAmountModal({ visible: false, product: null });
                }}
            />
        </>
    );
}

function pluralizeItems(n: number): string {
    if (n % 10 === 1 && n % 100 !== 11) return 'prekė';
    if (n % 10 >= 2 && n % 10 <= 9 && (n % 100 < 10 || n % 100 >= 20)) return 'prekės';
    return 'prekių';
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
