import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Alert, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect, useNavigation, Stack } from 'expo-router';
import { useMemo, useState, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import { API_BASE_URL } from '../../../config/api';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { getUserId } from '../../../config/user';
import { useBasketState } from '../../../state/basketState';
import { useProfileStore } from '../../../state/profileStore';
import { loadCachedCoords, tryGpsCoords, persistCoords, type UserCoords } from '../../../utils/location';
import LocationPromptModal from '../../../components/LocationPromptModal';

/** Lithuanian plural inflection for "prekė":
 *    1  → prekės     (gen. sg.) "1 prekės"
 *    2–9, 22–29 … → prekių (gen. pl.)
 *    10–19, 20, 30 … → prekių
 *  Simplified to two forms since the badge only shows positive counts. */
function pluralizePrekes(n: number): string {
    if (n === 1) return 'prekės';
    return 'prekių';
}

interface ItemResult {
    productId: number;
    productName: string;
    quantity: number;
    matchMode: 'sku' | 'base';
    price: number | null;
    promoPrice: number | null;
    effectivePrice: number | null;
    isMissing: boolean;
    isFallback: boolean;
    isWeighable: boolean;
    isSubstituted: boolean;
    isCrossChainAverage: boolean;
    packsNeeded: number | null;
    totalPrice: number | null;
    storeProductName: string | null;
    storeProductId: number | null;
    resolvedProductId: number | null;
}

interface StoreResult {
    storeId: number;
    storeName: string;
    chainName: string;
    chainId: number;
    chainLogoUrl: string | null;
    storeAddress: string;
    distance: number;
    total: number;
    isApproximated: boolean;
    missingItemNames: string[];
    items: ItemResult[];
}

export default function BasketResultsScreen() {
    const colors = useTheme();
    const { clearSessionBasket } = useBasketState();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();
    const { id } = useLocalSearchParams();
    const router = useRouter();
    const navigation = useNavigation();
    const [results, setResults] = useState<StoreResult[]>([]);
    const [loading, setLoading] = useState(true);
    const [pullRefreshing, setPullRefreshing] = useState(false);
    const [visibleCount, setVisibleCount] = useState(0);
    const [selectedStoreId, setSelectedStoreId] = useState<number | null>(null);
    const [swipesGated, setSwipesGated] = useState(false);
    const [locationPromptVisible, setLocationPromptVisible] = useState(false);

    const loadResults = async () => {
        // Detail screen now awaits the calc before pushing to this route,
        // so the cache is always populated on entry. The previous 30-second
        // polling loop was a workaround for the old fire-and-navigate
        // pattern and is no longer needed. If we still find an empty cache
        // (e.g., the user reverted the basket to draft from a parallel
        // stack, wiping this key), render the empty state immediately.
        setLoading(true);
        setVisibleCount(0);
        setSelectedStoreId(null);

        const stored = await AsyncStorage.getItem(`basket_results_${id}`);
        if (stored) {
            const parsed = JSON.parse(stored);
            setResults(parsed);
            for (let i = 0; i <= parsed.length; i++) {
                setTimeout(() => setVisibleCount(i), i * 150);
            }
        } else {
            setResults([]);
        }
        setLoading(false);
    };

    const runRecalcWithCoords = useCallback(async (coords: UserCoords, isPull = false) => {
        if (!isPull) setLoading(true);
        setVisibleCount(0);
        setSelectedStoreId(null);
        try {
            const res = await fetch(`${API_BASE_URL}/api/baskets/${id}/calculate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lat: coords.lat, lng: coords.lng }),
            });
            const newResults = await res.json();
            await AsyncStorage.setItem(`basket_results_${id}`, JSON.stringify(newResults));
            await persistCoords(coords);
            setResults(newResults);
            setLoading(false);
            for (let i = 0; i <= newResults.length; i++) {
                setTimeout(() => setVisibleCount(i), i * 150);
            }
        } catch {
            Alert.alert('Klaida', 'Nepavyko perskaičiuoti');
            setLoading(false);
        }
    }, [id]);

    const handleRecalculate = useCallback(async () => {
        const cached = await loadCachedCoords();
        if (cached) { await runRecalcWithCoords(cached); return; }
        const gps = await tryGpsCoords();
        if (gps) { await runRecalcWithCoords(gps); return; }
        setLocationPromptVisible(true);
    }, [runRecalcWithCoords]);

    const handlePullRefresh = useCallback(async () => {
        setPullRefreshing(true);
        try {
            let blocked = false;
            try {
                const res = await fetch(`${API_BASE_URL}/api/baskets/${id}`);
                const basket = await res.json();
                if (basket?.status === 'inProgress' || basket?.status === 'completed') {
                    blocked = true;
                }
            } catch {}
            if (blocked) { await loadResults(); return; }
            const cached = await loadCachedCoords();
            if (cached) { await runRecalcWithCoords(cached, true); }
            else {
                const gps = await tryGpsCoords();
                if (gps) { await runRecalcWithCoords(gps, true); }
                else { setLocationPromptVisible(true); }
            }
        } finally {
            setPullRefreshing(false);
        }
    }, [runRecalcWithCoords, id]);

    useFocusEffect(useCallback(() => {
        // Set header options here — after expo-router's own focus event —
        // so the button isn't cleared when an unregistered screen gets its
        // options reset to defaults on every focus.
        navigation.setOptions({
            title: 'Palyginimo rezultatai',
            headerRight: undefined,
        });

        (async () => {
            try {
                const userId = await getUserId();
                const res = await fetch(`${API_BASE_URL}/api/users/${userId}/profile`);
                const profile = await res.json();
                setSwipesGated(!!profile?.pendingSwipes);
            } catch {
                setSwipesGated(false);
            }
        })();
        loadResults();
    }, [id, navigation, handleRecalculate, colors.primary]));

    const closestStoreId = results.length > 0
        ? [...results].sort((a, b) => a.distance - b.distance)[0].storeId
        : null;
    const cheapestStoreId = results.length > 1 && results[0].total < results[1].total
        ? results[0].storeId
        : results.length === 1
            ? results[0].storeId
            : null;
    const selectedStore = results.find(r => r.storeId === selectedStoreId);

    const handleNavigate = () => {
        if (!selectedStore) return;
        const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(selectedStore.storeAddress)}`;
        const { Linking } = require('react-native');
        Linking.openURL(url);
    };

    const [creatingList, setCreatingList] = useState(false);

    const handleCreateShoppingList = async () => {
        if (!selectedStore || creatingList) return;
        setCreatingList(true);
        try {
            const { getUserId } = await import('../../../config/user');
            const userId = await getUserId();

            const body = {
                userId,
                storeId: selectedStore.storeId,
                basketId: Number(id),
                items: selectedStore.items.map(item => {
                    const wasSubstituted =
                        (item as any).isSubstituted || (item as any).isCrossChainAverage;
                    return {
                        productId: item.productId,
                        storeProductId: wasSubstituted ? null : (item.storeProductId || null),
                        quantity: wasSubstituted
                            ? item.quantity
                            : (item.storeProductId
                                ? (item.isWeighable ? item.quantity : item.packsNeeded || item.quantity)
                                : item.quantity),
                        price: item.totalPrice,
                    };
                }),
            };

            const res = await fetch(`${API_BASE_URL}/api/shopping-lists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (res.status === 409) {
                const data = await res.json();
                clearSessionBasket();
                router.replace('/(tabs)/shoppingList' as any);
                setTimeout(() => {
                    router.push(`/shopping-list/${data.listId}` as any);
                }, 100);
                return;
            }
            if (!res.ok) {
                const errorText = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`);
            }
            const listData = await res.json();
            if (!listData?.id) throw new Error('Response missing id');

            clearSessionBasket();
            useProfileStore.getState().invalidate();
            router.replace('/(tabs)/shoppingList' as any);
            setTimeout(() => {
                router.push(`/shopping-list/${listData.id}` as any);
            }, 100);
        } catch (error: any) {
            Alert.alert('Klaida', 'Nepavyko sukurti pirkinių sąrašo');
        } finally {
            setCreatingList(false);
        }
    };

    return (
        <>
            {/* Declarative options for the first-mount case. Mirrored by
                useLayoutEffect above so re-renders keep the button
                attached even if expo-router's initial push timing hides
                it briefly. */}
            <Stack.Screen options={{ title: 'Palyginimo rezultatai' }} />
            <View style={styles.container}>
                {swipesGated && (
                    <Animated.View entering={FadeIn} style={styles.gateOverlay}>
                        <Ionicons name="lock-closed" size={48} color={colors.primary} />
                        <Text style={styles.gateTitle}>Užbaik kortelių brauksymą</Text>
                        <Text style={styles.gateBody}>
                            Kad matytum pigiausia parduotuvę, reikia užbaigti privalomąjį kortelių brauksymą. Eik į Analizė ir atlik likusius brauksmus.
                        </Text>
                        <TouchableOpacity
                            style={styles.gateButton}
                            onPress={() => router.push('/(tabs)/receipts' as any)}
                        >
                            <Text style={styles.gateButtonText}>Eiti į Analizė</Text>
                        </TouchableOpacity>
                    </Animated.View>
                )}
                {!swipesGated && loading && !pullRefreshing ? (
                    <Animated.View entering={FadeIn} style={styles.loadingContainer}>
                        <ActivityIndicator size="large" color={colors.primary} />
                        <Text style={styles.loadingText}>Skaičiuojamos kainos...</Text>
                    </Animated.View>
                ) : (
                    <FlatList
                        data={results.slice(0, visibleCount)}
                        keyExtractor={item => item.storeId.toString()}
                        contentContainerStyle={styles.list}
                        refreshControl={
                            <RefreshControl
                                refreshing={pullRefreshing}
                                onRefresh={handlePullRefresh}
                                colors={[colors.primary]}
                                tintColor={colors.primary}
                            />
                        }
                        ListEmptyComponent={
                            <View style={styles.centered}>
                                <Text style={styles.emptyText}>Rezultatų nėra</Text>
                            </View>
                        }
                        renderItem={({ item, index }) => {
                            const isCheapest = item.storeId === cheapestStoreId;
                            const isClosest = item.storeId === closestStoreId;
                            const isSelected = item.storeId === selectedStoreId;

                            return (
                                <Animated.View entering={FadeInDown.delay(index * 50).springify()}>
                                    <TouchableOpacity
                                        style={[
                                            styles.card,
                                            isCheapest && styles.cardCheapest,
                                            isClosest && !isCheapest && styles.cardClosest,
                                            isSelected && styles.cardSelected,
                                        ]}
                                        onPress={() => setSelectedStoreId(isSelected ? null : item.storeId)}
                                    >
                                        {isCheapest && (
                                            <View style={styles.cheapestBadge}>
                                                <Text style={styles.cheapestBadgeText}>Pigiausia</Text>
                                            </View>
                                        )}
                                        {isClosest && !isCheapest && (
                                            <View style={styles.closestBadge}>
                                                <Text style={styles.closestBadgeText}>Artimiausia</Text>
                                            </View>
                                        )}
                                        <View style={styles.cardLeft}>
                                            {item.chainLogoUrl ? (
                                                <Image source={{ uri: item.chainLogoUrl }} style={styles.logo} resizeMode="contain" />
                                            ) : (
                                                <View style={styles.logoPlaceholder}>
                                                    <Text style={styles.logoPlaceholderText}>{item.chainName[0]}</Text>
                                                </View>
                                            )}
                                        </View>
                                        <View style={styles.cardContent}>
                                            <Text style={styles.storeName}>{item.storeAddress}</Text>
                                            <View style={styles.metaRow}>
                                                <Ionicons name="location-outline" size={12} color={colors.textMuted} />
                                                <Text style={styles.distance}>{item.distance} km</Text>
                                                {item.missingItemNames && item.missingItemNames.length > 0 && (
                                                    <View style={styles.missingBadge}>
                                                        <Text style={styles.missingBadgeText}>{item.missingItemNames.length}</Text>
                                                        <Ionicons name="bag-remove-outline" size={12} color={colors.warning} />
                                                    </View>
                                                )}
                                                {(() => { const n = item.items.filter(i => i.isSubstituted).length; return n > 0 && (
                                                    <View style={styles.substitutedBadge}>
                                                        <Text style={styles.substitutedBadgeText}>{n}</Text>
                                                        <Ionicons name="swap-horizontal-outline" size={12} color={colors.info} />
                                                    </View>
                                                ); })()}
                                                {(() => { const n = item.items.filter(i => i.isCrossChainAverage).length; return n > 0 && (
                                                    <View style={styles.approxBadge}>
                                                        <Text style={styles.approxBadgeText}>{n}</Text>
                                                        <Ionicons name="help-circle-outline" size={12} color={colors.textMuted} />
                                                    </View>
                                                ); })()}
                                            </View>
                                            {isSelected && item.missingItemNames && item.missingItemNames.length > 0 && (
                                                <Text style={styles.missingList} numberOfLines={3}>
                                                    Nėra: {item.missingItemNames.join(', ')}
                                                </Text>
                                            )}
                                        </View>
                                        <Text style={styles.price}>€{item.total.toFixed(2)}</Text>
                                    </TouchableOpacity>
                                </Animated.View>
                            );
                        }}
                    />
                )}

                {selectedStore && (
                    <Animated.View entering={FadeInDown} style={[styles.bottomBar, bottomInset > 0 && { paddingBottom: 12 + bottomInset }]}>
                        <TouchableOpacity style={styles.navigateButton} onPress={handleNavigate}>
                            <Ionicons name="navigate-outline" size={20} color={colors.primary} />
                            <Text style={styles.navigateText}>Vykti</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.shoppingListButton}
                            onPress={handleCreateShoppingList}
                            disabled={creatingList}
                        >
                            {creatingList ? (
                                <ActivityIndicator size="small" color={colors.onPrimary} />
                            ) : (
                                <Ionicons name="list-outline" size={20} color={colors.onPrimary} />
                            )}
                            <Text style={styles.shoppingListText}>
                                {creatingList ? 'Kuriama…' : 'Pirkinių sąrašas'}
                            </Text>
                        </TouchableOpacity>
                    </Animated.View>
                )}
            </View>
            <LocationPromptModal
                visible={locationPromptVisible}
                onResolved={async (coords) => {
                    setLocationPromptVisible(false);
                    await runRecalcWithCoords(coords);
                }}
                onCancel={() => setLocationPromptVisible(false)}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, backgroundColor: c.pageBackground },
    loadingText: { fontSize: 15, color: c.textSecondary },
    list: { padding: 16, paddingBottom: 100 },
    card: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 16, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08, shadowRadius: 2,
    },
    cardCheapest: { borderWidth: 2, borderColor: c.primary },
    cardClosest: { borderWidth: 2, borderColor: c.info },
    cardSelected: { backgroundColor: c.primaryMuted },
    cheapestBadge: {
        position: 'absolute', top: -8, left: 16,
        backgroundColor: c.primary, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8,
    },
    cheapestBadgeText: { color: c.onPrimary, fontSize: 10, fontWeight: '700' },
    closestBadge: {
        position: 'absolute', top: -8, left: 16,
        backgroundColor: c.info, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8,
    },
    closestBadgeText: { color: c.textInverse, fontSize: 10, fontWeight: '700' },
    cardLeft: { marginRight: 12 },
    logo: { width: 48, height: 48, borderRadius: 8 },
    logoPlaceholder: {
        width: 48, height: 48, borderRadius: 8,
        backgroundColor: c.border, alignItems: 'center', justifyContent: 'center',
    },
    logoPlaceholderText: { fontSize: 20, fontWeight: '700', color: c.textSecondary },
    cardContent: { flex: 1 },
    storeName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 4 },
    distance: { fontSize: 11, color: c.textMuted },
    missingBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        marginLeft: 6,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 8,
        backgroundColor: c.warningMuted,
    },
    missingBadgeText: {
        fontSize: 10,
        color: c.warning,
        fontWeight: '600',
    },
    missingList: {
        marginTop: 4,
        fontSize: 11,
        color: c.textSecondary,
        fontStyle: 'italic',
    },
    // Tier-3 substitute: the store carries a name-similar product, just
    // not the user's exact one. Blue = "decent confidence, something to
    // grab off the shelf".
    substitutedBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        marginLeft: 6,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 8,
        backgroundColor: c.infoMuted,
    },
    substitutedBadgeText: {
        fontSize: 10,
        color: c.info,
        fontWeight: '600',
    },
    approxBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        marginLeft: 6,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 8,
        backgroundColor: c.surfaceMuted,
    },
    approxBadgeText: {
        fontSize: 10,
        color: c.textMuted,
        fontWeight: '600',
    },
    price: { fontSize: 18, fontWeight: '700', color: c.primary, marginLeft: 8 },
    bottomBar: {
        flexDirection: 'row', padding: 12, gap: 10,
        backgroundColor: c.cardBackground, borderTopWidth: 1, borderTopColor: c.border,
    },
    emptyText: { fontSize: 16, color: c.textSecondary },
    shoppingListButton: {
        flex: 2, backgroundColor: c.primary, borderRadius: 12,
        padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    shoppingListText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },
    navigateButton: {
        flex: 1, borderWidth: 1, borderColor: c.primary, borderRadius: 12,
        padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    navigateText: { color: c.primary, fontWeight: '600', fontSize: 15 },

    gateOverlay: {
        flex: 1, alignItems: 'center', justifyContent: 'center',
        padding: 32, gap: 16,
    },
    gateTitle: { fontSize: 20, fontWeight: '700', color: c.textPrimary, textAlign: 'center' },
    gateBody: { fontSize: 14, color: c.textSecondary, textAlign: 'center', lineHeight: 22 },
    gateButton: {
        backgroundColor: c.primary, borderRadius: 10,
        paddingVertical: 12, paddingHorizontal: 24, marginTop: 8,
    },
    gateButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },
});