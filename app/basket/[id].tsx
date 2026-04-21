import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, TextInput } from 'react-native';
import { useMemo, useRef, useState, useCallback } from 'react';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../../config/api';
import { ProductImage } from '../../components/ProductImage';
import { useTheme, type AppTheme } from '../../constants/theme';

interface BasketItem {
    id: number;
    basketId: number;
    productId: number;
    quantity: number;
    productName: string;
    categoryName?: string;
    isWeighable: boolean;
    imageUrls?: (string | null | undefined)[] | string | null;
}

interface Basket {
    id: number;
    status: string;
    name: string;
    createdAt: string;
}

export default function BasketDetailScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
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
            // Revert to draft if compared
            if (basket?.status === 'compared') {
                await fetch(`${API_BASE_URL}/api/baskets/${id}/status`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'draft' }),
                });
                setBasket(prev => prev ? { ...prev, status: 'draft' } : prev);
            }

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
            // Revert to draft if compared
            if (basket?.status === 'compared') {
                await fetch(`${API_BASE_URL}/api/baskets/${id}/status`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'draft' }),
                });
                setBasket(prev => prev ? { ...prev, status: 'draft' } : prev);
            }

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
        await AsyncStorage.removeItem(`basket_results_${id}`);
        router.push(`/basket/results/${id}`);
        try {
            const res = await fetch(`${API_BASE_URL}/api/baskets/${id}/calculate`, {
                method: 'POST',
            });
            const newResults = await res.json();
            await AsyncStorage.setItem(`basket_results_${id}`, JSON.stringify(newResults));
            setBasket(prev => prev ? { ...prev, status: 'compared' } : prev);
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

    if (loading) return <View style={styles.centered}><ActivityIndicator size="large" color={colors.primary} /></View>;

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
                        style={{ fontSize: 16, color: colors.textPrimary, minWidth: 200 }}
                    />
                ) : undefined,
                headerRight: () => basket?.status === 'draft' ? (
                    <TouchableOpacity onPress={() => {
                        if (editingName) {
                            setEditingName(false);
                        } else {
                            setEditingName(true);
                            setTimeout(() => nameInputRef.current?.focus(), 50);
                        }
                    }} style={{ marginRight: 12 }}>
                        <Ionicons name={editingName ? 'close' : 'pencil-outline'} size={20} color={colors.primary} />
                    </TouchableOpacity>
                ) : undefined,
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
                            <ProductImage
                                uris={item.imageUrls}
                                imageStyle={styles.productImage}
                                placeholderStyle={styles.productImagePlaceholder}
                                emojiStyle={styles.productImageEmoji}
                            />
                            <View style={styles.cardContent}>
                                <Text style={styles.itemName}>{item.productName}</Text>
                                <View style={styles.controls}>
                                    <TouchableOpacity
                                        style={styles.controlButton}
                                        onPress={() => updateQuantity(item.id, item.quantity - 1)}
                                    >
                                        <Ionicons name="remove" size={18} color={colors.primary} />
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
                                        <Ionicons name="add" size={18} color={colors.primary} />
                                    </TouchableOpacity>
                                </View>
                            </View>
                            <TouchableOpacity
                                style={styles.removeButton}
                                onPress={() => removeItem(item.id)}
                            >
                                <Ionicons name="trash-outline" size={20} color={colors.error} />
                            </TouchableOpacity>
                        </View>
                    )}
                />
                {items.length > 0 && (
                    <View style={styles.bottomBar}>
                        {basket?.status === 'compared' ? (
                            <TouchableOpacity
                                style={styles.showResultsButton}
                                onPress={() => router.push(`/basket/results/${id}`)}
                            >
                                <Ionicons name="storefront-outline" size={20} color={colors.onPrimary} />
                                <Text style={styles.showResultsText}>Rodyti parduotuves</Text>
                            </TouchableOpacity>
                        ) : (
                            <TouchableOpacity style={styles.showResultsButton} onPress={handleCalculate}>
                                <Ionicons name="calculator-outline" size={20} color={colors.onPrimary} />
                                <Text style={styles.showResultsText}>Apskaičiuoti</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                )}
            </View>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16 },
    itemCategory: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    controlButton: {
        width: 28, height: 28, borderRadius: 14,
        borderWidth: 1, borderColor: c.primary,
        alignItems: 'center', justifyContent: 'center',
    },
    quantity: { fontSize: 15, fontWeight: '600', color: c.textPrimary, minWidth: 24, textAlign: 'center' },
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600' },
    emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 4 },
    quantityInput: {
        fontSize: 15, fontWeight: '600', color: c.textPrimary,
        minWidth: 40, textAlign: 'center',
        borderBottomWidth: 1, borderBottomColor: c.border,
        paddingVertical: 2,
    },
    calculateButton: {
        backgroundColor: c.primary, borderRadius: 12, padding: 16,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    calculateButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 16 },
    recalculateButton: {
        borderWidth: 1, borderColor: c.primary, borderRadius: 12, padding: 16,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    recalculateButtonText: { color: c.primary, fontWeight: '600', fontSize: 15 },
    draftButton: {
        borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 16,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    draftButtonText: { color: c.textSecondary, fontWeight: '600', fontSize: 15 },
        bottomBar: {
        flexDirection: 'row',
        padding: 12,
        backgroundColor: c.cardBackground,
        borderTopWidth: 1,
        borderTopColor: c.border,
        gap: 10,
    },
    showResultsButton: {
        flex: 1,
        backgroundColor: c.primary,
        borderRadius: 12,
        padding: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    showResultsText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },
    recalculateIconButton: {
        width: 50,
        borderWidth: 1,
        borderColor: c.primary,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    footer: { padding: 16 },
    card: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 12, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08, shadowRadius: 2,
    },
    productImage: {
        width: 56, height: 56, borderRadius: 8, marginRight: 12, alignSelf: 'center',
    },
    productImagePlaceholder: {
        width: 56, height: 56, borderRadius: 8, marginRight: 12,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center', alignSelf: 'center',
    },
    productImageEmoji: {
        fontSize: 28,
        opacity: 0.4,
    },
    cardContent: { flex: 1, justifyContent: 'space-between' },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    controls: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
    removeButton: {
        width: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderLeftWidth: 1,
        borderLeftColor: c.borderSubtle,
        marginLeft: 8,
        paddingLeft: 8,
    },
});