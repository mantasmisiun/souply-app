import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../../config/api';
import { useReceiptEditStore } from '../../../state/receiptEditState';
import { useTheme, type AppTheme } from '../../../constants/theme';

interface Category {
    id: number;
    name: string;
}

interface Product {
    id: number;
    name: string;
}

export default function CategoryPickerScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { itemIndex, chainId } = useLocalSearchParams<{ itemIndex: string; chainId: string }>();
    const router = useRouter();
    const setPendingSelection = useReceiptEditStore(s => s.setPendingSelection);

    const [categories, setCategories] = useState<Category[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [breadcrumb, setBreadcrumb] = useState<Category[]>([]);
    const [isL3, setIsL3] = useState(false);
    const [currentL3, setCurrentL3] = useState<Category | null>(null);

    const currentCategory = breadcrumb[breadcrumb.length - 1] || null;

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                const url = currentCategory
                    ? `${API_BASE_URL}/api/categories/${currentCategory.id}/subcategories`
                    : `${API_BASE_URL}/api/categories`;
                const response = await fetch(url);
                const data = await response.json();

                if (!Array.isArray(data) || data.length === 0) {
                    // L3 — fetch products
                    setIsL3(true);
                    setCurrentL3(currentCategory);
                    const prodRes = await fetch(`${API_BASE_URL}/api/categories/${currentCategory!.id}/products`);
                    const prodData = await prodRes.json();
                    setProducts(Array.isArray(prodData) ? prodData : []);
                    setCategories([]);
                } else {
                    setIsL3(false);
                    setCategories(data);
                    setProducts([]);
                }
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [currentCategory]);

    const handleCategorySelect = (category: Category) => {
        setBreadcrumb([...breadcrumb, category]);
        setIsL3(false);
    };

    const handleBack = () => {
        setBreadcrumb(breadcrumb.slice(0, -1));
        setIsL3(false);
    };

    const handleProductSelect = async (product: Product) => {
        let productName = product.name;

        if (chainId) {
            try {
                const res = await fetch(`${API_BASE_URL}/api/store-products/by-product-chain?productId=${product.id}&chainId=${chainId}`);
                const storeProduct = await res.json();
                if (storeProduct && storeProduct.storeProductName) {
                    productName = storeProduct.storeProductName;
                }
            } catch (error) {
                console.error('Failed to fetch store product:', error);
            }
        }

        setPendingSelection({
            categoryId: currentL3!.id,
            categoryName: breadcrumb.map(c => c.name).join(' > '),
            productName,
            itemIndex: parseInt(itemIndex),
        });
        router.back();
    };

    const handleNoProduct = () => {
        setPendingSelection({
            categoryId: currentL3!.id,
            categoryName: breadcrumb.map(c => c.name).join(' > '),
            productName: null,
            itemIndex: parseInt(itemIndex),
        });
        router.back();
    };

    const handleL3Select = (category: Category) => {
        // Will trigger useEffect to check for products
        setBreadcrumb([...breadcrumb, category]);
    };

    const getTitle = () => {
        if (breadcrumb.length === 0) return 'Pasirinkti kategoriją';
        return breadcrumb[breadcrumb.length - 1].name;
    };

    if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={colors.primary} />;

    return (
        <>
            <Stack.Screen options={{
                title: getTitle(),
                headerLeft: breadcrumb.length > 0 ? () => (
                    <TouchableOpacity onPress={handleBack} style={{ marginLeft: 8 }}>
                        <Ionicons name="arrow-back" size={24} color={colors.primary} />
                    </TouchableOpacity>
                ) : undefined,
            }} />

            <FlatList
                data={isL3 ? products : categories}
                keyExtractor={item => item.id.toString()}
                contentContainerStyle={styles.list}
                ListHeaderComponent={isL3 ? (
                    <TouchableOpacity style={styles.noProductButton} onPress={handleNoProduct}>
                        <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
                        <Text style={styles.noProductText}>Tokio produkto nėra</Text>
                    </TouchableOpacity>
                ) : null}
                ListEmptyComponent={
                    isL3 ? null : (
                        <Text style={styles.emptyText}>Kategorijų nėra</Text>
                    )
                }
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={styles.card}
                        onPress={() => isL3
                            ? handleProductSelect(item as Product)
                            : handleCategorySelect(item as Category)
                        }
                    >
                        <Text style={styles.cardText}>{item.name}</Text>
                        {!isL3 && <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />}
                    </TouchableOpacity>
                )}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    list: { padding: 16 },
    card: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 16, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1, shadowRadius: 2,
    },
    cardText: { fontSize: 15, color: c.textPrimary, flex: 1 },
    noProductButton: {
        backgroundColor: c.primaryMuted, borderRadius: 12, padding: 16, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center', gap: 8,
    },
    noProductText: { fontSize: 15, color: c.primary, fontWeight: '600' },
    emptyText: { textAlign: 'center', padding: 32, fontSize: 15, color: c.textSecondary },
});
