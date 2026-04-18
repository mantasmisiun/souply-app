import { View, Text, FlatList, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Image, TextInput } from 'react-native';
import { useEffect, useState, useMemo } from 'react';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../config/api';
import Svg, { Line, Circle, Text as SvgText, Rect } from 'react-native-svg';

interface StoreProduct {
    id: number;
    productId: number;
    chainId: number;
    storeProductName: string;
    brandName: string | null;
    amount: string;
    unit: string;
    isWeighable: number;
    chainName: string;
    logoUrl: string;
}

interface PricePoint {
    price: number;
    promoPrice: number | null;
    date: string;
    storeName?: string;
    isFallback: number;
}

interface Store {
    id: number;
    chainId: number;
    name: string;
    address: string;
}

interface Chain {
    id: number;
    name: string;
    logoUrl: string;
}

interface Product {
    id: number;
    name: string;
    imageUrl: string | null;
    categoryId: number;
}

interface Category {
    id: number;
    name: string;
    parentCategoryId: number | null;
}

const CHART_WIDTH = 120;
const CHART_HEIGHT = 50;

function MiniPriceChart({ prices }: { prices: PricePoint[] }) {
    if (!prices.length) {
        return (
            <View style={styles.chartEmpty}>
                <Ionicons name="analytics-outline" size={20} color="#e0e0e0" />
            </View>
        );
    }

    const nonFallback = prices.filter(p => !p.isFallback);
    const data = nonFallback.length > 0 ? nonFallback : prices;
    
    const priceValues = data.map(p => Number(p.promoPrice || p.price));
    const minPrice = Math.min(...priceValues);
    const maxPrice = Math.max(...priceValues);
    const range = maxPrice - minPrice || 1;
    
    const padding = { top: 12, bottom: 16, left: 8, right: 8 };
    const chartW = CHART_WIDTH - padding.left - padding.right;
    const chartH = CHART_HEIGHT - padding.top - padding.bottom;

    if (data.length === 1) {
        const x = padding.left + chartW / 2;
        const y = padding.top + chartH / 2;
        const price = Number(data[0].promoPrice || data[0].price);
        const dateStr = new Date(data[0].date).toLocaleDateString('lt-LT', { month: 'short', day: 'numeric' });

        return (
            <View style={styles.chartContainer}>
                <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
                    <Line x1={x} y1={y} x2={CHART_WIDTH - padding.right} y2={y} stroke="#2e7d32" strokeWidth={1.5} strokeDasharray="3,2" />
                    <Circle cx={x} cy={y} r={3} fill="#2e7d32" />
                    <SvgText x={x} y={CHART_HEIGHT - 2} fontSize={8} fill="#9e9e9e" textAnchor="middle">{dateStr}</SvgText>
                </Svg>
                <Text style={styles.chartPrice}>€{price.toFixed(2)}</Text>
            </View>
        );
    }

    // Multiple points
    const points = data.map((d, i) => {
        const x = padding.left + (i / (data.length - 1)) * chartW;
        const price = Number(d.promoPrice || d.price);
        const y = padding.top + chartH - ((price - minPrice) / range) * chartH;
        return { x, y, price, date: d.date };
    });

    return (
        <View style={styles.chartContainer}>
            <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
                {points.map((p, i) => {
                    if (i === 0) return null;
                    return (
                        <Line
                            key={i}
                            x1={points[i - 1].x} y1={points[i - 1].y}
                            x2={p.x} y2={p.y}
                            stroke="#2e7d32" strokeWidth={1.5}
                        />
                    );
                })}
                {/* Extend last point as dashed line */}
                {points.length > 0 && (
                    <Line
                        x1={points[points.length - 1].x}
                        y1={points[points.length - 1].y}
                        x2={CHART_WIDTH - padding.right}
                        y2={points[points.length - 1].y}
                        stroke="#2e7d32" strokeWidth={1.5} strokeDasharray="3,2"
                    />
                )}
                {points.map((p, i) => (
                    <Circle key={i} cx={p.x} cy={p.y} r={2.5} fill="#2e7d32" />
                ))}
            </Svg>
            <Text style={styles.chartPrice}>€{points[points.length - 1].price.toFixed(2)}</Text>
        </View>
    );
}

