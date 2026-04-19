import { View, FlatList, ScrollView, TouchableOpacity, Text, StyleSheet, ActivityIndicator, Image } from 'react-native';
import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../../config/api';
import { useReceiptPickerState } from '../../../state/basketState';

interface Category {
    id: number;
    name: string;
}

interface StoreProductRow {
    id: number;
    productId: number;
    storeProductName: string;
    brandName: string | null;
    amount: number | null;
    unit: string | null;
    isWeighable: boolean;
    imageUrl: string | null;
    productName: string;
}

export default function ReceiptCategoryScreen() {
    const { categoryId, name, chainId, productIndex, preselectL3 } = useLocalSearchParams<{
        categoryId: string;
        name: string;
        chainId: string;
        productIndex: string;
        preselectL3?: string;
    }>();
    const router = useRouter();
    const { setPendingPick } = useReceiptPickerState();

    const [l3Categories, setL3Categories] = useState<Category[]>([]);
    const [products, setProducts] = useState<StoreProductRow[]>([]);
    const [selectedL3, setSelectedL3] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingProducts, setLoadingProducts] = useState(false);

    useEffect(() => {
        (async () => {
            setLoading(true);
            try {
                const subRes = await fetch(`${API_BASE_URL}/api/categories/${categoryId}/subcategories`);
                const subData = await subRes.json();
                setL3Categories(Array.isArray(subData) ? subData : []);

                // If preselect L3 arrived as param, fetch filtered; otherwise fetch L2 (all descendants)
                const preselId = preselectL3 ? Number(preselectL3) : null;
                if (preselId) setSelectedL3(preselId);
                const targetId = preselId ?? Number(categoryId);
                const prodRes = await fetch(
                    `${API_BASE_URL}/api/categories/${targetId}/store-products?chainId=${chainId}`
                );
                const prodData = await prodRes.json();
                setProducts(Array.isArray(prodData) ? prodData : []);
            } finally {
                setLoading(false);
            }
        })();
    }, [categoryId, preselectL3, chainId]);

    const selectL3 = async (l3Id: number | null) => {
        setSelectedL3(l3Id);
        setLoadingProducts(true);
        try {
            const target = l3Id ?? Number(categoryId);
            const res = await fetch(
                `${API_BASE_URL}/api/categories/${target}/store-products?chainId=${chainId}`
            );
            const data = await res.json();
            setProducts(Array.isArray(data) ? data : []);
        } finally {
            setLoadingProducts(false);
        }
    };

    const handlePick = (sp: StoreProductRow) => {
        setPendingPick({
            productIndex: Number(productIndex),
            storeProductId: sp.id,
            productId: sp.productId,
            storeProductName: sp.storeProductName,
            imageUrl: sp.imageUrl,
            amount: sp.amount,
            unit: sp.unit,
        });
        // Pop back twice: [categoryId] → receipt/browse → receipt-process
        router.back();
        router.back();
    };

    if (loading) return <ActivityIndicator style={styles.centered} size="large" color="#2e7d32" />;

    return (
        <>
            <Stack.Screen options={{ title: decodeURIComponent(name || '') }} />
            <View style={styles.container}>
                {l3Categories.length > 0 && (
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.bubblesContainer}
                        style={styles.bubblesRow}
                    >
                        <TouchableOpacity
                            style={[styles.bubble, selectedL3 === null && styles.bubbleActive]}
                            onPress={() => selectL3(null)}
                        >
                            <Text style={[styles.bubbleText, selectedL3 === null && styles.bubbleTextActive]}>
                                Visi produktai
                            </Text>
                        </TouchableOpacity>
                        {l3Categories.map(cat => (
                            <TouchableOpacity
                                key={cat.id}
                                style={[styles.bubble, selectedL3 === cat.id && styles.bubbleActive]}
                                onPress={() => selectL3(cat.id)}
                            >
                                <Text style={[styles.bubbleText, selectedL3 === cat.id && styles.bubbleTextActive]}>
                                    {cat.name}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </ScrollView>
                )}

                <View style={{ flex: 1 }}>
                    {loadingProducts ? (
                        <ActivityIndicator style={styles.centered} size="large" color="#2e7d32" />
                    ) : (
                        <FlatList
                            data={products}
                            keyExtractor={item => String(item.id)}
                            contentContainerStyle={styles.list}
                            numColumns={2}
                            columnWrapperStyle={styles.row}
                            ListEmptyComponent={
                                <Text style={styles.emptyText}>Ši kategorija neturi produktų</Text>
                            }
                            renderItem={({ item }) => (
                                <TouchableOpacity
                                    style={styles.productCard}
                                    onPress={() => handlePick(item)}
                                    activeOpacity={0.7}
                                >
                                    <View style={styles.productImageContainer}>
                                        {item.imageUrl ? (
                                            <Image source={{ uri: item.imageUrl }} style={styles.productImage} resizeMode="contain" />
                                        ) : (
                                            <Ionicons name="cube-outline" size={40} color="#e0e0e0" />
                                        )}
                                    </View>
                                    <View style={styles.productInfo}>
                                        <Text style={styles.productName} numberOfLines={3}>
                                            {item.storeProductName}
                                        </Text>
                                        {item.amount !== null && item.unit && (
                                            <Text style={styles.amountText}>
                                                {item.amount} {item.unit}
                                            </Text>
                                        )}
                                    </View>
                                </TouchableOpacity>
                            )}
                        />
                    )}
                </View>
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    bubblesRow: {
        backgroundColor: 'white', borderBottomWidth: 0.5, borderBottomColor: '#e0e0e0',
        flexGrow: 0, flexShrink: 0,
    },
    bubblesContainer: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
    bubble: {
        paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
        borderWidth: 1, borderColor: '#e0e0e0', backgroundColor: 'white',
    },
    bubbleActive: { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
    bubbleText: { fontSize: 13, color: '#424242' },
    bubbleTextActive: { color: 'white', fontWeight: '600' },
    list: { padding: 12 },
    row: { gap: 12, marginBottom: 12 },
    productCard: {
        backgroundColor: 'white', borderRadius: 12, padding: 12,
        alignItems: 'center', elevation: 1,
        shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05, shadowRadius: 2,
        flex: 1, maxWidth: '50%',
    },
    productImageContainer: {
        width: '100%', height: 130, alignItems: 'center', justifyContent: 'center', marginBottom: 8,
    },
    productImage: { width: '100%', height: '100%' },
    productInfo: { flex: 1, width: '100%' },
    productName: { fontSize: 13, color: '#212121', lineHeight: 18 },
    amountText: { fontSize: 12, color: '#9e9e9e', marginTop: 2 },
    emptyText: { textAlign: 'center', padding: 32, fontSize: 15, color: '#757575' },
});