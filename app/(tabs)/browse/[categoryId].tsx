import { View, FlatList, ScrollView, TouchableOpacity, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../../config/api';
import { Alert } from 'react-native';
import { useBasketState } from '../../../state/basketState';
import { addProductToBasket } from '../../../utils/basketUtils';

interface Category {
    id: number;
    name: string;
}

interface Product {
    id: number;
    name: string;
    brandName: string | null;
}

export default function CategoryScreen() {
    const { categoryId, name } = useLocalSearchParams<{ categoryId: string; name: string }>();
    const [l3Categories, setL3Categories] = useState<Category[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [selectedL3, setSelectedL3] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingProducts, setLoadingProducts] = useState(false);
    const router = useRouter();
    const { draftBasketId, setDraftBasketId } = useBasketState();

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                const subRes = await fetch(`${API_BASE_URL}/api/categories/${categoryId}/subcategories`);
                const subData = await subRes.json();
                setL3Categories(Array.isArray(subData) ? subData : []);

                const prodRes = await fetch(`${API_BASE_URL}/api/categories/${categoryId}/all-products`);
                const prodData = await prodRes.json();
                setProducts(Array.isArray(prodData) ? prodData : []);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [categoryId]);

    const selectL3 = async (l3Id: number | null) => {
        setSelectedL3(l3Id);
        setLoadingProducts(true);
        try {
            const url = l3Id
                ? `${API_BASE_URL}/api/categories/${l3Id}/products`
                : `${API_BASE_URL}/api/categories/${categoryId}/all-products`;
            const res = await fetch(url);
            const data = await res.json();
            setProducts(Array.isArray(data) ? data : []);
        } finally {
            setLoadingProducts(false);
        }
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
                            keyExtractor={item => item.id.toString()}
                            contentContainerStyle={styles.list}
                            ListEmptyComponent={
                                <Text style={styles.emptyText}>Ši kategorija neturi produktų</Text>
                            }
                            renderItem={({ item }) => (
                                <View style={styles.productRow}>
                                    <View style={styles.productIcon}>
                                        <Ionicons name="cube-outline" size={20} color="#bdbdbd" />
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.productName}>{item.name}</Text>
                                        {item.brandName && <Text style={styles.brandText}>{item.brandName}</Text>}
                                    </View>
                                    <TouchableOpacity
                                        onPress={async () => {
                                            const result = await addProductToBasket(item.id, draftBasketId, setDraftBasketId);
                                            Alert.alert(result.success ? 'Pridėta' : 'Klaida', result.message);
                                        }}
                                    >
                                        <Ionicons name="add-circle-outline" size={24} color="#2e7d32" />
                                    </TouchableOpacity>
                                </View>
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
        backgroundColor: 'white',
        borderBottomWidth: 0.5,
        borderBottomColor: '#e0e0e0',
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
        borderColor: '#e0e0e0',
        backgroundColor: 'white',
    },
    bubbleActive: {
        backgroundColor: '#2e7d32',
        borderColor: '#2e7d32',
    },
    bubbleText: {
        fontSize: 13,
        color: '#424242',
    },
    bubbleTextActive: {
        color: 'white',
        fontWeight: '600',
    },
    list: {
        padding: 16,
    },
    productRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'white',
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
    },
    productIcon: {
        width: 36, height: 36, borderRadius: 8,
        backgroundColor: '#f5f5f5',
        alignItems: 'center', justifyContent: 'center',
    },
    productName: { fontSize: 14, color: '#212121', fontWeight: '500' },
    brandText: { fontSize: 12, color: '#9e9e9e', marginTop: 2 },
    emptyText: { textAlign: 'center', padding: 32, fontSize: 15, color: '#757575' },
});