export default function ProductDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const [product, setProduct] = useState<Product | null>(null);
    const [storeProducts, setStoreProducts] = useState<StoreProduct[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedChainId, setSelectedChainId] = useState<number | null>(null);
    const [stores, setStores] = useState<Store[]>([]);
    const [selectedStoreId, setSelectedStoreId] = useState<number | null>(null);
    const [showStorePicker, setShowStorePicker] = useState(false);
    const [storeSearch, setStoreSearch] = useState('');
    const [priceCache, setPriceCache] = useState<{ [key: string]: PricePoint[] }>({});
    const [categories, setCategories] = useState<Category[]>([]);

    // Get unique chains from store products
    const chains = useMemo(() => {
        const chainMap = new Map<number, Chain>();
        storeProducts.forEach(sp => {
            if (!chainMap.has(sp.chainId)) {
                chainMap.set(sp.chainId, { id: sp.chainId, name: sp.chainName, logoUrl: sp.logoUrl });
            }
        });
        // Add all 3 chains even if no products
        return [
            chainMap.get(1) || { id: 1, name: 'MAXIMA LT, UAB', logoUrl: 'http://192.168.1.212:9000/chain-logos/maxima.png' },
            chainMap.get(2) || { id: 2, name: 'UAB RIMI LIETUVA', logoUrl: 'http://192.168.1.212:9000/chain-logos/rimi.png' },
            chainMap.get(3) || { id: 3, name: 'UAB IKI LIETUVA', logoUrl: 'http://192.168.1.212:9000/chain-logos/iki.png' },
        ];
    }, [storeProducts]);

    const filteredStoreProducts = useMemo(() => {
        if (!selectedChainId) return storeProducts;
        return storeProducts.filter(sp => sp.chainId === selectedChainId);
    }, [storeProducts, selectedChainId]);

    const hasProductsInChain = (chainId: number) => {
        return storeProducts.some(sp => sp.chainId === chainId);
    };

    const filteredStores = useMemo(() => {
        if (!storeSearch) return stores;
        const q = storeSearch.toLowerCase();
        return stores.filter(s => s.name.toLowerCase().includes(q) || s.address.toLowerCase().includes(q));
    }, [stores, storeSearch]);

    // Fetch product and store products
    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                const [prodRes, spRes] = await Promise.all([
                    fetch(`${API_BASE_URL}/api/products/${id}`),
                    fetch(`${API_BASE_URL}/api/store-products/product/${id}`),
                ]);
                const prodData = await prodRes.json();
                const spData = await spRes.json();
                setProduct(prodData);
                setStoreProducts(Array.isArray(spData) ? spData : []);

                // Auto-select first chain that has products
                const firstChain = spData.find((sp: StoreProduct) => sp.chainId);
                if (firstChain) {
                    setSelectedChainId(firstChain.chainId);
                }

                // Fetch category breadcrumb
                if (prodData.categoryId) {
                    const catRes = await fetch(`${API_BASE_URL}/api/categories/${prodData.categoryId}`);
                    const catData = await catRes.json();
                    if (catData.parentCategoryId) {
                        const parentRes = await fetch(`${API_BASE_URL}/api/categories/${catData.parentCategoryId}`);
                        const parentData = await parentRes.json();
                        setCategories([parentData, catData]);
                    } else {
                        setCategories([catData]);
                    }
                }
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [id]);

    // Fetch stores when chain changes
    useEffect(() => {
        if (!selectedChainId) return;
        const fetchStores = async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/api/stores/chain/${selectedChainId}`);
                const data = await res.json();
                setStores(Array.isArray(data) ? data : []);
                setSelectedStoreId(null);
                setShowStorePicker(false);
            } catch {}
        };
        fetchStores();
    }, [selectedChainId]);

    // Fetch price history for visible store products
    useEffect(() => {
        const fetchPrices = async () => {
            for (const sp of filteredStoreProducts) {
                const cacheKey = selectedStoreId
                    ? `${sp.id}-${selectedStoreId}`
                    : `${sp.id}-all`;

                if (priceCache[cacheKey]) continue;

                try {
                    const url = selectedStoreId
                        ? `${API_BASE_URL}/api/prices/store-product/${sp.id}/store/${selectedStoreId}/history`
                        : `${API_BASE_URL}/api/prices/store-product/${sp.id}/history`;
                    const res = await fetch(url);
                    const data = await res.json();
                    setPriceCache(prev => ({ ...prev, [cacheKey]: Array.isArray(data) ? data : [] }));
                } catch {
                    setPriceCache(prev => ({ ...prev, [cacheKey]: [] }));
                }
            }
        };
        if (filteredStoreProducts.length > 0) fetchPrices();
    }, [filteredStoreProducts, selectedStoreId]);

    const getPricesForSp = (spId: number): PricePoint[] => {
        const cacheKey = selectedStoreId ? `${spId}-${selectedStoreId}` : `${spId}-all`;
        return priceCache[cacheKey] || [];
    };

    if (loading) return <ActivityIndicator style={styles.centered} size="large" color="#2e7d32" />;
    if (!product) return <Text style={styles.centered}>Produktas nerastas</Text>;

    const breadcrumb = categories.map(c => c.name).join(' → ');

    return (
        <>
            <Stack.Screen options={{ 
                title: product.name,
                headerBackTitle: 'Atgal',
            }} />
                <ScrollView style={styles.container} stickyHeaderIndices={[1]}>
                {/* Header */}
                <View style={styles.header}>
                    <View style={styles.headerImageContainer}>
                        {product.imageUrl ? (
                            <Image source={{ uri: product.imageUrl }} style={styles.headerImage} resizeMode="contain" />
                        ) : (
                            <Ionicons name="cube-outline" size={64} color="#e0e0e0" />
                        )}
                    </View>
                    <Text style={styles.productName}>{product.name}</Text>
                    {breadcrumb ? <Text style={styles.breadcrumb}>{breadcrumb}</Text> : null}
                    {filteredStoreProducts.length > 0 && (
                        <Text style={styles.amountRange}>
                            {(() => {
                                const amounts = storeProducts.map(sp => parseFloat(sp.amount));
                                const units = storeProducts.map(sp => sp.unit);
                                const min = Math.min(...amounts);
                                const max = Math.max(...amounts);
                                const formatAmt = (val: number) => {
                                    const unit = units[0] || 'g';
                                    if (unit === 'g' && val >= 1000) return `${val / 1000} kg`;
                                    return `${val} ${unit}`;
                                };
                                return min === max ? formatAmt(min) : `${formatAmt(min)} – ${formatAmt(max)}`;
                            })()}
                        </Text>
                    )}
                </View>

                {/* Chain tabs */}
                <View style={styles.tabsWrapper}>
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.tabsContainer}
                    >
                        {chains.map(chain => {
                            const hasProducts = hasProductsInChain(chain.id);
                            const isSelected = selectedChainId === chain.id;
                            return (
                                <TouchableOpacity
                                    key={chain.id}
                                    style={[
                                        styles.chainTab,
                                        isSelected && styles.chainTabActive,
                                        !hasProducts && styles.chainTabDisabled,
                                    ]}
                                    onPress={() => {
                                        if (hasProducts) setSelectedChainId(chain.id);
                                    }}
                                    disabled={!hasProducts}
                                >
                                    <Image
                                        source={{ uri: chain.logoUrl }}
                                        style={[styles.chainLogo, !hasProducts && styles.chainLogoDisabled]}
                                        resizeMode="contain"
                                    />
                                    {!hasProducts && (
                                        <View style={styles.unavailableBadge}>
                                            <Text style={styles.unavailableText}>—</Text>
                                        </View>
                                    )}
                                </TouchableOpacity>
                            );
                        })}
                    </ScrollView>
                </View>

                {/* Store dropdown */}
                <View style={styles.dropdownSection}>
                    <TouchableOpacity
                        style={styles.dropdown}
                        onPress={() => setShowStorePicker(!showStorePicker)}
                    >
                        <Ionicons name="storefront-outline" size={18} color="#424242" />
                        <Text style={styles.dropdownText} numberOfLines={1}>
                            {selectedStoreId
                                ? stores.find(s => s.id === selectedStoreId)?.name || 'Parduotuvė'
                                : 'Visos parduotuvės'}
                        </Text>
                        <Ionicons name={showStorePicker ? 'chevron-up' : 'chevron-down'} size={18} color="#757575" />
                    </TouchableOpacity>

                    {showStorePicker && (
                        <View style={styles.storePickerContainer}>
                            <View style={styles.searchInputContainer}>
                                <Ionicons name="search" size={16} color="#9e9e9e" />
                                <TextInput
                                    style={styles.searchTextInput}
                                    placeholder="Ieškoti parduotuvės..."
                                    placeholderTextColor="#9e9e9e"
                                    value={storeSearch}
                                    onChangeText={setStoreSearch}
                                    autoFocus
                                />
                                {storeSearch.length > 0 && (
                                    <TouchableOpacity onPress={() => setStoreSearch('')}>
                                        <Ionicons name="close-circle" size={16} color="#9e9e9e" />
                                    </TouchableOpacity>
                                )}
                            </View>
                            <TouchableOpacity
                                style={[styles.storeOption, !selectedStoreId && styles.storeOptionActive]}
                                onPress={() => { setSelectedStoreId(null); setShowStorePicker(false); }}
                            >
                                <Text style={[styles.storeOptionText, !selectedStoreId && styles.storeOptionTextActive]}>
                                    Visos parduotuvės
                                </Text>
                            </TouchableOpacity>
                            <ScrollView style={styles.storeList}>
                                {filteredStores.map(item => (
                                    <TouchableOpacity
                                        key={item.id}
                                        style={[styles.storeOption, selectedStoreId === item.id && styles.storeOptionActive]}
                                        onPress={() => { setSelectedStoreId(item.id); setShowStorePicker(false); }}
                                    >
                                        <Text style={[styles.storeOptionText, selectedStoreId === item.id && styles.storeOptionTextActive]}>
                                            {item.name}
                                        </Text>
                                        <Text style={styles.storeAddress} numberOfLines={1}>{item.address}</Text>
                                    </TouchableOpacity>
                                ))}
                            </ScrollView>
                        </View>
                    )}
                </View>

                {/* StoreProduct list */}
                {filteredStoreProducts.length === 0 ? (
                    <View style={styles.emptyContainer}>
                        <Ionicons name="alert-circle-outline" size={40} color="#e0e0e0" />
                        <Text style={styles.emptyText}>Šioje parduotuvių tinkle produktas nepasiekiamas</Text>
                    </View>
                ) : (
                    filteredStoreProducts.map(sp => {
                        const prices = getPricesForSp(sp.id);
                        const latestPrice = prices.length > 0
                            ? prices[prices.length - 1]
                            : null;
                        const amt = parseFloat(sp.amount);
                        const amountStr = sp.unit === 'g' && amt >= 1000
                            ? `${amt / 1000} kg`
                            : `${amt} ${sp.unit}`;

                        return (
                            <View key={sp.id} style={styles.spCard}>
                                <View style={styles.spLeft}>
                                    {product.imageUrl ? (
                                        <Image source={{ uri: product.imageUrl }} style={styles.spImage} resizeMode="contain" />
                                    ) : (
                                        <View style={styles.spImagePlaceholder}>
                                            <Ionicons name="cube-outline" size={24} color="#e0e0e0" />
                                        </View>
                                    )}
                                    <View style={styles.spInfo}>
                                        <Text style={styles.spName} numberOfLines={2}>{sp.storeProductName}</Text>
                                        <Text style={styles.spAmount}>{amountStr}</Text>
                                        {latestPrice && (
                                            <View style={styles.priceRow}>
                                                <Text style={[
                                                    styles.spPrice,
                                                    latestPrice.promoPrice != null && styles.spPriceStrike,
                                                ]}>
                                                    €{Number(latestPrice.price).toFixed(2)}
                                                </Text>
                                                {latestPrice.promoPrice && (
                                                    <Text style={styles.spPromoPrice}>
                                                        €{Number(latestPrice.promoPrice).toFixed(2)}
                                                    </Text>
                                                )}
                                            </View>
                                        )}
                                    </View>
                                </View>
                                <View style={styles.spRight}>
                                    <MiniPriceChart prices={prices} />
                                </View>
                            </View>
                        );
                    })
                )}
                <View style={{ height: 40 }} />
            </ScrollView>
        </>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

    // Header
    header: {
        backgroundColor: 'white',
        alignItems: 'center',
        paddingVertical: 24,
        paddingHorizontal: 16,
        borderBottomWidth: 0.5,
        borderBottomColor: '#e0e0e0',
    },
    headerImageContainer: {
        width: 160,
        height: 160,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 16,
    },
    headerImage: { width: '100%', height: '100%' },
    productName: {
        fontSize: 20,
        fontWeight: '700',
        color: '#212121',
        textAlign: 'center',
        marginBottom: 4,
    },
    breadcrumb: {
        fontSize: 12,
        color: '#9e9e9e',
        textAlign: 'center',
        marginBottom: 4,
    },
    amountRange: {
        fontSize: 14,
        color: '#757575',
        marginTop: 4,
    },

    // Chain tabs
    tabsWrapper: {
        backgroundColor: 'white',
        borderBottomWidth: 0.5,
        borderBottomColor: '#e0e0e0',
        zIndex: 10,
    },
    tabsContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
    },
    chainTab: {
        width: 64,
        height: 44,
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: '#e0e0e0',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'white',
        position: 'relative',
    },
    chainTabActive: {
        borderColor: '#2e7d32',
        backgroundColor: '#f1f8e9',
    },
    chainTabDisabled: {
        opacity: 0.4,
        backgroundColor: '#fafafa',
    },
    chainLogo: {
        width: 48,
        height: 28,
    },
    chainLogoDisabled: {
        opacity: 0.5,
    },
    unavailableBadge: {
        position: 'absolute',
        top: -6,
        right: -6,
        backgroundColor: '#ef5350',
        borderRadius: 8,
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    unavailableText: {
        color: 'white',
        fontSize: 10,
        fontWeight: '700',
    },

    // Dropdown
    dropdownSection: {
        paddingHorizontal: 16,
        paddingTop: 12,
    },
    dropdown: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'white',
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 11,
        gap: 8,
        borderWidth: 1,
        borderColor: '#e0e0e0',
    },
    dropdownText: {
        flex: 1,
        fontSize: 14,
        color: '#424242',
    },
    storePickerContainer: {
        backgroundColor: 'white',
        borderRadius: 10,
        marginTop: 8,
        borderWidth: 1,
        borderColor: '#e0e0e0',
        maxHeight: 260,
        overflow: 'hidden',
    },
    searchInputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 8,
        borderBottomWidth: 0.5,
        borderBottomColor: '#e0e0e0',
    },
    searchInput: { flex: 1 },
    searchPlaceholder: { fontSize: 13, color: '#9e9e9e' },
    storeList: { maxHeight: 200 },
    storeOption: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderBottomWidth: 0.5,
        borderBottomColor: '#f5f5f5',
    },
    storeOptionActive: {
        backgroundColor: '#f1f8e9',
    },
    storeOptionText: {
        fontSize: 13,
        color: '#424242',
    },
    storeOptionTextActive: {
        color: '#2e7d32',
        fontWeight: '600',
    },
    storeAddress: {
        fontSize: 11,
        color: '#9e9e9e',
        marginTop: 2,
    },

    // StoreProduct cards
    spCard: {
        flexDirection: 'row',
        backgroundColor: 'white',
        marginHorizontal: 16,
        marginTop: 10,
        borderRadius: 12,
        padding: 12,
        elevation: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
    },
    spLeft: {
        flex: 1,
        flexDirection: 'row',
        gap: 10,
    },
    spImage: {
        width: 52,
        height: 52,
        borderRadius: 8,
    },
    spImagePlaceholder: {
        width: 52,
        height: 52,
        borderRadius: 8,
        backgroundColor: '#f5f5f5',
        alignItems: 'center',
        justifyContent: 'center',
    },
    spInfo: {
        flex: 1,
        justifyContent: 'center',
    },
    spName: {
        fontSize: 13,
        color: '#212121',
        fontWeight: '500',
        lineHeight: 18,
    },
    spAmount: {
        fontSize: 12,
        color: '#9e9e9e',
        marginTop: 2,
    },
    priceRow: {
        flexDirection: 'row',
        gap: 6,
        alignItems: 'center',
        marginTop: 3,
    },
    spPrice: {
        fontSize: 14,
        fontWeight: '700',
        color: '#212121',
    },
    spPriceStrike: {
        textDecorationLine: 'line-through',
        color: '#9e9e9e',
        fontWeight: '400',
        fontSize: 12,
    },
    spPromoPrice: {
        fontSize: 14,
        fontWeight: '700',
        color: '#d32f2f',
    },
    spRight: {
        justifyContent: 'center',
        alignItems: 'center',
    },

    // Chart
    chartContainer: {
        alignItems: 'center',
    },
    chartEmpty: {
        width: CHART_WIDTH,
        height: CHART_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    chartPrice: {
        fontSize: 10,
        color: '#2e7d32',
        fontWeight: '600',
        marginTop: 2,
    },

    // Empty
    emptyContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        padding: 48,
        gap: 12,
    },
    emptyText: {
        fontSize: 14,
        color: '#9e9e9e',
        textAlign: 'center',
    },
    searchTextInput: {
        flex: 1,
        fontSize: 13,
        color: '#424242',
        paddingVertical: 0,
    },
});