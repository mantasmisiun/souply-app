import { View, FlatList, ScrollView, TouchableOpacity, Text, StyleSheet, ActivityIndicator, Image, Alert } from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../../config/api';
import { useReceiptPickerState } from '../../../state/basketState';
import CreateStoreProductModal, {
    CreatedStoreProductPayload,
} from '../../../components/receipt/CreateStoreProductModal';

interface Category {
    id: number;
    name: string;
}
interface OtherChainProductRow {
    productId: number;
    productName: string;
    categoryId: number;
    imageUrl: string | null;
    sourceChainLogoUrl?: string | null;
}
interface StoreProductRow {
    id: number;
    productId: number;
    storeProductName: string;
    amount: number | null;
    unit: string | null;
    imageUrl: string | null;
}

type GridItem =
  | { kind: 'local'; data: StoreProductRow }
  | { kind: 'other'; data: OtherChainProductRow }
  | { kind: 'create' };

const safeDecode = (v?: string) => {
    try {
        return v ? decodeURIComponent(v) : '';
    } catch {
        return v ?? '';
    }
};

export default function ReceiptCategoryScreen() {
    const { categoryId, name, chainId, productIndex, preselectL3, ocrName } = useLocalSearchParams<{
        categoryId: string;
        name: string;
        chainId: string;
        productIndex: string;
        preselectL3?: string;
        ocrName?: string;
    }>();
    const router = useRouter();
    const { setPendingPick } = useReceiptPickerState();
    const [createModalVisible, setCreateModalVisible] = useState(false);
    const [l3Categories, setL3Categories] = useState<Category[]>([]);
    const [selectedL3, setSelectedL3] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingProducts, setLoadingProducts] = useState(false);
    const baseName = safeDecode(typeof ocrName === 'string' ? ocrName : '').trim();
    const createCategoryId = selectedL3 ?? Number(categoryId);
    const canCreate =
        Number.isFinite(createCategoryId) &&
        createCategoryId > 0 &&
        Number.isFinite(Number(chainId)) &&
        Number(chainId) > 0;
    const [localResults, setLocalResults] = useState<StoreProductRow[]>([]);
    const [otherResults, setOtherResults] = useState<OtherChainProductRow[]>([]);
    useEffect(() => {
        (async () => {
            setLoading(true);
            try {
                const subRes = await fetch(`${API_BASE_URL}/api/categories/${categoryId}/subcategories`);
                const subData = await subRes.json();
                setL3Categories(Array.isArray(subData) ? subData : []);

                const preselId = preselectL3 ? Number(preselectL3) : null;
                if (preselId) setSelectedL3(preselId);
                const targetId = preselId ?? Number(categoryId);
                const unifiedRes = await fetch(
                    `${API_BASE_URL}/api/store-products/search-unified?chainId=${chainId}&categoryId=${targetId}`
                );
                const unifiedData = await unifiedRes.json();
                setLocalResults(Array.isArray(unifiedData?.localStoreProducts) ? unifiedData.localStoreProducts : []);
                setOtherResults(Array.isArray(unifiedData?.otherChainProducts) ? unifiedData.otherChainProducts : []);
            } finally {
                setLoading(false);
            }
        })();
    }, [categoryId, preselectL3, chainId]);
    const selectL3 = async (l3Id: number | null) => {
        setSelectedL3(l3Id);
        setLoadingProducts(true);
        try {
            const target = l3Id ?? Number(categoryId);
            const res = await fetch(
            `${API_BASE_URL}/api/store-products/search-unified?chainId=${chainId}&categoryId=${target}`
            );
            const data = await res.json();
            setLocalResults(Array.isArray(data?.localStoreProducts) ? data.localStoreProducts : []);
            setOtherResults(Array.isArray(data?.otherChainProducts) ? data.otherChainProducts : []);
        } finally {
            setLoadingProducts(false);
        }
    };

    const handlePick = (sp: StoreProductRow) => {
        setPendingPick({
            productIndex: Number(productIndex),
            storeProductId: sp.id,
            productId: sp.productId,
            storeProductName: sp.storeProductName,
            imageUrl: sp.imageUrl,
            amount: sp.amount,
            unit: sp.unit,
        });
        router.back();
        router.back();
    };
    const handlePickOtherProduct = async (p: OtherChainProductRow) => {
        Alert.alert(
            'Kitur rastas produktas',
            `Pridėti „${p.productName}“ į šios parduotuvės sąrašą?`,
            [
                { text: 'Atšaukti', style: 'cancel' },
                {
                    text: 'Pridėti',
                    onPress: async () => {
                        try {
                            const res = await fetch(`${API_BASE_URL}/api/store-products`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    productId: p.productId,
                                    chainId: Number(chainId),
                                    storeProductName: p.productName,
                                }),
                            });
                            const created = await res.json();
                            if (!res.ok || !created?.id) throw new Error(created?.error || 'Nepavyko sukurti StoreProduct');

                            setPendingPick({
                                productIndex: Number(productIndex),
                                storeProductId: created.id,
                                productId: p.productId,
                                storeProductName: p.productName,
                                imageUrl: p.imageUrl ?? null,
                                amount: null,
                                unit: null,
                            });

                            router.back();
                            router.back();
                        } catch (e: any) {
                            Alert.alert('Klaida', e?.message || 'Nepavyko pridėti produkto');
                        }
                    },
                },
            ]
        );
    };
    const gridData = useMemo<GridItem[]>(() => {
    const rows: GridItem[] = [
        ...localResults.map((p): GridItem => ({ kind: 'local', data: p })),
        ...otherResults.map((p): GridItem => ({ kind: 'other', data: p })),
        { kind: 'create' },
    ];
    return rows;
    }, [localResults, otherResults]);

    const renderProductCard = (sp: StoreProductRow) => (
        <TouchableOpacity style={styles.productCard} onPress={() => handlePick(sp)} activeOpacity={0.7}>
            <View style={styles.productImageContainer}>
                {sp.imageUrl ? (
                    <Image source={{ uri: sp.imageUrl }} style={styles.productImage} resizeMode="contain" />
                ) : (
                    <Ionicons name="cube-outline" size={40} color="#e0e0e0" />
                )}
            </View>
            <View style={styles.productInfo}>
                <Text style={styles.productName} numberOfLines={3}>{sp.storeProductName}</Text>
                {sp.amount !== null && sp.unit && (
                    <Text style={styles.amountText}>
                        {sp.amount} {sp.unit}
                    </Text>
                )}
            </View>
        </TouchableOpacity>
    );
    const renderOtherCard = (p: OtherChainProductRow) => (
        <TouchableOpacity style={styles.productCard} onPress={() => handlePickOtherProduct(p)} activeOpacity={0.7}>
            <View style={{ position: 'absolute', top: 8, left: 8, backgroundColor: '#ffecb3', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2, zIndex: 1 }}>
                <Text style={{ fontSize: 11, color: '#8d6e63', fontWeight: '600' }}>Kitur</Text>
            </View>

            <View style={styles.productImageContainer}>
                {p.imageUrl ? (
                    <Image source={{ uri: p.imageUrl }} style={styles.productImage} resizeMode="contain" />
                ) : (
                    <Ionicons name="cube-outline" size={40} color="#e0e0e0" />
                )}
            </View>
            <View style={styles.productInfo}>
                <Text style={styles.productName} numberOfLines={3}>{p.productName}</Text>
            </View>
        </TouchableOpacity>
    );
    const renderCreateCard = () => (
        <TouchableOpacity
            style={[
                styles.productCard,
                styles.createProductCard,
                !canCreate && styles.createProductCardDisabled,
            ]}
            disabled={!canCreate}
            onPress={() => setCreateModalVisible(true)}
            activeOpacity={0.8}
        >
            <View style={styles.productImageContainer}>
                <View style={styles.createProductPlaceholder}>
                    <Text style={styles.createBroccoli}>🥦</Text>
                    <View style={styles.createPlusBadge}>
                        <Ionicons name="add" size={14} color="#ffffff" />
                    </View>
                </View>
            </View>
            <View style={styles.productInfo}>
                <Text style={styles.productName} numberOfLines={2}>Kurti naują produktą</Text>
                <Text style={styles.amountText} numberOfLines={2}>
                    {baseName ? `Pavadinimas: ${baseName}` : 'Nėra OCR pavadinimo'}
                </Text>
            </View>
        </TouchableOpacity>
    );

    if (loading) return <ActivityIndicator style={styles.centered} size="large" color="#2e7d32" />;

    return (
        <>
            <Stack.Screen
                options={{
                    title: safeDecode(typeof name === 'string' ? name : ''),
                    headerRight: () => (
                        <TouchableOpacity
                            onPress={() => router.push({
                                pathname: '/search',
                                params: {
                                    mode: 'store-products',
                                    chainId,
                                    productIndex,
                                    source: 'receipt-category',
                                    ...(ocrName ? { ocrName } : {}),
                                    createCategoryId: String(createCategoryId),
                                },
                            })}
                            style={{ marginRight: 12 }}
                        >
                            <Ionicons name="search" size={24} color="#2e7d32" />
                        </TouchableOpacity>
                    ),
                }}
            />
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
                        <ActivityIndicator style={styles.centered} size="large" color="#2e7d32" />
                    ) : (
                        <FlatList<GridItem>
                            key="category-grid"
                            data={gridData}
                            keyExtractor={(item, idx) => {
                                if (item.kind === 'create') return `create-${idx}`;
                                if (item.kind === 'local') return `local-${item.data.id}-${idx}`;
                                return `other-${item.data.productId}-${idx}`;
                            }}
                            contentContainerStyle={styles.list}
                            numColumns={2}
                            columnWrapperStyle={styles.row}
                            renderItem={({ item }) => {
                                if (item.kind === 'create') return renderCreateCard();
                                if (item.kind === 'other') return renderOtherCard(item.data);
                                return renderProductCard(item.data);
                            }}
                        />
                    )}
                    {localResults.length + otherResults.length === 0 && (
                        <View pointerEvents="none" style={styles.emptyOverlay}>
                            <Text style={styles.emptyOverlayText}>Ši kategorija neturi produktų</Text>
                        </View>
                    )}
                </View>
            </View>
            <CreateStoreProductModal
                visible={createModalVisible}
                onClose={() => setCreateModalVisible(false)}
                chainId={Number(chainId)}
                initialName={baseName}
                initialCategoryId={Number.isFinite(createCategoryId) ? createCategoryId : null}
                onCreated={(created: CreatedStoreProductPayload) => {
                    setPendingPick({
                        productIndex: Number(productIndex),
                        storeProductId: created.storeProductId,
                        productId: created.productId,
                        storeProductName: created.storeProductName,
                        imageUrl: created.imageUrl,
                        amount: null,
                        unit: null,
                        priceVerified: true,
                    });

                    router.back();
                    router.back();
                }}
            />
        </>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    bubblesRow: {
        backgroundColor: 'white', borderBottomWidth: 0.5, borderBottomColor: '#e0e0e0',
        flexGrow: 0, flexShrink: 0,
    },
    bubblesContainer: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
    bubble: {
        paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
        borderWidth: 1, borderColor: '#e0e0e0', backgroundColor: 'white',
    },
    bubbleActive: { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
    bubbleText: { fontSize: 13, color: '#424242' },
    bubbleTextActive: { color: 'white', fontWeight: '600' },
    list: { padding: 12 },
    row: { gap: 12, marginBottom: 12 },
    productCard: {
        backgroundColor: 'white',
        borderRadius: 12,
        padding: 12,
        alignItems: 'center',
        elevation: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
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
    productImage: { width: '100%', height: '100%' },
    productInfo: { flex: 1, width: '100%' },
    productName: { fontSize: 13, color: '#212121', lineHeight: 18 },
    amountText: { fontSize: 12, color: '#9e9e9e', marginTop: 2 },
    createProductCard: {
        width: '100%',
        maxWidth: '100%',
    },
    createProductCardDisabled: {
        opacity: 0.6,
    },
    createProductPlaceholder: {
        width: '100%',
        height: '100%',
        borderRadius: 10,
        backgroundColor: '#f1f3f4',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
    },
    createBroccoli: {
        fontSize: 44,
        opacity: 0.55,
    },
    createPlusBadge: {
        position: 'absolute',
        right: 8,
        bottom: 8,
        width: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: '#9e9e9e',
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 0,
    },
    emptyOverlayText: {
        fontSize: 15,
        color: '#9e9e9e',
        textAlign: 'center',
    },

});
