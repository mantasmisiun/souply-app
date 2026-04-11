import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Alert, Image, FlatList, Keyboard } from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useEffect, useState, useRef, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet, { BottomSheetView, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { API_BASE_URL } from '../../../config/api';
import { useReceiptEditStore } from '../../../state/receiptEditState';

interface EditableItem {
    name: string;
    brandName: string | null;
    price: number | null;
    quantity: number;
    isWeighable: boolean;
    promoPrice: number | null;
    categoryId: number | null;
    categoryName: string | null;
    priceInput: string;
    promoPriceInput: string;
}

export default function ReceiptEditScreen() {
    const { id } = useLocalSearchParams();
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [chainName, setChainName] = useState('');
    const [receiptNo, setReceiptNo] = useState('');
    const [date, setDate] = useState('');
    const [items, setItems] = useState<EditableItem[]>([]);
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

    const bottomSheetRef = useRef<BottomSheet>(null);
    const snapPoints = ['75%', '95%'];

    const pendingSelection = useReceiptEditStore(s => s.pendingSelection);
    const setPendingSelection = useReceiptEditStore(s => s.setPendingSelection);
    const [chainId, setChainId] = useState<number | null>(null);
    const [nameSuggestions, setNameSuggestions] = useState<{id: number, storeProductName: string, productId: number}[]>([]);
    const [storeName, setStoreName] = useState('');
    const [storeAddress, setStoreAddress] = useState('');
    useFocusEffect(
        useCallback(() => {
            if (pendingSelection) {
                setItems(prev => prev.map((item, i) =>
                    i === pendingSelection.itemIndex ? {
                        ...item,
                        categoryId: pendingSelection.categoryId,
                        categoryName: pendingSelection.categoryName,
                        name: pendingSelection.productName || item.name,
                    } : item
                ));
                setPendingSelection(null);
            }
        }, [pendingSelection])
    );

    useEffect(() => {
        const fetchReceipt = async () => {
            try {
                const response = await fetch(`${API_BASE_URL}/api/receipts/${id}`);
                const data = await response.json();
                const parsed = data.parsedData;

                setChainName(parsed.chainName || '');
                // Look up chainId from chainName
                const chainRes = await fetch(`${API_BASE_URL}/api/chains?name=${encodeURIComponent(parsed.chainName)}`);
                const chainData = await chainRes.json();
                if (chainData.length > 0) setChainId(chainData[0].id);
                setReceiptNo(parsed.receiptNo || '');
                setDate(parsed.date || '');
                setStoreName(parsed.storeName || '');
                setStoreAddress(parsed.storeAddress || '');
                setItems(parsed.items.map((item: any) => ({
                    ...item,
                    categoryId: null,
                    categoryName: null,
                    priceInput: item.price ? String(item.price).replace('.', ',') : '',
                    promoPriceInput: item.promoPrice ? String(item.promoPrice).replace('.', ',') : '',
                })));

                const imageResponse = await fetch(`${API_BASE_URL}/api/receipts/${id}/image`);
                const imageData = await imageResponse.json();
                setImageUrl(imageData.url);
            } catch (error) {
                console.error('Failed to fetch receipt:', error);
            } finally {
                setLoading(false);
            }
        };
        fetchReceipt();
    }, [id]);

    const openItem = (index: number) => {
        setSelectedIndex(index);
        bottomSheetRef.current?.snapToIndex(1);
    };

    const closeSheet = () => {
        bottomSheetRef.current?.close();
    };

    const updateItem = (field: keyof EditableItem, value: any) => {
        if (selectedIndex === null) return;
        setItems(prev => prev.map((item, i) =>
            i === selectedIndex ? { ...item, [field]: value } : item
        ));
    };

    const handleSave = async () => {
        const invalidItems = items.filter(item => !item.price || parseFloat(String(item.price)) <= 0);
        if (invalidItems.length > 0) {
            Alert.alert('Klaida', `Šie produktai neturi kainos:\n${invalidItems.map(i => i.name).join('\n')}`);
            return;
        }
        setSaving(true);
        try {
            const response = await fetch(`${API_BASE_URL}/api/receipts/${id}/process`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chainName, receiptNo, date, items, storeName, storeAddress }),
            });
            const data = await response.json();
            if (data.error) {
                Alert.alert('Klaida', data.error);
            } else {
                router.back();
            }
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko išsaugoti');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return <View style={styles.centered}><ActivityIndicator size="large" color="#2e7d32" /></View>;
    }

    const selectedItem = selectedIndex !== null ? items[selectedIndex] : null;

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <Stack.Screen options={{
                title: receiptNo ? `Kvitas Nr. ${receiptNo}` : 'Kvito redagavimas',
                headerRight: () => (
                    <TouchableOpacity onPress={handleSave} disabled={saving} style={{ marginRight: 12 }}>
                        {saving
                            ? <ActivityIndicator size="small" color="#2e7d32" />
                            : <Text style={{ color: '#2e7d32', fontWeight: '700', fontSize: 16 }}>Išsaugoti</Text>
                        }
                    </TouchableOpacity>
                )
            }} />

            <View style={styles.container}>
                {/* Receipt image */}
                <ScrollView style={styles.imageContainer}>
                    {imageUrl && (
                        <Image source={{ uri: imageUrl }} style={styles.image} resizeMode="contain" />
                    )}
                </ScrollView>

                {/* Product list */}
                <View style={styles.itemsList}>
                    <Text style={styles.listTitle}>Produktai — palieskite norėdami redaguoti</Text>
                    <FlatList
                        data={items}
                        keyExtractor={(_, i) => i.toString()}
                        renderItem={({ item, index }) => (
                            <TouchableOpacity style={styles.itemRow} onPress={() => openItem(index)}>
                                <Ionicons
                                    name={item.price ? 'checkmark-circle' : 'alert-circle'}
                                    size={20}
                                    color={item.price ? '#2e7d32' : '#c62828'}
                                />
                                <View style={{ flex: 1, marginLeft: 8 }}>
                                    <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
                                    <Text style={styles.itemPrice}>
                                        {item.price ? `€${item.price}` : 'Kaina nenurodyta'}
                                    </Text>
                                </View>
                                <Ionicons name="chevron-forward" size={16} color="#757575" />
                            </TouchableOpacity>
                        )}
                    />
                    <TouchableOpacity
                        style={styles.addItemButton}
                        onPress={() => {
                            // Add empty item to items array and open it
                            const newItem = {
                                name: '',
                                brandName: null,
                                price: null,
                                quantity: 1,
                                isWeighable: false,
                                promoPrice: null,
                                categoryId: null,
                                categoryName: null,
                                priceInput: '',
                                promoPriceInput: '',
                            };
                            setItems(prev => [...prev, newItem]);
                            openItem(items.length);
                        }}
                    >
                        <Ionicons name="add-circle-outline" size={20} color="#2e7d32" />
                        <Text style={styles.addItemText}>Pridėti trūkstamą produktą</Text>
                    </TouchableOpacity>
                </View>

                {/* Bottom sheet for editing */}
                <BottomSheet
                    ref={bottomSheetRef}
                    index={-1}
                    snapPoints={snapPoints}
                    enablePanDownToClose
                >
                    <BottomSheetView style={styles.sheetContent}>
                        {selectedItem && (
                            <BottomSheetScrollView keyboardShouldPersistTaps="handled">
                                <Text style={styles.sheetTitle}>{selectedItem.name}</Text>
                                <Text style={styles.label}>Pavadinimas</Text>
                                <TextInput
                                    style={styles.input}
                                    value={selectedItem.name}
                                    onChangeText={async v => {
                                        updateItem('name', v);
                                        if (v.length < 2) {
                                            setNameSuggestions([]);
                                            return;
                                        }
                                        try {
                                            const res = await fetch(`${API_BASE_URL}/api/store-products/search?name=${encodeURIComponent(v)}&chainId=${chainId}`);
                                            const data = await res.json();
                                            setNameSuggestions(Array.isArray(data) ? data.slice(0, 5) : []);
                                        } catch {
                                            setNameSuggestions([]);
                                        }
                                    }}
                                />
                                {nameSuggestions.length > 0 && (
                                    <View style={styles.suggestionsContainer}>
                                        {nameSuggestions.map(s => (
                                            <TouchableOpacity
                                                key={s.id}
                                                style={styles.suggestionItem}
                                                onPress={async () => {
                                                    updateItem('name', s.storeProductName);
                                                    setNameSuggestions([]);
                                                    Keyboard.dismiss();

                                                    try {
                                                        const prodRes = await fetch(`${API_BASE_URL}/api/products/${s.productId}`);
                                                        const product = await prodRes.json();
                                                        if (product.categoryId) {
                                                            const pathRes = await fetch(`${API_BASE_URL}/api/categories/${product.categoryId}`);
                                                            const categoryData = await pathRes.json();
                                                            updateItem('categoryId', product.categoryId);
                                                            updateItem('categoryName', categoryData.name);
                                                        }
                                                    } catch (error) {
                                                        console.error('Failed to fetch product category:', error);
                                                    }
                                                }}
                                            >
                                                <Text style={styles.suggestionText}>{s.storeProductName}</Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                )}

                                <Text style={styles.label}>Kategorija</Text>
                                <TouchableOpacity 
                                    style={styles.categoryButton}
                                    onPress={() => {
                                        router.push(`/receipt/edit/category-picker?itemIndex=${selectedIndex}&chainId=${chainId || ''}`);
                                    }}
                                >
                                    <Text style={selectedItem.categoryName ? styles.categorySelected : styles.categoryPlaceholder}>
                                        {selectedItem.categoryName || 'Pasirinkti kategoriją...'}
                                    </Text>
                                    <Ionicons name="chevron-forward" size={18} color="#757575" />
                                </TouchableOpacity>

                                <Text style={styles.label}>Kaina (€)</Text>
                                <TextInput
                                    style={[styles.input, !selectedItem.price && styles.inputError]}
                                    value={selectedItem.priceInput}
                                    onChangeText={v => {
                                        updateItem('priceInput', v);
                                        const normalized = v.replace(',', '.');
                                        updateItem('price', normalized ? parseFloat(normalized) : null);
                                    }}
                                    keyboardType="decimal-pad"
                                    placeholder="0,00"
                                />

                                <Text style={styles.label}>Nuolaidos kaina (€, neprivaloma)</Text>
                                <TextInput
                                    style={styles.input}
                                    value={selectedItem.promoPriceInput}
                                    onChangeText={v => {
                                        updateItem('promoPriceInput', v);
                                        const normalized = v.replace(',', '.');
                                        updateItem('promoPrice', normalized ? parseFloat(normalized) : null);
                                    }}
                                    keyboardType="decimal-pad"
                                    placeholder="0,00"
                                />

                                <TouchableOpacity style={styles.doneButton} onPress={closeSheet}>
                                    <Text style={styles.doneButtonText}>Patvirtinti</Text>
                                </TouchableOpacity>
                            </BottomSheetScrollView>
                        )}
                    </BottomSheetView>
                </BottomSheet>
            </View>
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    imageContainer: { flex: 1, backgroundColor: '#e0e0e0' },
    image: { width: '100%', height: 500 },
    itemsList: {
        maxHeight: 280,
        backgroundColor: 'white',
        borderTopWidth: 1,
        borderTopColor: '#e0e0e0',
        padding: 12,
    },
    listTitle: { fontSize: 13, color: '#757575', marginBottom: 8 },
    itemRow: {
        flexDirection: 'row', alignItems: 'center',
        paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
    },
    itemName: { fontSize: 14, color: '#212121' },
    itemPrice: { fontSize: 12, color: '#757575', marginTop: 2 },
    sheetContent: { padding: 16, flex: 1 },
    sheetTitle: { fontSize: 16, fontWeight: '700', color: '#212121', marginBottom: 16 },
    label: { fontSize: 12, color: '#757575', marginBottom: 4, marginTop: 12 },
    input: {
        borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8,
        padding: 10, fontSize: 14, color: '#212121',
    },
    inputError: { borderColor: '#c62828' },
    categoryButton: {
        borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8,
        padding: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    },
    categorySelected: { fontSize: 14, color: '#212121', flex: 1 },
    categoryPlaceholder: { fontSize: 14, color: '#9e9e9e', flex: 1 },
    doneButton: {
        backgroundColor: '#2e7d32', borderRadius: 12, padding: 16,
        alignItems: 'center', marginTop: 24, marginBottom: 16,
    },
    doneButtonText: { color: 'white', fontWeight: '700', fontSize: 16 },
    suggestionsContainer: {
    borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8,
    backgroundColor: 'white', marginTop: 2,
    },
    suggestionItem: {
        padding: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
    },
    suggestionText: { fontSize: 14, color: '#212121' },
    addItemButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 8,
    },
    addItemText: {
        fontSize: 14,
        color: '#2e7d32',
        fontWeight: '500',
    },
});