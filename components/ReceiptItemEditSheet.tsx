import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert } from 'react-native';
import { useRef, useState, useCallback } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Keyboard } from 'react-native';
import { API_BASE_URL } from '../config/api';
import { useReceiptEditStore } from '../state/receiptEditState';

interface ReceiptItem {
    priceId: number;
    storeProductId: number;
    name: string;
    categoryId: number;
    categoryName: string;
    price: number;
    promoPrice: number | null;
}

interface Props {
    receiptId: number | string;
    chainId: number | null;
    onSaved: () => void;
}

export default function ReceiptItemEditSheet({ receiptId, chainId, onSaved }: Props) {
    const router = useRouter();
    const bottomSheetRef = useRef<BottomSheet>(null);
    const snapPoints = ['75%', '95%'];

    const [editingItem, setEditingItem] = useState<ReceiptItem | null>(null);
    const [editName, setEditName] = useState('');
    const [editCategoryId, setEditCategoryId] = useState<number | null>(null);
    const [editCategoryName, setEditCategoryName] = useState<string | null>(null);
    const [editPrice, setEditPrice] = useState('');
    const [editPromoPrice, setEditPromoPrice] = useState('');
    const [nameSuggestions, setNameSuggestions] = useState<any[]>([]);

    const pendingSelection = useReceiptEditStore(s => s.pendingSelection);
    const setPendingSelection = useReceiptEditStore(s => s.setPendingSelection);

    useFocusEffect(
        useCallback(() => {
            if (pendingSelection) {
                setEditCategoryId(pendingSelection.categoryId);
                setEditCategoryName(pendingSelection.categoryName);
                if (pendingSelection.productName) setEditName(pendingSelection.productName);
                setPendingSelection(null);
                bottomSheetRef.current?.snapToIndex(1);
            }
        }, [pendingSelection])
    );

    const open = (item: ReceiptItem) => {
        setEditingItem(item);
        setEditName(item.name);
        setEditCategoryId(item.categoryId);
        setEditCategoryName(item.categoryName);
        setEditPrice(String(item.price).replace('.', ','));
        setEditPromoPrice(item.promoPrice ? String(item.promoPrice).replace('.', ',') : '');
        setNameSuggestions([]);
        bottomSheetRef.current?.snapToIndex(1);
    };

    const close = () => {
        bottomSheetRef.current?.close();
    };

    const handleSave = async () => {
        if (!editingItem || !editPrice) return;
        try {
            const response = await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/items/${editingItem.priceId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: editName,
                    categoryId: editCategoryId,
                    price: parseFloat(editPrice.replace(',', '.')),
                    promoPrice: editPromoPrice ? parseFloat(editPromoPrice.replace(',', '.')) : null,
                    oldName: editingItem.name,
                    storeProductId: editingItem.storeProductId,
                }),
            });
            const data = await response.json();
            if (data.message) {
                close();
                onSaved();
            }
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko išsaugoti');
        }
    };

    // Expose open method via ref-like pattern
    ReceiptItemEditSheet.open = open;

    return (
        <BottomSheet
            ref={bottomSheetRef}
            index={-1}
            snapPoints={snapPoints}
            enablePanDownToClose
        >
            <BottomSheetScrollView contentContainerStyle={{ padding: 16, paddingBottom: 300 }}>
                {editingItem && (
                    <>
                        <Text style={styles.sheetTitle}>{editingItem.name}</Text>

                        <Text style={styles.label}>Pavadinimas</Text>
                        <TextInput
                            style={styles.input}
                            value={editName}
                            onChangeText={async v => {
                                setEditName(v);
                                if (v.length < 2) { setNameSuggestions([]); return; }
                                try {
                                    const res = await fetch(`${API_BASE_URL}/api/store-products/search?name=${encodeURIComponent(v)}&chainId=${chainId}`);
                                    const data = await res.json();
                                    setNameSuggestions(Array.isArray(data) ? data.slice(0, 5) : []);
                                } catch {}
                            }}
                        />
                        {nameSuggestions.length > 0 && (
                            <View style={styles.suggestionsContainer}>
                                {nameSuggestions.map(s => (
                                    <TouchableOpacity
                                        key={s.id}
                                        style={styles.suggestionItem}
                                        onPress={async () => {
                                            setEditName(s.storeProductName);
                                            setNameSuggestions([]);
                                            Keyboard.dismiss();
                                            try {
                                                const prodRes = await fetch(`${API_BASE_URL}/api/products/${s.productId}`);
                                                const product = await prodRes.json();
                                                if (product.categoryId) {
                                                    const catRes = await fetch(`${API_BASE_URL}/api/categories/${product.categoryId}`);
                                                    const cat = await catRes.json();
                                                    setEditCategoryId(product.categoryId);
                                                    setEditCategoryName(cat.name);
                                                }
                                            } catch {}
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
                            onPress={() => router.push(`/receipt/edit/category-picker?itemIndex=0&chainId=${chainId}`)}
                        >
                            <Text style={editCategoryName ? styles.categorySelected : styles.categoryPlaceholder}>
                                {editCategoryName || 'Pasirinkti kategoriją...'}
                            </Text>
                            <Ionicons name="chevron-forward" size={18} color="#757575" />
                        </TouchableOpacity>

                        <Text style={styles.label}>Kaina (€)</Text>
                        <TextInput
                            style={styles.input}
                            value={editPrice}
                            onChangeText={v => setEditPrice(v)}
                            keyboardType="numeric"
                            placeholder="0,00"
                        />

                        <Text style={styles.label}>Nuolaidos kaina (€, neprivaloma)</Text>
                        <TextInput
                            style={styles.input}
                            value={editPromoPrice}
                            onChangeText={v => setEditPromoPrice(v)}
                            keyboardType="numeric"
                            placeholder="0,00"
                        />

                        <TouchableOpacity style={styles.doneButton} onPress={handleSave}>
                            <Text style={styles.doneButtonText}>Išsaugoti</Text>
                        </TouchableOpacity>
                    </>
                )}
            </BottomSheetScrollView>
        </BottomSheet>
    );
}

// Static method to allow opening from parent
ReceiptItemEditSheet.open = (_item: any) => {};

const styles = StyleSheet.create({
    sheetTitle: { fontSize: 16, fontWeight: '700', color: '#212121', marginBottom: 16 },
    label: { fontSize: 12, color: '#757575', marginBottom: 4, marginTop: 12 },
    input: { borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8, padding: 10, fontSize: 14, color: '#212121' },
    categoryButton: {
        borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8,
        padding: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    },
    categorySelected: { fontSize: 14, color: '#212121', flex: 1 },
    categoryPlaceholder: { fontSize: 14, color: '#9e9e9e', flex: 1 },
    suggestionsContainer: {
        borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8,
        backgroundColor: 'white', marginTop: 2,
    },
    suggestionItem: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
    suggestionText: { fontSize: 14, color: '#212121' },
    doneButton: {
        backgroundColor: '#2e7d32', borderRadius: 12, padding: 16,
        alignItems: 'center', marginTop: 24, marginBottom: 16,
    },
    doneButtonText: { color: 'white', fontWeight: '700', fontSize: 16 },
});