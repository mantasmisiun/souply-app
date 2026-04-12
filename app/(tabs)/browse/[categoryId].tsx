import { View, FlatList, TouchableOpacity, Text, StyleSheet, ActivityIndicator } from 'react-native';
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
    const [subcategories, setSubcategories] = useState<Category[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [isL3, setIsL3] = useState(false);
    const [loading, setLoading] = useState(true);
    const router = useRouter();
    const { draftBasketId, setDraftBasketId } = useBasketState();

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                const subRes = await fetch(`${API_BASE_URL}/api/categories/${categoryId}/subcategories`);
                const subData = await subRes.json();

                if (!Array.isArray(subData) || subData.length === 0) {
                    setIsL3(true);
                    const prodRes = await fetch(`${API_BASE_URL}/api/categories/${categoryId}/products`);
                    const prodData = await prodRes.json();
                    setProducts(Array.isArray(prodData) ? prodData : []);
                } else {
                    setSubcategories(subData);
                }
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [categoryId]);

    if (loading) return <ActivityIndicator style={styles.centered} size="large" color="#2e7d32" />;

    return (
        <>
            <Stack.Screen options={{ title: decodeURIComponent(name || '') }} />
            {isL3 ? (
                <FlatList
                    data={products}
                    keyExtractor={item => item.id.toString()}
                    contentContainerStyle={styles.list}
                    ListEmptyComponent={
                        <Text style={styles.emptyText}>Ši kategorija pakolkas neturi produktų</Text>
                    }
                    renderItem={({ item }) => (
                        <View style={styles.card}>
                            <Ionicons name="cube-outline" size={24} color="#2e7d32" style={{ marginRight: 12 }} />
                            <View style={{ flex: 1 }}>
                                <Text style={styles.cardText}>{item.name}</Text>
                                {item.brandName && <Text style={styles.brandText}>{item.brandName}</Text>}
                            </View>
                            <TouchableOpacity
                                style={styles.addButton}
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
            ) : (
                <FlatList
                    data={subcategories}
                    keyExtractor={item => item.id.toString()}
                    contentContainerStyle={styles.list}
                    renderItem={({ item }) => (
                        <TouchableOpacity
                            style={styles.card}
                            onPress={() => router.push(`/browse/${item.id}?name=${encodeURIComponent(item.name)}`)}
                        >
                            <Text style={styles.cardText}>{item.name}</Text>
                            <Ionicons name="chevron-forward" size={20} color="#757575" />
                        </TouchableOpacity>
                    )}
                />
            )}
        </>
    );
}

const styles = StyleSheet.create({
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    list: { padding: 16 },
    card: {
        backgroundColor: 'white', borderRadius: 12, padding: 16, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1, shadowRadius: 2,
    },
    cardText: { fontSize: 15, color: '#212121', flex: 1 },
    brandText: { fontSize: 12, color: '#757575', marginTop: 2 },
    emptyText: { textAlign: 'center', padding: 32, fontSize: 15, color: '#757575' },
    addButton: { padding: 4 },
});