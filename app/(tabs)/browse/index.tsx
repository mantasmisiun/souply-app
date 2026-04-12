import { View, FlatList, TouchableOpacity, Text, StyleSheet, ActivityIndicator, TextInput } from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../../config/api';
import { useBasketState } from '../../../state/basketState';
import { addProductToBasket } from '../../../utils/basketUtils';
import { Alert } from 'react-native';

interface Category {
    id: number;
    name: string;
    parentCategoryId: number | null;
}

interface Product {
    id: number;
    name: string;
    categoryId: number;
}

export default function BrowseIndex() {
    const [categories, setCategories] = useState<Category[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchVisible, setSearchVisible] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searching, setSearching] = useState(false);
    const router = useRouter();
    const { draftBasketId, setDraftBasketId } = useBasketState();

    useEffect(() => {
        fetch(`${API_BASE_URL}/api/categories`)
            .then(r => r.json())
            .then(setCategories)
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        if (!searchQuery.trim()) {
            setProducts([]);
            return;
        }
        const timeout = setTimeout(async () => {
            setSearching(true);
            try {
                const res = await fetch(`${API_BASE_URL}/api/products/search?q=${encodeURIComponent(searchQuery)}`);
                const data = await res.json();
                setProducts(Array.isArray(data) ? data : []);
            } finally {
                setSearching(false);
            }
        }, 400);
        return () => clearTimeout(timeout);
    }, [searchQuery]);

    const closeSearch = () => {
        setSearchVisible(false);
        setSearchQuery('');
        setProducts([]);
    };

    if (loading) return <ActivityIndicator style={styles.centered} size="large" color="#2e7d32" />;

    return (
        <>
            <Stack.Screen
                options={{
                    title: searchVisible ? '' : 'Naršyti',
                    headerRight: () => (
                        <TouchableOpacity onPress={() => setSearchVisible(!searchVisible)} style={{ marginRight: 12 }}>
                            <Ionicons name={searchVisible ? 'close' : 'search'} size={24} color="#2e7d32" />
                        </TouchableOpacity>
                    ),
                    headerTitle: searchVisible ? () => (
                        <TextInput
                            autoFocus
                            placeholder="Ieškoti produktų..."
                            placeholderTextColor="#9e9e9e"
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                            style={styles.searchInput}
                        />
                    ) : undefined,
                }}
            />

            {searchVisible ? (
                searching ? (
                    <ActivityIndicator style={styles.centered} size="large" color="#2e7d32" />
                ) : (
                    <FlatList
                        data={products}
                        keyExtractor={item => item.id.toString()}
                        contentContainerStyle={styles.list}
                        ListEmptyComponent={
                            <Text style={styles.emptyText}>
                                {searchQuery.trim() ? 'Produktų nerasta' : 'Įveskite paieškos tekstą'}
                            </Text>
                        }
                        renderItem={({ item }) => (
                            <View style={styles.card}>
                                <Ionicons name="cube-outline" size={24} color="#2e7d32" style={{ marginRight: 12 }} />
                                <Text style={styles.cardText}>{item.name}</Text>
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
                )
            ) : (
                <FlatList
                    data={categories}
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
    emptyText: { textAlign: 'center', padding: 32, fontSize: 15, color: '#757575' },
    searchInput: { fontSize: 16, flex: 1, color: '#757575' },
    addButton: { padding: 4 },
});