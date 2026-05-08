import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect, useNavigation, Stack } from 'expo-router';
import { useMemo, useState, useCallback, useLayoutEffect } from 'react';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import { API_BASE_URL } from '../../../config/api';
import { useTheme, type AppTheme } from '../../../constants/theme';

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
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();
    const { id } = useLocalSearchParams();
    const router = useRouter();
    const navigation = useNavigation();
    const [results, setResults] = useState<StoreResult[]>([]);
    const [loading, setLoading] = useState(true);
    const [visibleCount, setVisibleCount] = useState(0);
    const [selectedStoreId, setSelectedStoreId] = useState<number | null>(null);

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

    useFocusEffect(useCallback(() => {
        // Re-fetch on every focus so a revert-to-draft from the detail
        // screen (which wipes the AsyncStorage cache) is reflected here
        // the moment the user navigates back in.
        loadResults();
    }, [id]));

    const handleRecalculate = async () => {
        setLoading(true);
        setVisibleCount(0);
        setSelectedStoreId(null);
        try {
            // Recalc uses the previously-cached coordinates so the user
            // doesn't get re-prompted for location on every refresh.
            // Falls back silently to the backend's Vilnius default if the
            // cache is empty (edge case: fresh install recalcing a pre-
            // existing basket).
            const { loadCachedCoords } = await import('../../../utils/location');
            const coords = await loadCachedCoords();
            const res = await fetch(`${API_BASE_URL}/api/baskets/${id}/calculate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(coords ? { lat: coords.lat, lng: coords.lng } : {}),
            });
            const newResults = await res.json();
            await AsyncStorage.setItem(`basket_results_${id}`, JSON.stringify(newResults));
            setResults(newResults);
            setLoading(false);
            for (let i = 0; i <= newResults.length; i++) {
                setTimeout(() => setVisibleCount(i), i * 150);
            }
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko perskaičiuoti');
            setLoading(false);
        }
    };

    // Imperative header config. The declarative <Stack.Screen options> has
    // flaky timing when this route is reached from a cached AsyncStorage
    // load — the header commits before the screen's options apply, so the
    // refresh button blinks in and out. `useLayoutEffect` + setOptions
    // runs synchronously before paint so the button is always there.
    useLayoutEffect(() => {
        navigation.setOptions({
            title: 'Palyginimo rezultatai',
            headerRight: () => (
                <TouchableOpacity onPress={handleRecalculate} style={{ marginRight: 12 }}>
                    <Ionicons name="refresh-outline" size={22} color={colors.primary} />
                </TouchableOpacity>
            ),
        });
        // handleRecalculate reference changes every render; that's fine,
        // setOptions is cheap.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    });

    const closestStoreId = results.length > 0
        ? [...results].sort((a, b) => a.distance - b.distance)[0].storeId
        : null;
    const cheapestStoreId = results.length > 0 ? results[0].storeId : null;
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
            <Stack.Screen
                options={{
                    title: 'Palyginimo rezultatai',
                    headerRight: () => (
                        <TouchableOpacity onPress={handleRecalculate} style={{ marginRight: 12 }}>
                            <Ionicons name="refresh-outline" size={22} color={colors.primary} />
                        </TouchableOpacity>
                    ),
                }}
            />
            <View style={styles.container}>
                {loading ? (
                    <Animated.View entering={FadeIn} style={styles.loadingContainer}>
                        <ActivityIndicator size="large" color={colors.primary} />
                        <Text style={styles.loadingText}>Skaičiuojamos kainos...</Text>
                    </Animated.View>
                ) : (
                    <FlatList
                        data={results.slice(0, visibleCount)}
                        keyExtractor={item => item.storeId.toString()}
                        contentContainerStyle={styles.list}
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
                                                        <Ionicons name="alert-circle-outline" size={11} color={colors.warning} />
                                                        <Text style={styles.missingBadgeText}>
                                                            Trūksta {item.missingItemNames.length} {pluralizePrekes(item.missingItemNames.length)}
                                                        </Text>
                                                    </View>
                                                )}
                                                {item.items.some(i => i.isSubstituted) && (
                                                    // Tier-3: a name-similar variant was found in THIS
                                                    // chain — user would physically grab that product.
                                                    <View style={styles.substitutedBadge}>
                                                        <Text style={styles.substitutedBadgeText}>
                                                            Panašus produktas
                                                        </Text>
                                                    </View>
                                                )}
                                                {item.items.some(i => i.isCrossChainAverage) && (
                                                    // Tier-4: no in-chain candidate passed the similarity
                                                    // gate, so the price was estimated from other chains'
                                                    // stores. Lower confidence — muted styling.
                                                    <View style={styles.approxBadge}>
                                                        <Text style={styles.approxBadgeText}>
                                                            Apytikslė kaina
                                                        </Text>
                                                    </View>
                                                )}
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
    // Tier-4 cross-chain average: the price is an estimate, the store
    // doesn't actually carry anything close. Muted = "take with salt".
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
});