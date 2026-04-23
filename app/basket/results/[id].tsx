import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Alert } from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useMemo, useState, useCallback } from 'react';
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
    const { id } = useLocalSearchParams();
    const router = useRouter();
    const [results, setResults] = useState<StoreResult[]>([]);
    const [loading, setLoading] = useState(true);
    const [visibleCount, setVisibleCount] = useState(0);
    const [selectedStoreId, setSelectedStoreId] = useState<number | null>(null);

    const loadResults = async () => {
        setLoading(true);
        setVisibleCount(0);
        setSelectedStoreId(null);

        let stored = await AsyncStorage.getItem(`basket_results_${id}`);
        let attempts = 0;
        while (!stored && attempts < 30) {
            await new Promise(r => setTimeout(r, 1000));
            stored = await AsyncStorage.getItem(`basket_results_${id}`);
            attempts++;
        }

        if (stored) {
            const parsed = JSON.parse(stored);
            setResults(parsed);
            setLoading(false);
            for (let i = 0; i <= parsed.length; i++) {
                setTimeout(() => setVisibleCount(i), i * 150);
            }
        } else {
            setLoading(false);
        }
    };

    useFocusEffect(useCallback(() => {
        loadResults();
    }, [id]));

    const handleRecalculate = async () => {
        setLoading(true);
        setVisibleCount(0);
        setSelectedStoreId(null);
        try {
            const res = await fetch(`${API_BASE_URL}/api/baskets/${id}/calculate`, {
                method: 'POST',
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

    const handleCreateShoppingList = async () => {
        if (!selectedStore) return;
        try {
            const { getUserId } = await import('../../../config/user');
            const userId = await getUserId();

            const listRes = await fetch(`${API_BASE_URL}/api/shopping-lists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, storeId: selectedStore.storeId, basketId: Number(id) }),
            });
            const listData = await listRes.json();
            const listId = listData.id;

            await Promise.all(selectedStore.items.map(item =>
                fetch(`${API_BASE_URL}/api/list-items`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        listId,
                        productId: item.productId,
                        storeProductId: item.storeProductId || null,
                        quantity: item.storeProductId 
                            ? (item.isWeighable ? item.quantity : item.packsNeeded || item.quantity)
                            : item.quantity,
                        price: item.totalPrice,
                    }),
                })
            ));

            // Navigate only after all items are saved
            router.replace('/(tabs)/shoppingList' as any);
            setTimeout(() => {
                router.push(`/shopping-list/${listId}?expectedCount=${selectedStore.items.length}` as any);
            }, 100);

        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko sukurti pirkinių sąrašo');
        }
    };

    return (
        <>
            <Stack.Screen options={{
                title: 'Palyginimo rezultatai',
                headerRight: () => (
                    <TouchableOpacity onPress={handleRecalculate} style={{ marginRight: 12 }}>
                        <Ionicons name="refresh-outline" size={22} color={colors.primary} />
                    </TouchableOpacity>
                ),
            }} />

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
                    <Animated.View entering={FadeInDown} style={styles.bottomBar}>
                        <TouchableOpacity style={styles.navigateButton} onPress={handleNavigate}>
                            <Ionicons name="navigate-outline" size={20} color={colors.primary} />
                            <Text style={styles.navigateText}>Vykti</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.shoppingListButton} onPress={handleCreateShoppingList}>
                            <Ionicons name="list-outline" size={20} color={colors.onPrimary} />
                            <Text style={styles.shoppingListText}>Pirkinių sąrašas</Text>
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
    approxBadge: {
        backgroundColor: c.warningMuted, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginLeft: 4,
    },
    approxText: { fontSize: 10, color: c.warning },
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