import { View, Text, StyleSheet, ScrollView, ActivityIndicator, DimensionValue } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../config/api';
import { Stack } from 'expo-router';

interface ParsedProduct {
    name: string;
    matchedName?: string | null;
    storeProductId?: number | null;
    matchConfirmed?: boolean;
    price: number;
    promoPrice: number | null;
    quantity: number;
    unit?: string | null;
}

interface ParsedHeader {
    chainName?: string | null;
    storeName?: string | null;
    storeAddressMatched?: string | null;
    storeAddress?: string | null;
}

interface ParsedFooter {
    total?: number | null;
    date?: string | null;
    time?: string | null;
    receiptNo?: string | null;
}

interface ParsedData {
    header?: ParsedHeader;
    products?: ParsedProduct[];
    footer?: ParsedFooter;
}

interface Receipt {
    id: number;
    filePath: string;
    fileType: string;
    processingStatus: string;
    receiptDate: string | null;
    receiptNo: string | null;
    chainName: string | null;
    parsedData?: ParsedData | string | null;
}
interface ComparisonChain {
    chainId: number;
    chainName: string;
    storeId: number;
    storeName: string;
    storeAddress: string;
    distanceKm: number;
    total: number;
    savings: number;
    comparedItems: number;
    missingItems: number;
    note?: string;
    chainLogoUrl: string | null;
}

interface ReceiptComparison {
    currentChain: {
        chainId: number;
        chainName: string;
        storeId: number;
        storeName: string;
        storeAddress: string;
        total: number;
        comparedItems: number;
        missingItems: number;
        chainLogoUrl: string | null;
    };
    alternatives: ComparisonChain[];
    summary: {
        recognizedItems: number;
        excludedItems: number;
        note?: string;
    };
}
const getStatusText = (status: string) => {
    switch (status) {
        case 'completed': return 'Apdorotas';
        case 'processing': return 'Apdorojama';
        case 'failed': return 'Nepavyko';
        default: return 'Laukiama';
    }
};

const getStatusColor = (status: string) => {
    switch (status) {
        case 'completed': return '#2e7d32';
        case 'processing': return '#f57c00';
        case 'failed': return '#c62828';
        default: return '#757575';
    }
};

