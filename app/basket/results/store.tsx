import { View, Text, FlatList, StyleSheet } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme, type AppTheme } from '../../../constants/theme';

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
}

interface StoreResult {
    storeId: number;
    storeName: string;
    chainName: string;
    total: number;
    isApproximated: boolean;
    missingItemNames: string[];
    items: ItemResult[];
}

export default function StoreBreakdownScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { basketId, storeId } = useLocalSearchParams();
    const [store, setStore] = useState<StoreResult | null>(null);

    useEffect(() => {
        const loadStore = async () => {
            const stored = await AsyncStorage.getItem(`basket_results_${basketId}`);
            if (stored) {
                const results: StoreResult[] = JSON.parse(stored);
                const found = results.find(r => r.storeId === Number(storeId));
                setStore(found || null);
            }
        };
        loadStore();
    }, [basketId, storeId]);

    if (!store) return null;

    return (
        <>
            <Stack.Screen options={{ title: store.storeName }} />
            <FlatList
                data={store.items}
                keyExtractor={item => item.productId.toString()}
                contentContainerStyle={styles.list}
                ListFooterComponent={
                    <View style={styles.totalRow}>
                        <Text style={styles.totalLabel}>
                            Iš viso{store.missingItemNames.length > 0
                                ? ` (be ${store.missingItemNames.length} prekių)`
                                : ''}
                        </Text>
                        <Text style={styles.totalPrice}>€{store.total.toFixed(2)}</Text>
                    </View>
                }
                renderItem={({ item }) => (
                    <View style={styles.card}>
                        <View style={styles.cardContent}>
                            <View style={styles.nameRow}>
                                <Text style={styles.itemName}>{item.productName}</Text>
                                {item.isMissing && (
                                    <View style={styles.approxBadge}>
                                        <Text style={styles.approxText}>Nėra</Text>
                                    </View>
                                )}
                                {item.isFallback && !item.isMissing && (
                                    <View style={styles.fallbackBadge}>
                                        <Text style={styles.fallbackText}>Perkelta</Text>
                                    </View>
                                )}
                            </View>
                            <Text style={styles.quantity}>Kiekis: {item.quantity}</Text>
                        </View>
                        <View style={styles.priceContainer}>
                            {item.promoPrice && (
                                <Text style={styles.originalPrice}>€{item.price?.toFixed(2)}</Text>
                            )}
                            <Text style={styles.price}>
                                {item.effectivePrice !== null ? `€${item.effectivePrice.toFixed(2)}` : '—'}
                            </Text>
                        </View>
                    </View>
                )}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    list: { padding: 16 },
    card: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 16, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08, shadowRadius: 2,
    },
    cardContent: { flex: 1 },
    nameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary, flex: 1 },
    quantity: { fontSize: 12, color: c.textSecondary, marginTop: 4 },
    priceContainer: { alignItems: 'flex-end' },
    originalPrice: { fontSize: 12, color: c.textMuted, textDecorationLine: 'line-through' },
    price: { fontSize: 16, fontWeight: '700', color: c.primary },
    approxBadge: {
        backgroundColor: c.warningMuted, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
    },
    approxText: { fontSize: 10, color: c.warning },
    fallbackBadge: {
        backgroundColor: c.infoMuted, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
    },
    fallbackText: { fontSize: 10, color: c.info },
    totalRow: {
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 16, marginTop: 4,
        elevation: 2,
    },
    totalLabel: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
    totalPrice: { fontSize: 20, fontWeight: '700', color: c.primary },
});