import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Alert, Image, FlatList, Keyboard } from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet, { BottomSheetView, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { API_BASE_URL } from '../../../config/api';
import { useReceiptEditStore } from '../../../state/receiptEditState';
import { useTheme, type AppTheme } from '../../../constants/theme';

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
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
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

    const updateItem = (field: keyof EditableItem, value: any, index?: number) => {
        const targetIndex = index !== undefined ? index : selectedIndex;
        if (targetIndex === null) return;
        setItems(prev => prev.map((item, i) =>
            i === targetIndex ? { ...item, [field]: value } : item
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
        return <View style={styles.centered}><ActivityIndicator size="large" color={colors.primary} /></View>;
    }

    const selectedItem = selectedIndex !== null ? items[selectedIndex] : null;

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <Stack.Screen options={{
                title: receiptNo ? `Kvitas Nr. ${receiptNo}` : 'Kvito redagavimas',
                headerRight: () => (
                    <TouchableOpacity onPress={handleSave} disabled={saving} style={{ marginRight: 12 }}>
                        {saving
                            ? <ActivityIndicator size="small" color={colors.primary} />
                            : <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 16 }}>Išsaugoti</Text>
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
                                    color={item.price ? colors.primary : colors.error}
                                />
                                <TouchableOpacity
                                    onPress={() => updateItem('isWeighable', !item.isWeighable, index)}
                                    style={{ marginLeft: 8 }}
                                >
                                    <Ionicons
                                        name={item.isWeighable ? 'scale' : 'scale-outline'}
                                        size={20}
                                        color={item.isWeighable ? colors.primary : colors.textMuted}
                                    />
                                </TouchableOpacity>
                                <View style={{ flex: 1, marginLeft: 8 }}>
                                    <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
                                    <Text style={styles.itemPrice}>
                                        {item.price ? `€${item.price}` : 'Kaina nenurodyta'}
                                    </Text>
                                </View>
                                <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
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
                        <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
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
                                    <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
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
                                <Text style={styles.label}>Sveriamas produktas</Text>
                                <TouchableOpacity
                                    style={styles.weighableButton}
                                    onPress={() => updateItem('isWeighable', !selectedItem.isWeighable)}
                                >
                                    <Ionicons
                                        name={selectedItem.isWeighable ? 'scale' : 'scale-outline'}
                                        size={20}
                                        color={selectedItem.isWeighable ? colors.primary : colors.textMuted}
                                    />
                                    <Text style={[styles.weighableText, selectedItem.isWeighable && styles.weighableTextActive]}>
                                        {selectedItem.isWeighable ? 'Taip' : 'Ne'}
                                    </Text>
                                </TouchableOpacity>
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

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    imageContainer: { flex: 1, backgroundColor: c.border },
    image: { width: '100%', height: 500 },
    itemsList: {
        maxHeight: 280,
        backgroundColor: c.cardBackground,
        borderTopWidth: 1,
        borderTopColor: c.border,
        padding: 12,
    },
    listTitle: { fontSize: 13, color: c.textSecondary, marginBottom: 8 },
    itemRow: {
        flexDirection: 'row', alignItems: 'center',
        paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.borderSubtle,
    },
    itemName: { fontSize: 14, color: c.textPrimary },
    itemPrice: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    sheetContent: { padding: 16, flex: 1 },
    sheetTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary, marginBottom: 16 },
    label: { fontSize: 12, color: c.textSecondary, marginBottom: 4, marginTop: 12 },
    input: {
        borderWidth: 1, borderColor: c.border, borderRadius: 8,
        padding: 10, fontSize: 14, color: c.textPrimary,
    },
    inputError: { borderColor: c.error },
    categoryButton: {
        borderWidth: 1, borderColor: c.border, borderRadius: 8,
        padding: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    },
    categorySelected: { fontSize: 14, color: c.textPrimary, flex: 1 },
    categoryPlaceholder: { fontSize: 14, color: c.textMuted, flex: 1 },
    doneButton: {
        backgroundColor: c.primary, borderRadius: 12, padding: 16,
        alignItems: 'center', marginTop: 24, marginBottom: 16,
    },
    doneButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 16 },
    suggestionsContainer: {
    borderWidth: 1, borderColor: c.border, borderRadius: 8,
    backgroundColor: c.cardBackground, marginTop: 2,
    },
    suggestionItem: {
        padding: 12, borderBottomWidth: 1, borderBottomColor: c.borderSubtle,
    },
    suggestionText: { fontSize: 14, color: c.textPrimary },
    addItemButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 8,
    },
    addItemText: {
        fontSize: 14,
        color: c.primary,
        fontWeight: '500',
    },
    weighableButton: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 8,
        padding: 10,
        gap: 8,
    },
    weighableText: { fontSize: 14, color: c.textMuted },
    weighableTextActive: { color: c.primary },
});
