import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, TextInput, Image } from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useState, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { MenuView } from '@react-native-menu/menu';

interface ShoppingList {
    id: number;
    storeId: number;
    storeName: string;
    storeAddress: string;
    chainName: string;
    chainLogoUrl: string | null;
    status: string;
    createdAt: string;
}

interface ShoppingListItem {
    id: number;
    listId: number;
    productId: number | null;
    productName: string;
    quantity: number;
    price: number | null;
    isChecked: boolean;
    customName: string | null;
}

export default function ShoppingListScreen() {
    const { id } = useLocalSearchParams();
    const router = useRouter();
    const [list, setList] = useState<ShoppingList | null>(null);
    const [items, setItems] = useState<ShoppingListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchVisible, setSearchVisible] = useState(false);
    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [customItemName, setCustomItemName] = useState('');
    const [initialLoading, setInitialLoading] = useState(true);
    const [visibleCount, setVisibleCount] = useState(0);
    const [menuVisible, setMenuVisible] = useState(false);

    const fetchList = async () => {
        try {
            const [listRes, itemsRes] = await Promise.all([
                fetch(`${API_BASE_URL}/api/shopping-lists/${id}`),
                fetch(`${API_BASE_URL}/api/shopping-lists/${id}/items`),
            ]);
            const listData = await listRes.json();
            const itemsData = await itemsRes.json();
            setList(listData);
            setItems(Array.isArray(itemsData) ? itemsData : []);
            setVisibleCount(0);
            for (let i = 0; i <= itemsData.length; i++) {
                setTimeout(() => setVisibleCount(i), i * 100);
            }
        } catch (error) {
            console.error('Failed to fetch list:', error);
        } finally {
            setLoading(false);
        }
    };

    useFocusEffect(useCallback(() => {
        let attempts = 0;
        let cancelled = false;

        const fetchList = async () => {
            try {
                const listRes = await fetch(`${API_BASE_URL}/api/shopping-lists/${id}`);
                const listData = await listRes.json();
                setList(listData);
            } catch (error) {
                console.error('Failed to fetch list:', error);
            }
        };

        const pollItems = async () => {
            if (cancelled) return;
            try {
                const res = await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/items`);
                const data = await res.json();

                if (Array.isArray(data) && data.length > 0) {
                    setItems(data);
                    setLoading(false);
                    setVisibleCount(0);
                    for (let i = 0; i <= data.length; i++) {
                        setTimeout(() => setVisibleCount(i), i * 100);
                    }
                } else if (attempts < 20) {
                    attempts++;
                    setTimeout(pollItems, 500);
                } else {
                    setLoading(false);
                }
            } catch (error) {
                console.error('Failed to fetch items:', error);
                setLoading(false);
            }
        };

        fetchList();
        pollItems();

        return () => { cancelled = true; };
    }, [id]));

    const checkedCount = items.filter(i => i.isChecked).length;
    const totalCount = items.length;
    const progress = totalCount > 0 ? checkedCount / totalCount : 0;

    const toggleItem = async (item: ShoppingListItem) => {
        const newChecked = !item.isChecked;
    
        // Update UI immediately
        const updatedItems = items
            .map(i => i.id === item.id ? { ...i, isChecked: newChecked } : i)
            .sort((a, b) => Number(a.isChecked) - Number(b.isChecked));
        setItems(updatedItems);

        // Sync to backend in background
        fetch(`${API_BASE_URL}/api/list-items/${item.id}/toggle`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isChecked: newChecked }),
        }).catch(() => {
            // Revert on failure
            setItems(items);
        });

        // Check if all items are checked
        if (newChecked && updatedItems.every(i => i.isChecked)) {
            Alert.alert(
                'Pirkiniai surinkti!',
                'Ar norite pažymėti sąrašą kaip užbaigtą?',
                [
                    { text: 'Ne', style: 'cancel' },
                    {
                        text: 'Taip',
                        onPress: async () => {
                            await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/status`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ status: 'completed' }),
                            });
                            router.back();
                        }
                    }
                ]
            );
        }
    };

    const removeItem = async (itemId: number) => {
        try {
            await fetch(`${API_BASE_URL}/api/list-items/${itemId}`, { method: 'DELETE' });
            setItems(prev => prev.filter(i => i.id !== itemId));
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko pašalinti produkto');
        }
    };

    const handleSearch = async (query: string) => {
        setSearchQuery(query);
        if (query.length < 2) { setSearchResults([]); return; }
        try {
            const res = await fetch(`${API_BASE_URL}/api/products/search?q=${encodeURIComponent(query)}`);
            const data = await res.json();
            setSearchResults(Array.isArray(data) ? data.slice(0, 5) : []);
        } catch {}
    };

    const addProduct = async (productId: number | null, name: string) => {
        try {
            await fetch(`${API_BASE_URL}/api/list-items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    listId: Number(id),
                    productId,
                    quantity: 1,
                    customName: productId ? null : name,
                }),
            });
            setSearchQuery('');
            setSearchResults([]);
            setSearchVisible(false);
            setCustomItemName('');
            fetchList();
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko pridėti produkto');
        }
    };
    const handleDuplicate = async () => {
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/duplicate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            const data = await res.json();
            const newId = data.id;
            router.dismissAll();
            router.replace('/(tabs)/shoppingList' as any);
            setTimeout(() => {
                router.push(`/shopping-list/${newId}` as any);
            }, 100);
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko nukopijuoti sąrašo');
        }
    };

    if (loading) return <View style={styles.centered}><ActivityIndicator size="large" color="#2e7d32" /></View>;

    return (
        <>
            <Stack.Screen options={{
                title: list?.storeAddress || 'Pirkinių sąrašas',
                headerLeft: () => list?.chainLogoUrl ? (
                    <Image source={{ uri: list.chainLogoUrl }} style={styles.headerLogo} resizeMode="contain" />
                ) : null,
                headerRight: () => list?.status === 'completed' ? (
                    <TouchableOpacity style={{ marginRight: 12 }} onPress={() => setMenuVisible(true)}>
                        <Ionicons name="ellipsis-vertical" size={22} color="#212121" />
                    </TouchableOpacity>
                ) : undefined,
            }} />

            <View style={styles.container}>
                {/* Progress bar */}
                <View style={styles.progressContainer}>
                    <View style={styles.progressBar}>
                        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                    </View>
                    <Text style={styles.progressText}>{checkedCount} iš {totalCount}</Text>
                </View>
                {/* Search overlay */}
                    {searchVisible && (
                        <View style={styles.searchOverlay}>
                            <View style={styles.searchContainer}>
                                <Ionicons name="search" size={18} color="#9e9e9e" />
                                <TextInput
                                    style={styles.searchInput}
                                    placeholder="Ieškoti produkto..."
                                    placeholderTextColor="#9e9e9e"
                                    value={searchQuery}
                                    onChangeText={handleSearch}
                                    autoFocus
                                />
                                <TouchableOpacity onPress={() => { setSearchVisible(false); setSearchQuery(''); setSearchResults([]); }}>
                                    <Ionicons name="close" size={22} color="#757575" />
                                </TouchableOpacity>
                            </View>
                            {searchResults.length > 0 && (
                                <View style={styles.searchResults}>
                                    {searchResults.map(product => (
                                        <TouchableOpacity
                                            key={product.id}
                                            style={styles.searchResultItem}
                                            onPress={() => addProduct(product.id, product.name)}
                                        >
                                            <Text style={styles.searchResultText}>{product.name}</Text>
                                        </TouchableOpacity>
                                    ))}
                                    <TouchableOpacity
                                        style={styles.customItemButton}
                                        onPress={() => addProduct(null, searchQuery)}
                                    >
                                        <Ionicons name="add-circle-outline" size={18} color="#2e7d32" />
                                        <Text style={styles.customItemText}>Pridėti "{searchQuery}" kaip naują prekę</Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                            {searchQuery.length > 0 && searchResults.length === 0 && (
                                <TouchableOpacity
                                    style={styles.customItemButton}
                                    onPress={() => addProduct(null, searchQuery)}
                                >
                                    <Ionicons name="add-circle-outline" size={18} color="#2e7d32" />
                                    <Text style={styles.customItemText}>Pridėti "{searchQuery}" kaip naują prekę</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    )}
                <FlatList
                    data={items.slice(0, visibleCount)}
                    keyExtractor={item => item.id.toString()}
                    contentContainerStyle={styles.list}
                    ListEmptyComponent={
                        <View style={styles.centered}>
                            <Text style={styles.emptyText}>Sąrašas tuščias</Text>
                        </View>
                    }
                    renderItem={({ item, index }) => (
                        <Animated.View entering={FadeInDown.delay(index * 30)}>
                            <TouchableOpacity
                                style={[styles.card, item.isChecked && styles.cardChecked]}
                                onPress={() => toggleItem(item)}
                                onLongPress={() => Alert.alert(
                                    'Pašalinti',
                                    `Pašalinti "${item.productName}" iš sąrašo?`,
                                    [
                                        { text: 'Atšaukti', style: 'cancel' },
                                        { text: 'Pašalinti', style: 'destructive', onPress: () => removeItem(item.id) }
                                    ]
                                )}
                            >
                                <View style={[styles.checkbox, item.isChecked && styles.checkboxChecked]}>
                                    {item.isChecked && <Ionicons name="checkmark" size={14} color="white" />}
                                </View>
                                <View style={styles.cardContent}>
                                    <Text style={[styles.itemName, item.isChecked && styles.itemNameChecked]}>
                                        {item.productName}
                                    </Text>
                                    <Text style={styles.itemQuantity}>Kiekis: {item.quantity}</Text>
                                </View>
                                {item.price && (
                                    <Text style={[styles.itemPrice, item.isChecked && styles.itemPriceChecked]}>
                                        €{item.price.toFixed(2)}
                                    </Text>
                                )}
                            </TouchableOpacity>
                        </Animated.View>
                    )}
                    ListFooterComponent={list?.status === 'active' ? (
                        <TouchableOpacity
                            style={styles.addCard}
                            onPress={() => setSearchVisible(true)}
                        >
                            <View style={styles.addCardInner}>
                                <Ionicons name="add-circle-outline" size={22} color="#2e7d32" />
                                <Text style={styles.addCardText}>Pridėti prekę</Text>
                            </View>
                        </TouchableOpacity>
                    ) : null}
                />
                {menuVisible && (
                    <TouchableOpacity 
                        style={styles.menuOverlay} 
                        onPress={() => setMenuVisible(false)}
                        activeOpacity={1}
                    >
                        <View style={styles.menuContainer}>
                            <TouchableOpacity
                                style={styles.menuItem}
                                onPress={() => {
                                    setMenuVisible(false);
                                    handleDuplicate();
                                }}
                            >
                                <Ionicons name="copy-outline" size={18} color="#212121" />
                                <Text style={styles.menuItemText}>Nukopijuoti sąrašą</Text>
                            </TouchableOpacity>
                        </View>
                    </TouchableOpacity>
                )}
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    headerLogo: { width: 32, height: 32, marginLeft: 8, borderRadius: 6 },
    progressContainer: {
        flexDirection: 'row', alignItems: 'center', padding: 12,
        backgroundColor: 'white', borderBottomWidth: 1, borderBottomColor: '#e0e0e0', gap: 10,
    },
    progressBar: {
        flex: 1, height: 8, backgroundColor: '#e0e0e0', borderRadius: 4, overflow: 'hidden',
    },
    progressFill: { height: '100%', backgroundColor: '#2e7d32', borderRadius: 4 },
    progressText: { fontSize: 13, color: '#757575', minWidth: 50, textAlign: 'right' },
    list: { padding: 16, paddingBottom: 100 },
    card: {
        backgroundColor: 'white', borderRadius: 12, padding: 14, marginBottom: 8,
        flexDirection: 'row', alignItems: 'center', gap: 12,
        elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05, shadowRadius: 2,
    },
    cardChecked: { opacity: 0.6 },
    checkbox: {
        width: 24, height: 24, borderRadius: 12,
        borderWidth: 2, borderColor: '#2e7d32',
        alignItems: 'center', justifyContent: 'center',
    },
    checkboxChecked: { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
    cardContent: { flex: 1 },
    itemName: { fontSize: 14, fontWeight: '600', color: '#212121' },
    itemNameChecked: { textDecorationLine: 'line-through', color: '#9e9e9e' },
    itemQuantity: { fontSize: 12, color: '#757575', marginTop: 2 },
    itemPrice: { fontSize: 15, fontWeight: '700', color: '#2e7d32' },
    itemPriceChecked: { color: '#9e9e9e' },
    addSection: {
        backgroundColor: 'white', borderTopWidth: 1, borderTopColor: '#e0e0e0', padding: 12,
    },
    searchInput: { flex: 1, fontSize: 14, color: '#212121' },
    searchOverlay: {
        backgroundColor: 'white',
        borderBottomWidth: 1,
        borderBottomColor: '#e0e0e0',
        zIndex: 10,
    },
    searchContainer: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        padding: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
    },
    searchResults: {
        maxHeight: 200,
    },
    searchResultItem: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
    searchResultText: { fontSize: 14, color: '#212121' },
    customItemButton: {
        flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12,
    },
    customItemText: { fontSize: 14, color: '#2e7d32' },
    addCard: {
        backgroundColor: 'white', borderRadius: 12, padding: 14, marginBottom: 10,
        borderWidth: 1, borderColor: '#e0e0e0', borderStyle: 'dashed',
        elevation: 1,
    },
    addCardInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
    addCardText: { fontSize: 14, color: '#2e7d32', fontWeight: '600' },
    emptyText: { fontSize: 16, color: '#757575' },

    menuOverlay: {
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 100,
    },
    menuContainer: {
        position: 'absolute', top: 8, right: 12,
        backgroundColor: 'white', borderRadius: 10,
        elevation: 8, shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2, shadowRadius: 4,
        minWidth: 180,
    },
    menuItem: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        padding: 14, borderRadius: 10,
    },
    menuItemText: { fontSize: 14, color: '#212121' },
});