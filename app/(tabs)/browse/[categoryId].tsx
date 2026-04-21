import { View, FlatList, ScrollView, TouchableOpacity, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../../config/api';
import { useBasketState } from '../../../state/basketState';
import { addProductToBasket } from '../../../utils/basketUtils';
import AmountPickerModal from '../../../components/AmountPickerModal';
import { ProductImage } from '../../../components/ProductImage';
import { useTheme, type AppTheme } from '../../../constants/theme';

interface Category {
    id: number;
    name: string;
}

interface Product {
    id: number;
    name: string;
    brandName: string | null;
    imageUrls?: (string | null | undefined)[] | string | null;
    minAmount: number | null;
    maxAmount: number | null;
    unit: string | null;
    hasWeighable: boolean;
}

export default function CategoryScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { categoryId, name } = useLocalSearchParams<{ categoryId: string; name: string }>();
    const [l3Categories, setL3Categories] = useState<Category[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [selectedL3, setSelectedL3] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingProducts, setLoadingProducts] = useState(false);
    const { draftBasketId, setDraftBasketId } = useBasketState();
    const [basketQuantities, setBasketQuantities] = useState<{[productId: number]: number}>({});
    const router = useRouter();
    const [amountModal, setAmountModal] = useState<{
        visible: boolean;
        product: Product | null;
    }>({ visible: false, product: null });
    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                const subRes = await fetch(`${API_BASE_URL}/api/categories/${categoryId}/subcategories`);
                const subData = await subRes.json();
                setL3Categories(Array.isArray(subData) ? subData : []);

                const prodRes = await fetch(`${API_BASE_URL}/api/categories/${categoryId}/all-products-with-amounts`);
                const prodData = await prodRes.json();
                setProducts(Array.isArray(prodData) ? prodData : []);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [categoryId]);
    useEffect(() => {
        const loadBasketQuantities = async () => {
            // Init draft basket if not set
            if (!draftBasketId) {
                await useBasketState.getState().initDraftBasket();
            }
            const currentDraftId = useBasketState.getState().draftBasketId;
            if (!currentDraftId) return;

            try {
                const res = await fetch(`${API_BASE_URL}/api/baskets/${currentDraftId}/items`);
                const items = await res.json();
                if (Array.isArray(items)) {
                    const quantities: {[productId: number]: number} = {};
                    items.forEach((item: any) => {
                        quantities[item.productId] = parseFloat(item.quantity);
                    });
                    setBasketQuantities(quantities);
                }
            } catch {}
        };
        loadBasketQuantities();
    }, [draftBasketId]);

    const selectL3 = async (l3Id: number | null) => {
        setSelectedL3(l3Id);
        setLoadingProducts(true);
        try {
            const url = l3Id
                ? `${API_BASE_URL}/api/categories/${l3Id}/products-with-amounts`
                : `${API_BASE_URL}/api/categories/${categoryId}/all-products-with-amounts`;
            const res = await fetch(url);
            const data = await res.json();
            setProducts(Array.isArray(data) ? data : []);
        } finally {
            setLoadingProducts(false);
        }
    };

    if (loading) return <ActivityIndicator style={styles.centered} size="large" color={colors.primary} />;

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
                        <ActivityIndicator style={styles.centered} size="large" color={colors.primary} />
                    ) : (
                        <FlatList
                            data={products}
                            keyExtractor={item => item.id.toString()}
                            contentContainerStyle={styles.list}
                            numColumns={2}
                            columnWrapperStyle={styles.row}
                            ListEmptyComponent={
                                <Text style={styles.emptyText}>Ši kategorija neturi produktų</Text>
                            }
                            renderItem={({ item }) => {
                                const quantity = basketQuantities[item.id] ?? 0;
                                return (
                                    <View style={styles.productCard}>
                                        <TouchableOpacity 
                                            onPress={() => router.push(`/product/${item.id}` as any)}
                                            style={styles.productImageContainer}
                                            activeOpacity={0.7}
                                        >
                                            <ProductImage
                                                uris={item.imageUrls}
                                                imageStyle={styles.productImage}
                                                placeholderStyle={styles.productImagePlaceholder}
                                                emojiStyle={styles.productImageEmoji}
                                            />
                                        </TouchableOpacity>
                                        <View style={styles.productInfo}>
                                            <Text style={styles.productName} numberOfLines={3}>{item.name}</Text>
                                                <Text style={styles.amountText}>
                                                    {item.minAmount != null && item.maxAmount != null ? (() => {
                                                        const min = Number(item.minAmount);
                                                        const max = Number(item.maxAmount);
                                                        const formatAmount = (val: number) => 
                                                            val >= 1000 ? `${val / 1000} kg` : `${val} g`;
                                                        return min === max 
                                                            ? formatAmount(min)
                                                            : `${formatAmount(min)} - ${formatAmount(max)}`;
                                                    })() : ''}
                                                </Text>
                                            </View>
                                        {quantity === 0 ? (
                                            <TouchableOpacity
                                                style={styles.addButton}
                                                onPress={async () => {
                                                    const hasRange = item.minAmount !== null && item.maxAmount !== null && item.minAmount !== item.maxAmount;
                                                    
                                                    if (hasRange) {
                                                        // Different amounts across stores — show popup
                                                        setAmountModal({ visible: true, product: item });
                                                    } else {
                                                        // All same amount or no amount info — add directly with quantity 1
                                                        const result = await addProductToBasket(item.id, draftBasketId, setDraftBasketId);
                                                        if (result.success) {
                                                            setBasketQuantities(prev => ({ ...prev, [item.id]: 1 }));
                                                        }
                                                    }
                                                }}
                                            >
                                                <Text style={styles.addButtonText}>Į krepšelį</Text>
                                            </TouchableOpacity>
                                        ) : (
                                            <View style={styles.quantityControl}>
                                                <TouchableOpacity
                                                    style={styles.qtyButton}
                                                    onPress={async () => {
                                                        const hasRange = item.minAmount !== null && item.maxAmount !== null && Number(item.minAmount) !== Number(item.maxAmount);
                                                        const step = hasRange ? 0.1 : 1;
                                                        const newQty = Math.round((quantity - step) * 10) / 10;
                                                        
                                                        if (newQty <= 0) {
                                                            setBasketQuantities(prev => ({ ...prev, [item.id]: 0 }));
                                                            try {
                                                                const res = await fetch(`${API_BASE_URL}/api/baskets/${draftBasketId}/items`);
                                                                const items = await res.json();
                                                                const basketItem = items.find((i: any) => i.productId === item.id);
                                                                if (basketItem) {
                                                                    await fetch(`${API_BASE_URL}/api/basket-items/${basketItem.id}`, { method: 'DELETE' });
                                                                }
                                                            } catch {}
                                                        } else {
                                                            setBasketQuantities(prev => ({ ...prev, [item.id]: newQty }));
                                                            try {
                                                                const res = await fetch(`${API_BASE_URL}/api/baskets/${draftBasketId}/items`);
                                                                const items = await res.json();
                                                                const basketItem = items.find((i: any) => i.productId === item.id);
                                                                if (basketItem) {
                                                                    await fetch(`${API_BASE_URL}/api/basket-items/${basketItem.id}`, {
                                                                        method: 'PUT',
                                                                        headers: { 'Content-Type': 'application/json' },
                                                                        body: JSON.stringify({ quantity: newQty }),
                                                                    });
                                                                }
                                                            } catch {}
                                                        }
                                                    }}
                                                >
                                                    <Ionicons name="remove" size={16} color={colors.primary} />
                                                </TouchableOpacity>
                                                <Text style={styles.qtyText}>
                                                    {Number.isInteger(quantity) ? quantity : quantity.toFixed(1)}
                                                </Text>
                                                <TouchableOpacity
                                                    style={styles.qtyButton}
                                                    onPress={async () => {
                                                        const hasRange = item.minAmount !== null && item.maxAmount !== null && Number(item.minAmount) !== Number(item.maxAmount);
                                                        const step = hasRange ? 0.1 : 1;
                                                        const newQty = Math.round((quantity + step) * 10) / 10;
                                                        setBasketQuantities(prev => ({ ...prev, [item.id]: newQty }));
                                                        try {
                                                            const res = await fetch(`${API_BASE_URL}/api/baskets/${draftBasketId}/items`);
                                                            const items = await res.json();
                                                            const basketItem = items.find((i: any) => i.productId === item.id);
                                                            if (basketItem) {
                                                                await fetch(`${API_BASE_URL}/api/basket-items/${basketItem.id}`, {
                                                                    method: 'PUT',
                                                                    headers: { 'Content-Type': 'application/json' },
                                                                    body: JSON.stringify({ quantity: newQty }),
                                                                });
                                                            }
                                                        } catch {}
                                                    }}
                                                >
                                                    <Ionicons name="add" size={16} color={colors.primary} />
                                                </TouchableOpacity>
                                            </View>
                                        )}
                                    </View>
                                );
                            }}
                        />
                    )}
                </View>
            </View>
            <AmountPickerModal
                visible={amountModal.visible}
                productName={amountModal.product?.name || ''}
                minAmount={amountModal.product?.minAmount || 0}
                maxAmount={amountModal.product?.maxAmount || 0}
                unit={amountModal.product?.unit || 'g'}
                onCancel={() => setAmountModal({ visible: false, product: null })}
                onConfirm={async (amount) => {
                    if (amountModal.product) {
                        const result = await addProductToBasket(
                            amountModal.product.id,
                            draftBasketId,
                            setDraftBasketId,
                            amount
                        );
                        if (result.success) {
                            setBasketQuantities(prev => ({
                                ...prev,
                                [amountModal.product!.id]: amount,
                            }));
                        }
                    }
                    setAmountModal({ visible: false, product: null });
                }}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    bubblesRow: {
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
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
        borderColor: c.border,
        backgroundColor: c.cardBackground,
    },
    bubbleActive: {
        backgroundColor: c.primary,
        borderColor: c.primary,
    },
    bubbleText: {
        fontSize: 13,
        color: c.textPrimary,
    },
    bubbleTextActive: {
        color: c.onPrimary,
        fontWeight: '600',
    },
    list: {
        padding: 12,
    },
    row: {
        gap: 12,
        marginBottom: 12,
    },
    productCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 12,
        padding: 12,
        alignItems: 'center',
        elevation: 1,
        shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05, shadowRadius: 2,
        flex: 1,
        maxWidth: '50%',
    },
    productImageContainer: {
        width: '100%',
        height: 130,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 8,
    },
    productImage: {
        width: '100%',
        height: '100%',
    },
    productImagePlaceholder: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.surfaceMuted,
        borderRadius: 8,
    },
    productImageEmoji: {
        fontSize: 44,
        opacity: 0.4,
    },
    productInfo: {
        flex: 1,
        width: '100%',
        marginBottom: 10,
    },
    productName: {
        fontSize: 13,
        color: c.textPrimary,
        lineHeight: 18,
    },
    addButton: {
        width: '100%',
        backgroundColor: c.primary,
        borderRadius: 8,
        paddingVertical: 10,
        alignItems: 'center',
    },
    addButtonText: {
        color: c.onPrimary,
        fontSize: 13,
        fontWeight: '600',
    },
    brandText: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    emptyText: { textAlign: 'center', padding: 32, fontSize: 15, color: c.textSecondary },
    productRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: c.cardBackground,
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
    },
    productIcon: {
        width: 36, height: 36, borderRadius: 8,
        backgroundColor: c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    quantityControl: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderWidth: 1,
        borderColor: c.primary,
        borderRadius: 8,
        paddingVertical: 6,
        paddingHorizontal: 10,
    },
    qtyButton: {
        padding: 2,
    },
    qtyText: {
        fontSize: 14,
        fontWeight: '700',
        color: c.primary,
        minWidth: 20,
        textAlign: 'center',
    },
    amountText: {
        fontSize: 12,
        color: c.textMuted,
        marginTop: 2,
    },
});