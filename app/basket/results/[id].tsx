import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface ItemResult {
    productId: number;
    productName: string;
    quantity: number;
    price: number | null;
    promoPrice: number | null;
    effectivePrice: number | null;
    isApproximated: boolean;
    isFallback: boolean;
}

interface StoreResult {
    storeId: number;
    storeName: string;
    chainName: string;
    chainId: number;
    distance: number;
    total: number;
    isApproximated: boolean;
    items: ItemResult[];
}

export default function BasketResultsScreen() {
    const { id } = useLocalSearchParams();
    const router = useRouter();
    const [results, setResults] = useState<StoreResult[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadResults = async () => {
            try {
                const stored = await AsyncStorage.getItem(`basket_results_${id}`);
                if (stored) {
                    setResults(JSON.parse(stored));
                }
            } catch (error) {
                console.error('Failed to load results:', error);
            } finally {
                setLoading(false);
            }
        };
        loadResults();
    }, [id]);

    if (loading) return <View style={styles.centered}><ActivityIndicator size="large" color="#2e7d32" /></View>;

    return (
        <>
            <Stack.Screen options={{ title: 'Palyginimo rezultatai' }} />
            <FlatList
                data={results}
                keyExtractor={item => item.storeId.toString()}
                contentContainerStyle={styles.list}
                ListEmptyComponent={
                    <View style={styles.centered}>
                        <Text style={styles.emptyText}>Rezultatų nėra</Text>
                    </View>
                }
                renderItem={({ item, index }) => (
                    <TouchableOpacity
                        style={[styles.card, index === 0 && styles.cardFirst]}
                        onPress={() => router.push(`/basket/results/store?basketId=${id}&storeId=${item.storeId}`)}
                    >
                        {index === 0 && (
                            <View style={styles.bestBadge}>
                                <Text style={styles.bestBadgeText}>Pigiausia</Text>
                            </View>
                        )}
                        <View style={styles.cardLeft}>
                            <Text style={styles.rank}>#{index + 1}</Text>
                        </View>
                        <View style={styles.cardContent}>
                            <Text style={styles.storeName}>{item.storeName}</Text>
                            <Text style={styles.chainName}>{item.chainName}</Text>
                            <View style={styles.metaRow}>
                                <Ionicons name="location-outline" size={12} color="#9e9e9e" />
                                <Text style={styles.distance}>{item.distance} km</Text>
                                {item.isApproximated && (
                                    <View style={styles.approxBadge}>
                                        <Text style={styles.approxText}>Apytikslė kaina</Text>
                                    </View>
                                )}
                            </View>
                        </View>
                        <View style={styles.priceContainer}>
                            <Text style={styles.price}>€{item.total.toFixed(2)}</Text>
                            <Ionicons name="chevron-forward" size={16} color="#757575" />
                        </View>
                    </TouchableOpacity>
                )}
            />
        </>
    );
}

const styles = StyleSheet.create({
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16 },
    card: {
        backgroundColor: 'white', borderRadius: 12, padding: 16, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1, shadowRadius: 2,
    },
    cardFirst: {
        borderWidth: 2, borderColor: '#2e7d32',
    },
    bestBadge: {
        position: 'absolute', top: -8, left: 16,
        backgroundColor: '#2e7d32', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8,
    },
    bestBadgeText: { color: 'white', fontSize: 10, fontWeight: '700' },
    cardLeft: { marginRight: 12 },
    rank: { fontSize: 18, fontWeight: '700', color: '#9e9e9e', minWidth: 28 },
    cardContent: { flex: 1 },
    storeName: { fontSize: 14, fontWeight: '600', color: '#212121' },
    chainName: { fontSize: 12, color: '#757575', marginTop: 2 },
    metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 4 },
    distance: { fontSize: 11, color: '#9e9e9e' },
    approxBadge: {
        backgroundColor: '#fff3e0', paddingHorizontal: 6, paddingVertical: 2,
        borderRadius: 6, marginLeft: 8,
    },
    approxText: { fontSize: 10, color: '#e65100' },
    priceContainer: { alignItems: 'flex-end', flexDirection: 'row', gap: 4 },
    price: { fontSize: 18, fontWeight: '700', color: '#2e7d32' },
    emptyText: { fontSize: 16, color: '#757575' },
});