export default function ReceiptDetailScreen() {
    const { id } = useLocalSearchParams();
    const receiptId = Array.isArray(id) ? id[0] : id;
    const [receipt, setReceipt] = useState<Receipt | null>(null);
    const [loading, setLoading] = useState(true);
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [comparison, setComparison] = useState<ReceiptComparison | null>(null);
    const [comparisonLoading, setComparisonLoading] = useState(false);
    const [comparisonError, setComparisonError] = useState<string | null>(null);

    const fetchComparison = async (receiptId: string | number) => {
        try {
            setComparisonLoading(true);
            setComparisonError(null);
            const res = await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/comparison`);
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Nepavyko gauti palyginimo');
            setComparison(data);
        } catch (e: any) {
            setComparisonError(e?.message || 'Nepavyko gauti palyginimo');
        } finally {
            setComparisonLoading(false);
        }
    };
    useEffect(() => {
        const fetchReceipt = async () => {
            try {
                const response = await fetch(`${API_BASE_URL}/api/receipts/${id}`);
                const data = await response.json();
                setReceipt(data);
                await fetchComparison(id as string);
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

    if (loading) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" color="#2e7d32" />
            </View>
        );
    }
    const parsedData: ParsedData | null = (() => {
        if (!receipt?.parsedData) return null;
        if (typeof receipt.parsedData === 'string') {
            try {
                return JSON.parse(receipt.parsedData);
            } catch {
                return null;
            }
        }
        return receipt.parsedData;
    })();

    const parsedHeader = parsedData?.header;
    const parsedFooter = parsedData?.footer;
    const parsedProducts: ParsedProduct[] = Array.isArray(parsedData?.products)
        ? parsedData.products
        : [];
        const bestAlt = comparison?.alternatives?.[0] ?? null;
        const hasSavings = !!bestAlt && bestAlt.savings > 0;

        const totals = comparison
            ? [comparison.currentChain.total, ...comparison.alternatives.map((a) => a.total)]
                .filter((n) => Number.isFinite(n) && n >= 0)
            : [];

        const maxTotal = totals.length ? Math.max(...totals) : 1;

        const barWidth = (total: number): DimensionValue => {
            const pct = Math.max(8, (total / Math.max(maxTotal, 1)) * 100);
            return `${pct}%` as `${number}%`;
        };
    if (!receipt) {
        return (
            <View style={styles.centered}>
                <Text>Kvitas nerastas</Text>
            </View>
        );
    }

    return (
        <ScrollView style={styles.container}>
            <Stack.Screen
                options={{
                    title: (parsedFooter?.receiptNo || receipt.receiptNo)
                        ? `Kvitas Nr. ${parsedFooter?.receiptNo || receipt.receiptNo}`
                        : 'Kvitas',
                }}
            />

            {comparisonLoading && (
                <View style={styles.sectionCard}>
                    <Text style={styles.sectionTitle}>Kainų palyginimas</Text>
                    <Text style={styles.sectionSubvalue}>Skaičiuojama...</Text>
                </View>
            )}

            {!!comparisonError && (
                <View style={styles.sectionCard}>
                    <Text style={styles.sectionTitle}>Kainų palyginimas</Text>
                    <Text style={[styles.sectionSubvalue, { color: '#c62828' }]}>{comparisonError}</Text>
                </View>
            )}

            {comparison && (
                <View style={[styles.sectionCard, hasSavings && styles.savingsCard]}>
                    <Text style={styles.sectionTitle}>Kainų palyginimas</Text>

                    {hasSavings ? (
                        <Text style={styles.savingsText}>
                            Sutaupytumėte €{bestAlt!.savings.toFixed(2)} pasirinkę {bestAlt!.chainName}
                        </Text>
                    ) : (
                        <Text style={styles.sectionSubvalue}>Pigiau nerasta pagal turimus duomenis</Text>
                    )}

                    <Text style={[styles.sectionSubvalue, { marginTop: 8 }]}>
                        Lyginta pagal {comparison.summary.recognizedItems} atpažintas prekes
                        {comparison.summary.excludedItems > 0 ? `, neįtraukta: ${comparison.summary.excludedItems}` : ''}
                    </Text>
                    {!!comparison.summary.note && <Text style={styles.warningText}>{comparison.summary.note}</Text>}

                    <View style={{ marginTop: 12, gap: 10 }}>
                        <View>
                            <Text style={styles.footerLabel}>
                                Jūsų parduotuvė: {comparison.currentChain.chainName} ({comparison.currentChain.storeName})
                            </Text>
                            <View style={styles.compareBarTrack}>
                                <View style={[styles.compareBarFillCurrent, { width: barWidth(comparison.currentChain.total) }]} />
                            </View>
                            <Text style={styles.footerValue}>€{comparison.currentChain.total.toFixed(2)}</Text>
                        </View>

                        {comparison.alternatives.map((alt) => (
                            <View key={`${alt.chainId}-${alt.storeId}`}>
                                <Text style={styles.footerLabel}>
                                    {alt.chainName} ({alt.storeName}) • {alt.distanceKm.toFixed(1)} km
                                </Text>
                                <View style={styles.compareBarTrack}>
                                    <View style={[styles.compareBarFillAlt, { width: barWidth(alt.total) }]} />
                                </View>
                                <Text style={styles.footerValue}>
                                    €{alt.total.toFixed(2)}
                                    {alt.savings > 0 ? `  (−€${alt.savings.toFixed(2)})` : ''}
                                </Text>
                                {!!alt.note && <Text style={styles.warningText}>{alt.note}</Text>}
                            </View>
                        ))}
                    </View>
                </View>
            )}

            <View style={styles.sectionCard}>
                <View style={styles.chainRow}>
                    <Text style={styles.chainBadge}>{parsedHeader?.chainName || receipt.chainName || 'Neatpažinta'}</Text>
                    <Ionicons
                        name="checkmark-circle"
                        size={20}
                        color={receipt.processingStatus === 'completed' ? '#2e7d32' : '#f57c00'}
                        style={{ marginLeft: 8 }}
                    />
                </View>
                {!!parsedHeader?.storeName && <Text style={styles.storeName}>{parsedHeader.storeName}</Text>}
                {!!(parsedHeader?.storeAddressMatched || parsedHeader?.storeAddress) && (
                    <Text style={styles.sectionSubvalue}>
                        {parsedHeader?.storeAddressMatched || parsedHeader?.storeAddress}
                    </Text>
                )}
            </View>

            <View style={styles.productsHeader}>
                <Ionicons name="cart-outline" size={20} color="#2e7d32" />
                <Text style={styles.sectionTitle}>Prekės ({parsedProducts.length})</Text>
            </View>

            {parsedProducts.map((product: ParsedProduct, index: number) => (
                <View key={index} style={styles.productCard}>
                    <View style={styles.productRow}>
                        <View style={styles.productInfo}>
                            {product.matchedName ? (
                                <>
                                    <Text style={[styles.matchedName, product.matchConfirmed === false && { color: '#f57c00' }]}>
                                        {product.matchedName}
                                    </Text>
                                    <Text style={styles.ocrName}>{product.name}</Text>
                                </>
                            ) : (
                                <Text style={styles.productName}>{product.name}</Text>
                            )}
                            <Text style={styles.productQuantity}>
                                {product.quantity} {product.unit || ''}
                            </Text>
                        </View>

                        <View style={styles.productPriceCol}>
                            {product.promoPrice !== null && product.promoPrice !== undefined ? (
                                <>
                                    <Text style={styles.productPriceStrike}>€{Number(product.price || 0).toFixed(2)}</Text>
                                    <Text style={styles.productPromoPrice}>€{Number(product.promoPrice).toFixed(2)}</Text>
                                </>
                            ) : (
                                <Text style={styles.productPrice}>€{Number(product.price || 0).toFixed(2)}</Text>
                            )}
                        </View>

                        <View style={styles.matchIndicator}>
                            <Ionicons
                                name={product.matchConfirmed ? 'checkmark-circle' : 'warning'}
                                size={20}
                                color={product.matchConfirmed ? '#2e7d32' : '#f57c00'}
                            />
                        </View>
                    </View>
                </View>
            ))}

            {parsedProducts.length === 0 && (
                <View style={styles.emptyProducts}>
                    <Ionicons name="alert-circle-outline" size={32} color="#e0e0e0" />
                    <Text style={styles.emptyText}>Prekės neatpažintos</Text>
                </View>
            )}

            <View style={styles.sectionCard}>
                <Text style={styles.sectionTitle}>Kvito duomenys</Text>
                <View style={styles.footerContent}>
                    <View style={styles.footerRow}>
                        <Text style={styles.footerLabel}>Suma:</Text>
                        <Text style={styles.footerValue}>
                            {typeof parsedFooter?.total === 'number' ? `€${parsedFooter.total.toFixed(2)}` : '—'}
                        </Text>
                    </View>
                    <View style={styles.footerRow}>
                        <Text style={styles.footerLabel}>Data:</Text>
                        <Text style={styles.footerValue}>{parsedFooter?.date || '—'} {parsedFooter?.time || ''}</Text>
                    </View>
                    <View style={styles.footerRow}>
                        <Text style={styles.footerLabel}>Kvito Nr.:</Text>
                        <Text style={styles.footerValue}>{parsedFooter?.receiptNo || receipt.receiptNo || '—'}</Text>
                    </View>
                </View>
            </View>

            <View style={{ height: 40 }} />
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

    sectionCard: {
        backgroundColor: 'white',
        marginHorizontal: 16,
        marginTop: 16,
        borderRadius: 12,
        padding: 16,
        elevation: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
    },
    sectionTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: '#212121' },
    sectionSubvalue: { fontSize: 13, color: '#757575', marginTop: 4 },
    warningText: { fontSize: 12, color: '#f57c00', marginTop: 4 },

    savingsCard: {
        borderWidth: 1,
        borderColor: '#a5d6a7',
        backgroundColor: '#e8f5e9',
    },
    savingsText: { marginTop: 6, fontSize: 14, fontWeight: '700', color: '#1b5e20' },

    compareBarTrack: {
        marginTop: 6,
        height: 8,
        borderRadius: 999,
        backgroundColor: '#eeeeee',
        overflow: 'hidden',
    },
    compareBarFillCurrent: { height: '100%', backgroundColor: '#1565c0', borderRadius: 999 },
    compareBarFillAlt: { height: '100%', backgroundColor: '#2e7d32', borderRadius: 999 },

    chainRow: { flexDirection: 'row', alignItems: 'center' },
    chainBadge: { fontSize: 18, fontWeight: '700', color: '#212121' },
    storeName: { fontSize: 14, color: '#424242', marginTop: 4 },

    productsHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 16,
        marginTop: 20,
        marginBottom: 4,
    },
    productCard: {
        backgroundColor: 'white',
        marginHorizontal: 16,
        marginTop: 8,
        borderRadius: 12,
        padding: 14,
        elevation: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
    },
    productRow: { flexDirection: 'row', alignItems: 'center' },
    productInfo: { flex: 1 },
    productName: { fontSize: 14, color: '#212121', fontWeight: '500' },
    matchedName: { fontSize: 14, color: '#2e7d32', fontWeight: '600' },
    ocrName: { fontSize: 11, color: '#9e9e9e', marginTop: 2 },
    productQuantity: { fontSize: 12, color: '#757575', marginTop: 2 },
    productPriceCol: { alignItems: 'flex-end', marginRight: 8 },
    productPrice: { fontSize: 15, fontWeight: '700', color: '#212121' },
    productPriceStrike: { fontSize: 12, color: '#9e9e9e', textDecorationLine: 'line-through' },
    productPromoPrice: { fontSize: 15, fontWeight: '700', color: '#d32f2f' },
    matchIndicator: { marginLeft: 4 },

    footerContent: { marginTop: 10 },
    footerRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
    footerLabel: { fontSize: 13, color: '#757575' },
    footerValue: { fontSize: 13, fontWeight: '600', color: '#212121' },

    emptyProducts: { alignItems: 'center', padding: 32, gap: 8 },
    emptyText: { fontSize: 14, color: '#9e9e9e' },
});