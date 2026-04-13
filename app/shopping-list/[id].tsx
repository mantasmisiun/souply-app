import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, TextInput, Image, Keyboard, Platform  } from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useState, useCallback, useEffect, useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import ReanimatedSwipeable, { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

interface ShoppingList {
    id: number;
    storeId: number;
    storeName: string;
    storeAddress: string;
    chainName: string;
    chainId: number;
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
    imageUrl: string | null;
    isWeighable: boolean;
}
function ShoppingListItemCard({ item, onToggle, onRemove }: {
    item: ShoppingListItem;
    onToggle: (item: ShoppingListItem) => void;
    onRemove: (id: number) => void;
}) {
    const swipeableRef = useRef<SwipeableMethods>(null);

    const handleSwipeOpen = (direction: 'left' | 'right') => {
        if (direction === 'left') {
            swipeableRef.current?.close();
            Alert.alert(
                'Pašalinti',
                `Pašalinti "${item.productName}" iš sąrašo?`,
                [
                    { text: 'Atšaukti', style: 'cancel' as const },
                    { text: 'Pašalinti', style: 'destructive' as const, onPress: () => onRemove(item.id) },
                ]
            );
        }
    };

    const rightActions = () => (
        <View style={styles.deleteAction}>
            <Ionicons name="trash-outline" size={24} color="white" />
            <Text style={styles.actionText}>Ištrinti</Text>
        </View>
    );

    return (
        <View style={{ paddingHorizontal: 2, overflow: 'visible' }}>
            <ReanimatedSwipeable
                ref={swipeableRef}
                renderRightActions={rightActions}
                overshootRight={false}
                friction={3}
                activeOffsetX={[-20, 20]}
                failOffsetY={[-10, 10]}
                rightThreshold={40}
                onSwipeableOpen={handleSwipeOpen}
            >
                <TouchableOpacity
                    style={[styles.card, item.isChecked && styles.cardChecked]}
                    onPress={() => onToggle(item)}
                >
                    <View style={styles.imageContainer}>
                        {item.isChecked ? (
                            <View style={styles.checkmarkContainer}>
                                <Ionicons name="checkmark" size={24} color="white" />
                            </View>
                        ) : item.imageUrl ? (
                            <Image
                                source={{ uri: item.imageUrl }}
                                style={styles.productImage}
                                resizeMode="contain"
                            />
                        ) : (
                            <View style={styles.imagePlaceholder}>
                                <Ionicons name="cube-outline" size={22} color="#bdbdbd" />
                            </View>
                        )}
                    </View>
                    <View style={styles.cardContent}>
                        <Text style={[styles.itemName, item.isChecked && styles.itemNameChecked]}>
                            {item.productName}
                        </Text>
                        <Text style={styles.itemQuantity}>
                            Kiekis: {item.quantity} {item.isWeighable ? 'kg' : 'vnt.'}
                        </Text>
                    </View>
                    {item.price && (
                        <Text style={[styles.itemPrice, item.isChecked && styles.itemPriceChecked]}>
                            €{item.price.toFixed(2)}
                        </Text>
                    )}
                </TouchableOpacity>
            </ReanimatedSwipeable>
        </View>
    );
}
export default function ShoppingListScreen() {
    const router = useRouter();
    const [list, setList] = useState<ShoppingList | null>(null);
    const [items, setItems] = useState<ShoppingListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchVisible, setSearchVisible] = useState(false);
    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [visibleCount, setVisibleCount] = useState(0);
    const [menuVisible, setMenuVisible] = useState(false);
    const { id, expectedCount } = useLocalSearchParams<{ id: string; expectedCount: string }>();
    const [quantityModal, setQuantityModal] = useState<{ productId: number | null; name: string; isWeighable: boolean } | null>(null);
    const [quantityInput, setQuantityInput] = useState('1');
    const [modalIsWeighable, setModalIsWeighable] = useState(false);
    const [keyboardHeight, setKeyboardHeight] = useState(0);
    useEffect(() => {
        const show = Keyboard.addListener('keyboardDidShow', e => setKeyboardHeight(e.endCoordinates.height));
        const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
        return () => { show.remove(); hide.remove(); };
    }, []);
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

        const expected = expectedCount ? parseInt(expectedCount) : 0;

        const pollItems = async () => {
            if (cancelled) return;
            try {
                const res = await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/items`);
                const data = await res.json();

                if (Array.isArray(data) && (data.length >= expected || attempts >= 20)) {
                    setItems(data.sort((a: any, b: any) => Number(a.isChecked) - Number(b.isChecked)));
                    setLoading(false);
                    setVisibleCount(0);
                    for (let i = 0; i <= data.length; i++) {
                        setTimeout(() => setVisibleCount(i), i * 100);
                    }
                } else {
                    attempts++;
                    setTimeout(pollItems, 500);
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

        const updatedItems = items
            .map(i => i.id === item.id ? { ...i, isChecked: newChecked } : i)
            .sort((a, b) => Number(a.isChecked) - Number(b.isChecked));
        setItems(updatedItems);

        fetch(`${API_BASE_URL}/api/list-items/${item.id}/toggle`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isChecked: newChecked }),
        }).catch(() => {
            setItems(items);
        });

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
    const promptQuantity = (productId: number | null, name: string, isWeighable: boolean) => {
        setModalIsWeighable(isWeighable);
        setQuantityInput(isWeighable ? '0.5' : '1');
        setQuantityModal({ productId, name, isWeighable });
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
            const res = await fetch(`${API_BASE_URL}/api/store-products/search?name=${encodeURIComponent(query)}&chainId=${list?.chainId}`);
            const data = await res.json();
            setSearchResults(Array.isArray(data) ? data.slice(0, 5) : []);
        } catch {}
    };

    const addProduct = async (productId: number | null, name: string, quantity: number, isWeighable: boolean) => {
        const existing = items.find(i => i.productId === productId && productId !== null);
        if (existing) {
            Alert.alert('Jau sąraše', `"${name}" jau yra pirkinių sąraše`);
            return;
        }
        try {
            const res = await fetch(`${API_BASE_URL}/api/list-items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    listId: Number(id),
                    productId,
                    quantity,
                    customName: productId ? null : name,
                }),
            });
            const data = await res.json();

            const newItem: ShoppingListItem = {
                id: data.id,
                listId: Number(id),
                productId,
                productName: name,
                quantity,
                price: null,
                isChecked: false,
                customName: productId ? null : name,
                imageUrl: null,
                isWeighable,
            };
            setItems(prev => [...prev, newItem]);
            setVisibleCount(prev => prev + 1);
            setSearchQuery('');
            setSearchResults([]);
            setSearchVisible(false);
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
        <GestureHandlerRootView style={{ flex: 1 }}>
            <>
                <Stack.Screen options={{
                    title: list?.storeAddress || 'Pirkinių sąrašas',
                    headerLeft: () => list?.chainLogoUrl ? (
                        <Image source={{ uri: list.chainLogoUrl }} style={styles.headerLogo} resizeMode="contain" />
                    ) : null,
                    headerRight: () => list?.status === 'completed' ? (
                        <TouchableOpacity style={{ marginRight: 12 }} onPress={() => setMenuVisible(true)}>
                            <Ionicons name="ellipsis-vertical" size={22} color="#9e9e9e" />
                        </TouchableOpacity>
                    ) : undefined,
                }} />

                <View style={styles.container}>
                    <View style={styles.progressContainer}>
                        <View style={styles.progressBar}>
                            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                        </View>
                        <Text style={styles.progressText}>{checkedCount} iš {totalCount}</Text>
                    </View>

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
                                <ScrollView
                                    style={styles.searchResults}
                                    keyboardShouldPersistTaps="handled"
                                >
                                    {searchResults.map((product, index) => {
                                        const alreadyInList = items.some(i => i.productId === product.productId);
                                        return (
                                            <TouchableOpacity
                                                key={`${product.id}-${index}`}
                                                style={styles.searchResultItem}
                                                onPress={() => {
                                                    if (alreadyInList) {
                                                        Alert.alert('Jau sąraše', `"${product.storeProductName}" jau yra pirkinių sąraše`);
                                                        return;
                                                    }
                                                    promptQuantity(product.productId, product.storeProductName, product.isWeighable === 1 || product.isWeighable === true);
                                                }}
                                            >
                                                {alreadyInList && (
                                                    <Ionicons name="checkmark-circle" size={18} color="#2e7d32" style={{ marginRight: 8 }} />
                                                )}
                                                <Text style={styles.searchResultText}>{product.storeProductName}</Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                    <TouchableOpacity
                                        style={styles.customItemButton}
                                        onPress={() => promptQuantity(null, searchQuery, false)}
                                    >
                                        <Ionicons name="add-circle-outline" size={18} color="#2e7d32" />
                                        <Text style={styles.customItemText}>Pridėti "{searchQuery}" kaip naują prekę</Text>
                                    </TouchableOpacity>
                                </ScrollView>
                            )}
                            {searchQuery.length > 0 && searchResults.length === 0 && (
                                <TouchableOpacity
                                    style={styles.customItemButton}
                                    onPress={() => promptQuantity(null, searchQuery, false)}
                                >
                                    <Ionicons name="add-circle-outline" size={18} color="#2e7d32" />
                                    <Text style={styles.customItemText}>Pridėti "{searchQuery}" kaip naują prekę</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    )}
                    <ScrollView contentContainerStyle={styles.list}>
                        {items.slice(0, visibleCount).length > 0 && (
                            <View style={styles.listContainer}>
                                {items.slice(0, visibleCount).map((item, index) => (
                                    <Animated.View key={item.id} entering={FadeInDown.delay(index * 30)}>
                                        {index > 0 && <View style={styles.divider} />}
                                        <ShoppingListItemCard
                                            item={item}
                                            onToggle={toggleItem}
                                            onRemove={removeItem}
                                        />
                                    </Animated.View>
                                ))}
                            </View>
                        )}
                        {items.length === 0 && (
                            <View style={styles.centered}>
                                <Text style={styles.emptyText}>Sąrašas tuščias</Text>
                            </View>
                        )}
                        {list?.status === 'active' && (
                            <TouchableOpacity
                                style={styles.addCard}
                                onPress={() => setSearchVisible(true)}
                            >
                                <View style={styles.addCardInner}>
                                    <Ionicons name="add-circle-outline" size={22} color="#2e7d32" />
                                    <Text style={styles.addCardText}>Pridėti prekę</Text>
                                </View>
                            </TouchableOpacity>
                        )}
                    </ScrollView>

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
                {quantityModal && (
                    <View style={[styles.modalOverlay, { paddingBottom: keyboardHeight }]}>
                        <TouchableOpacity
                            style={StyleSheet.absoluteFillObject}
                            activeOpacity={1}
                            onPress={() => setQuantityModal(null)}
                        />
                        <View style={styles.modalContainer}>
                            <Text style={styles.modalTitle}>{quantityModal.name}</Text>

                            {quantityModal.productId === null && (
                                <TouchableOpacity
                                    style={styles.weighableRow}
                                    onPress={() => {
                                        const next = !modalIsWeighable;
                                        setModalIsWeighable(next);
                                        setQuantityInput(next ? '0.5' : '1');
                                    }}
                                >
                                    <View style={[styles.checkbox, modalIsWeighable ? styles.checkboxChecked : null]}>
                                        {modalIsWeighable ? <Ionicons name="checkmark" size={14} color="white" /> : null}
                                    </View>
                                    <Text style={styles.weighableLabel}>Sveriamas</Text>
                                </TouchableOpacity>
                            )}

                            <Text style={styles.modalLabel}>
                                {modalIsWeighable ? 'Kiekis (kg)' : 'Kiekis (vnt.)'}
                            </Text>
                            <TextInput
                                style={styles.modalInput}
                                value={quantityInput}
                                onChangeText={(text) => {
                                    if (modalIsWeighable) {
                                        if (/^\d*\.?\d*$/.test(text)) setQuantityInput(text);
                                    } else {
                                        if (/^\d*$/.test(text)) setQuantityInput(text);
                                    }
                                }}
                                keyboardType={modalIsWeighable ? 'decimal-pad' : 'number-pad'}
                                selectTextOnFocus
                                autoFocus
                            />
                            <View style={styles.modalButtons}>
                                <TouchableOpacity
                                    style={styles.modalCancel}
                                    onPress={() => setQuantityModal(null)}
                                >
                                    <Text style={styles.modalCancelText}>Atšaukti</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.modalConfirm}
                                    onPress={() => {
                                        const qty = parseFloat(quantityInput);
                                        if (!qty || qty <= 0) {
                                            Alert.alert('Klaida', 'Įveskite teisingą kiekį');
                                            return;
                                        }
                                        const modal = quantityModal;
                                        setQuantityModal(null);
                                        addProduct(modal.productId, modal.name, qty, modalIsWeighable);
                                    }}
                                >
                                    <Text style={styles.modalConfirmText}>Pridėti</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                )}
            </>
        </GestureHandlerRootView>
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
    progressBar: { flex: 1, height: 8, backgroundColor: '#e0e0e0', borderRadius: 4, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: '#2e7d32', borderRadius: 4 },
    progressText: { fontSize: 13, color: '#757575', minWidth: 50, textAlign: 'right' },
list: {
    paddingTop: 16,
    paddingBottom: 100,
},
listContainer: {
    backgroundColor: 'white',
    marginBottom: 10,
    elevation: 1,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 2,
},
card: {
    backgroundColor: 'white',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
},
    divider: {
        height: 0.5,
        backgroundColor: '#e0e0e0',
        marginLeft: 68,
    },

    cardChecked: {
        opacity: 0.5,
    },
    imageContainer: {
        width: 40, height: 40, flexShrink: 0,
    },
    productImage: {
        width: 40, height: 40, borderRadius: 8,
    },
    imagePlaceholder: {
        width: 40, height: 40, borderRadius: 8,
        backgroundColor: '#f0faf0', alignItems: 'center', justifyContent: 'center',
    },
    checkmarkContainer: {
        width: 40, height: 40, borderRadius: 8,
        backgroundColor: '#2e7d32', alignItems: 'center', justifyContent: 'center',
    },
    cardContent: { flex: 1 },
    itemName: { fontSize: 14, fontWeight: '600', color: '#212121' },
    itemNameChecked: { textDecorationLine: 'line-through', color: '#9e9e9e' },
    itemQuantity: { fontSize: 12, color: '#757575', marginTop: 2 },
    itemPrice: { fontSize: 14, fontWeight: '500', color: '#2e7d32' },
    itemPriceChecked: { color: '#9e9e9e' },
    searchInput: { flex: 1, fontSize: 14, color: '#212121' },
    searchOverlay: {
        backgroundColor: 'white',
        borderBottomWidth: 1,
        borderBottomColor: '#e0e0e0',
        zIndex: 10,
        maxHeight: 400,
    },
    searchResults: {
        maxHeight: 250,
    },
    searchContainer: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        padding: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
    },
    searchResultItem: {
        padding: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
        flexDirection: 'row', alignItems: 'center',
    },
    searchResultText: { fontSize: 14, color: '#212121' },
    customItemButton: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
    customItemText: { fontSize: 14, color: '#2e7d32' },
    addCard: {
        backgroundColor: 'white', borderRadius: 12, padding: 14, marginBottom: 10,
        borderWidth: 1, borderColor: '#e0e0e0', borderStyle: 'dashed', elevation: 1,
    },
    addCardInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
    addCardText: { fontSize: 14, color: '#2e7d32', fontWeight: '600' },
    emptyText: { fontSize: 16, color: '#757575' },
    menuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
    menuContainer: {
        position: 'absolute', top: 8, right: 12,
        backgroundColor: 'white', borderRadius: 10,
        elevation: 8, shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2, shadowRadius: 4,
        minWidth: 180,
    },
    menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 10 },
    menuItemText: { fontSize: 14, color: '#212121' },
    modalOverlay: {
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'center',
        alignItems: 'center', zIndex: 200,
    },
    modalContainer: {
        backgroundColor: 'white',
        borderRadius: 16,
        padding: 24,
        width: '90%',
        elevation: 8,
        shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2, shadowRadius: 8,
    },
    modalTitle: {
        fontSize: 16, fontWeight: '700', color: '#212121', marginBottom: 12,
    },
    modalLabel: {
        fontSize: 13, color: '#757575', marginBottom: 8,
    },
    modalInput: {
        borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8,
        padding: 12, fontSize: 18, color: '#212121', textAlign: 'center',
        marginBottom: 16,
    },
    modalButtons: {
        flexDirection: 'row', gap: 10,
    },
    modalCancel: {
        flex: 1, padding: 12, borderRadius: 8,
        borderWidth: 1, borderColor: '#e0e0e0', alignItems: 'center',
    },
    modalCancelText: {
        fontSize: 14, color: '#757575', fontWeight: '600',
    },
    modalConfirm: {
        flex: 1, padding: 12, borderRadius: 8,
        backgroundColor: '#2e7d32', alignItems: 'center',
    },
    modalConfirmText: {
        fontSize: 14, color: 'white', fontWeight: '600',
    },
    weighableRow: {
        flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16,
    },
    weighableLabel: {
        fontSize: 14, color: '#212121',
    },
    checkbox: {
        width: 22, height: 22, borderRadius: 11,
        borderWidth: 2, borderColor: '#2e7d32',
        alignItems: 'center', justifyContent: 'center',
    },
    checkboxChecked: {
        backgroundColor: '#2e7d32', borderColor: '#2e7d32',
    },
    deleteAction: {
        backgroundColor: '#c62828',
        justifyContent: 'center',
        alignItems: 'center',
        width: 80,
        flexDirection: 'column',
        flex: 1,
    },
    actionText: { color: 'white', fontSize: 11, fontWeight: '600' },
});