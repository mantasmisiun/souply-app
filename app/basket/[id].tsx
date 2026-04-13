import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, TextInput, Image } from 'react-native';
import { useRef, useState, useCallback } from 'react';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../../config/api';

interface BasketItem {
    id: number;
    basketId: number;
    productId: number;
    quantity: number;
    productName: string;
    categoryName?: string;
    isWeighable: boolean;
    imageUrl: string | null;
}

interface Basket {
    id: number;
    status: string;
    name: string;
    createdAt: string;
}

export default function BasketDetailScreen() {
    const { id } = useLocalSearchParams();
    const router = useRouter();
    const [basket, setBasket] = useState<Basket | null>(null);
    const [items, setItems] = useState<BasketItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [quantityInputs, setQuantityInputs] = useState<{[key: number]: string}>({});
    const [basketName, setBasketName] = useState('');
    const [editingName, setEditingName] = useState(false);
    const nameInputRef = useRef<any>(null);

    const fetchBasket = async () => {
        try {
            const [basketRes, itemsRes] = await Promise.all([
                fetch(`${API_BASE_URL}/api/baskets/${id}`),
                fetch(`${API_BASE_URL}/api/baskets/${id}/items`),
            ]);
            const basketData = await basketRes.json();
            const itemsData = await itemsRes.json();
            setBasket(basketData);
            setBasketName(basketData.name || '');
            const parsedItems = Array.isArray(itemsData) ? itemsData.map((item: any) => ({
                ...item,
                quantity: parseFloat(item.quantity),
                isWeighable: item.isWeighable === 1,
            })) : [];
            setItems(parsedItems);

            const inputs: {[key: number]: string} = {};
            parsedItems.forEach((item: any) => {
                inputs[item.id] = parseFloat(item.quantity) % 1 === 0
                    ? String(parseInt(item.quantity))
                    : parseFloat(item.quantity).toFixed(1);
            });
            setQuantityInputs(inputs);
        } catch (error) {
            console.error('Failed to fetch basket:', error);
        } finally {
            setLoading(false);
        }
    };
    const saveBasketName = async (name: string) => {
        try {
            await fetch(`${API_BASE_URL}/api/baskets/${id}/name`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            setBasketName(name);
            setEditingName(false);
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko pervadinti krepšelio');
        }
    };
    useFocusEffect(useCallback(() => {
        fetchBasket();
    }, [id]));

    const updateQuantity = async (itemId: number, newQuantity: number) => {
        const rounded = Math.round(newQuantity * 100) / 100;
        if (rounded < 1 && !items.find(i => i.id === itemId)?.isWeighable) {
            removeItem(itemId);
            return;
        }
        if (rounded <= 0) {
            removeItem(itemId);
            return;
        }
        try {
            await fetch(`${API_BASE_URL}/api/basket-items/${itemId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: rounded }),
            });
            setItems(prev => prev.map(item =>
                item.id === itemId ? { ...item, quantity: rounded } : item
            ));
            setQuantityInputs(prev => ({ ...prev, [itemId]: String(rounded) }));
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko atnaujinti kiekio');
        }
    };

    const removeItem = async (itemId: number) => {
        try {
            await fetch(`${API_BASE_URL}/api/basket-items/${itemId}`, {
                method: 'DELETE',
            });
            const remaining = items.filter(item => item.id !== itemId);
            setItems(remaining);

            if (remaining.length === 0) {
                await fetch(`${API_BASE_URL}/api/baskets/${id}`, {
                    method: 'DELETE',
                });
                router.back();
            }
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko pašalinti produkto');
        }
    };
    const handleCalculate = async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/baskets/${id}/calculate`, {
                method: 'POST',
            });
            const results = await res.json();
            await AsyncStorage.setItem(`basket_results_${id}`, JSON.stringify(results));
            router.push(`/basket/results/${id}`);
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko apskaičiuoti krepšelio');
        }
    };

    const handleRevertToDraft = async () => {
        Alert.alert(
            'Grąžinti į juodraštį',
            'Ar tikrai norite grąžinti krepšelį į juodraštį?',
            [
                { text: 'Atšaukti', style: 'cancel' },
                {
                    text: 'Grąžinti',
                    onPress: async () => {
                        await fetch(`${API_BASE_URL}/api/baskets/${id}/status`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ status: 'draft' }),
                        });
                        await AsyncStorage.removeItem(`basket_results_${id}`);
                        fetchBasket();
                    }
                }
            ]
        );
    };

    if (loading) return <View style={styles.centered}><ActivityIndicator size="large" color="#2e7d32" /></View>;

    const isDraft = basket?.status === 'draft';
    console.log('basket status:', basket?.status, 'items:', items.length);
    return (
        <>
            <Stack.Screen options={{
                title: editingName ? '' : basketName || new Date(basket?.createdAt || '').toLocaleDateString('lt-LT'),
                headerTitle: editingName ? () => (
                    <TextInput
                        ref={nameInputRef}
                        value={basketName}
                        onChangeText={setBasketName}
                        onEndEditing={e => saveBasketName(e.nativeEvent.text)}
                        onSubmitEditing={e => saveBasketName(e.nativeEvent.text)}
                        style={{ fontSize: 16, color: '#212121', minWidth: 200 }}
                    />
                ) : undefined,
                headerRight: () => (
                    <View style={{ flexDirection: 'row', gap: 8, marginRight: 12 }}>
                        {basket?.status === 'draft' && (
                            <TouchableOpacity onPress={() => {
                                if (editingName) {
                                    setEditingName(false);
                                } else {
                                    setEditingName(true);
                                    setTimeout(() => nameInputRef.current?.focus(), 50);
                                }
                            }}>
                                <Ionicons name={editingName ? 'close' : 'pencil-outline'} size={20} color="#2e7d32" />
                            </TouchableOpacity>
                        )}
                        {basket?.status === 'compared' && (
                            <TouchableOpacity onPress={handleRevertToDraft}>
                                <Ionicons name="create-outline" size={20} color="#757575" />
                            </TouchableOpacity>
                        )}
                    </View>
                ),
            }} />
            <View style={styles.container}>
                <FlatList
                    data={items}
                    keyExtractor={item => item.id.toString()}
                    contentContainerStyle={styles.list}
                    ListEmptyComponent={
                        <View style={styles.centered}>
                            <Text style={styles.emptyText}>Krepšelis tuščias</Text>
                            <Text style={styles.emptySubText}>Pridėkite produktų naršydami katalogą</Text>
                        </View>
                    }
                    renderItem={({ item }) => (
                        <View style={styles.card}>
                            {item.imageUrl ? (
                                <Image source={{ uri: item.imageUrl }} style={styles.productImage} resizeMode="contain" />
                            ) : (
                                <View style={styles.productImagePlaceholder}>
                                    <Ionicons name="cube-outline" size={24} color="#9e9e9e" />
                                </View>
                            )}
                            <View style={styles.cardContent}>
                                <Text style={styles.itemName}>{item.productName}</Text>
                                {isDraft && (
                                    <View style={styles.controls}>
                                        <TouchableOpacity
                                            style={styles.controlButton}
                                            onPress={() => updateQuantity(item.id, item.quantity - 1)}
                                        >
                                            <Ionicons name="remove" size={18} color="#2e7d32" />
                                        </TouchableOpacity>
                                        <TextInput
                                            style={styles.quantityInput}
                                            value={quantityInputs[item.id] ?? String(item.quantity)}
                                            onChangeText={v => {
                                                if (!item.isWeighable && (v.includes('.') || v.includes(','))) return;
                                                const dotIndex = v.indexOf('.');
                                                const commaIndex = v.indexOf(',');
                                                const separatorIndex = dotIndex !== -1 ? dotIndex : commaIndex;
                                                if (separatorIndex !== -1 && v.length - separatorIndex > 2) return;
                                                setQuantityInputs(prev => ({ ...prev, [item.id]: v }));
                                            }}
                                            onEndEditing={async e => {
                                                const val = parseFloat(e.nativeEvent.text.replace(',', '.'));
                                                if (!val || val <= 0) {
                                                    removeItem(item.id);
                                                    return;
                                                }
                                                await updateQuantity(item.id, val);
                                                setQuantityInputs(prev => ({ ...prev, [item.id]: String(val) }));
                                            }}
                                            keyboardType={item.isWeighable ? 'numeric' : 'number-pad'}
                                            selectTextOnFocus
                                        />
                                        <TouchableOpacity
                                            style={styles.controlButton}
                                            onPress={() => updateQuantity(item.id, item.quantity + 1)}
                                        >
                                            <Ionicons name="add" size={18} color="#2e7d32" />
                                        </TouchableOpacity>
                                    </View>
                                )}
                            </View>
                            {isDraft && (
                                <TouchableOpacity
                                    style={styles.removeButton}
                                    onPress={() => removeItem(item.id)}
                                >
                                    <Ionicons name="trash-outline" size={20} color="#c62828" />
                                </TouchableOpacity>
                            )}
                        </View>
                    )}
                />
                {(basket?.status === 'draft' && items.length > 0) || basket?.status === 'compared' ? (
                    <View style={styles.bottomBar}>
                        {basket?.status === 'draft' && (
                            <TouchableOpacity style={styles.showResultsButton} onPress={handleCalculate}>
                                <Ionicons name="calculator-outline" size={20} color="white" />
                                <Text style={styles.showResultsText}>Apskaičiuoti</Text>
                            </TouchableOpacity>
                        )}
                        {basket?.status === 'compared' && (
                            <>
                                <TouchableOpacity
                                    style={styles.showResultsButton}
                                    onPress={() => router.push(`/basket/results/${id}`)}
                                >
                                    <Ionicons name="list-outline" size={20} color="white" />
                                    <Text style={styles.showResultsText}>Rodyti parduotuves</Text>
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                ) : null}
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16 },
    itemCategory: { fontSize: 12, color: '#757575', marginTop: 2 },
    controlButton: {
        width: 28, height: 28, borderRadius: 14,
        borderWidth: 1, borderColor: '#2e7d32',
        alignItems: 'center', justifyContent: 'center',
    },
    quantity: { fontSize: 15, fontWeight: '600', color: '#212121', minWidth: 24, textAlign: 'center' },
    emptyText: { fontSize: 16, color: '#757575', fontWeight: '600' },
    emptySubText: { fontSize: 13, color: '#9e9e9e', marginTop: 4 },
    quantityInput: {
        fontSize: 15, fontWeight: '600', color: '#212121',
        minWidth: 40, textAlign: 'center',
        borderBottomWidth: 1, borderBottomColor: '#e0e0e0',
        paddingVertical: 2,
    },
    calculateButton: {
        backgroundColor: '#2e7d32', borderRadius: 12, padding: 16,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    calculateButtonText: { color: 'white', fontWeight: '700', fontSize: 16 },
    recalculateButton: {
        borderWidth: 1, borderColor: '#2e7d32', borderRadius: 12, padding: 16,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    recalculateButtonText: { color: '#2e7d32', fontWeight: '600', fontSize: 15 },
    draftButton: {
        borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 12, padding: 16,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    draftButtonText: { color: '#757575', fontWeight: '600', fontSize: 15 },
        bottomBar: {
        flexDirection: 'row',
        padding: 12,
        backgroundColor: 'white',
        borderTopWidth: 1,
        borderTopColor: '#e0e0e0',
        gap: 10,
    },
    showResultsButton: {
        flex: 1,
        backgroundColor: '#2e7d32',
        borderRadius: 12,
        padding: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    showResultsText: { color: 'white', fontWeight: '700', fontSize: 15 },
    recalculateIconButton: {
        width: 50,
        borderWidth: 1,
        borderColor: '#2e7d32',
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    footer: { padding: 16 },
    card: {
        backgroundColor: 'white', borderRadius: 12, padding: 12, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1, shadowRadius: 2,
    },
    productImage: {
        width: 56, height: 56, borderRadius: 8, marginRight: 12, alignSelf: 'center',
    },
    productImagePlaceholder: {
        width: 56, height: 56, borderRadius: 8, marginRight: 12,
        backgroundColor: '#f0f0f0', alignItems: 'center', justifyContent: 'center', alignSelf: 'center',
    },
    cardContent: { flex: 1, justifyContent: 'space-between' },
    itemName: { fontSize: 14, fontWeight: '600', color: '#212121' },
    controls: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
    removeButton: {
        width: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderLeftWidth: 1,
        borderLeftColor: '#f0f0f0',
        marginLeft: 8,
        paddingLeft: 8,
    },
});