import { View, Text, StyleSheet, ScrollView, Image, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../config/api';
import { Stack } from 'expo-router';
import ReceiptItemEditSheet from '../../components/ReceiptItemEditSheet';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

interface Receipt {
    id: number;
    filePath: string;
    fileType: string;
    processingStatus: string;
    receiptDate: string | null;
    receiptNo: string | null;
    chainName: string | null;
    parsedData?: {
        items: {
            name: string;
            price: number | null;
            promoPrice: number | null;
            categoryId?: number | null;
            categoryName?: string | null;
        }[];
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
    const [items, setItems] = useState<any[]>([]);
    const [chainId, setChainId] = useState<number | null>(null);

    useEffect(() => {
        const fetchReceipt = async () => {
            try {
                const response = await fetch(`${API_BASE_URL}/api/receipts/${id}`);
                const data = await response.json();
                setReceipt(data);

                if (data.chainName) {
                    const chainRes = await fetch(`${API_BASE_URL}/api/chains?name=${encodeURIComponent(data.chainName)}`);
                    const chainData = await chainRes.json();
                    if (chainData.length > 0) setChainId(chainData[0].id);
                }

                const imageResponse = await fetch(`${API_BASE_URL}/api/receipts/${id}/image`);
                const imageData = await imageResponse.json();
                setImageUrl(imageData.url);

                const itemsResponse = await fetch(`${API_BASE_URL}/api/receipts/${id}/items`);
                const itemsData = await itemsResponse.json();
                setItems(Array.isArray(itemsData) ? itemsData : []);
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

    if (!receipt) {
        return (
            <View style={styles.centered}>
                <Text>Kvitas nerastas</Text>
            </View>
        );
    }

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <ScrollView style={styles.container}>
                <Stack.Screen options={{ title: receipt.receiptNo ? `Kvitas Nr. ${receipt.receiptNo}` : 'Kvitas' }} />
                {/* Receipt Image */}
                <View style={styles.imageContainer}>
                    <Image
                        source={{ uri: imageUrl || '' }}
                        style={styles.image}
                        resizeMode="contain"
                    />
                </View>

                {/* Details Card */}
                <View style={styles.card}>
                    <View style={styles.row}>
                        <Ionicons name="storefront-outline" size={20} color="#757575" />
                        <View style={styles.rowContent}>
                            <Text style={styles.label}>Parduotuvė</Text>
                            <Text style={styles.value}>{receipt.chainName || '—'}</Text>
                        </View>
                    </View>

                    <View style={styles.divider} />

                    <View style={styles.row}>
                        <Ionicons name="calendar-outline" size={20} color="#757575" />
                        <View style={styles.rowContent}>
                            <Text style={styles.label}>Data</Text>
                            <Text style={styles.value}>
                                {receipt.receiptDate
                                    ? new Date(receipt.receiptDate).toLocaleDateString('lt-LT')
                                    : '—'}
                            </Text>
                        </View>
                    </View>

                    <View style={styles.divider} />

                    <View style={styles.row}>
                        <Ionicons name="checkmark-circle-outline" size={20} color={getStatusColor(receipt.processingStatus)} />
                        <View style={styles.rowContent}>
                            <Text style={styles.label}>Būsena</Text>
                            <Text style={[styles.value, { color: getStatusColor(receipt.processingStatus) }]}>
                                {getStatusText(receipt.processingStatus)}
                            </Text>
                        </View>
                    </View>
                </View>

                {receipt.parsedData?.items && (
                    <View style={styles.card}>
                        <Text style={styles.sectionTitle}>Produktai</Text>
                        {items.map((item: any, index: number) => (
                            <View key={index} style={styles.itemRow}>
                                <View style={styles.itemContent}>
                                    <Text style={styles.itemName}>{item.name}</Text>
                                    <Text style={styles.itemCategory}>{item.categoryName}</Text>
                                    <View style={styles.itemPriceRow}>
                                        <Text style={[styles.itemPrice, item.promoPrice && styles.itemPriceCrossed]}>
                                            €{parseFloat(item.price).toFixed(2)}
                                        </Text>
                                        {item.promoPrice && (
                                            <Text style={styles.itemPromoPrice}>
                                                €{parseFloat(item.promoPrice).toFixed(2)}
                                            </Text>
                                        )}
                                    </View>
                                </View>
                                <TouchableOpacity style={styles.editButton} onPress={() => ReceiptItemEditSheet.open(item)}>
                                    <Ionicons name="pencil-outline" size={18} color="#2e7d32" />
                                </TouchableOpacity>
                            </View>
                            
                        ))}
                        <TouchableOpacity 
                            style={styles.addItemButton}
                            onPress={() => ReceiptItemEditSheet.openNew()}
                        >
                            <Ionicons name="add-circle-outline" size={20} color="#2e7d32" />
                            <Text style={styles.addItemText}>Pridėti trūkstamą produktą</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </ScrollView>

            <ReceiptItemEditSheet
                receiptId={Number(receiptId)}
                chainId={chainId}
                onSaved={async () => {
                    const itemsResponse = await fetch(`${API_BASE_URL}/api/receipts/${id}/items`);
                    const itemsData = await itemsResponse.json();
                    setItems(Array.isArray(itemsData) ? itemsData : []);
                }}
            />
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    header: {
        padding: 16,
        backgroundColor: 'white',
        borderBottomWidth: 1,
        borderBottomColor: '#e0e0e0',
    },
    receiptNo: { fontSize: 18, fontWeight: '700', color: '#212121' },
    imageContainer: {
        backgroundColor: 'white',
        margin: 16,
        borderRadius: 12,
        overflow: 'hidden',
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
    },
    image: { width: '100%', height: 400 },
    card: {
        backgroundColor: 'white',
        margin: 16,
        marginTop: 0,
        borderRadius: 12,
        padding: 16,
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
    },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
    rowContent: { marginLeft: 12, flex: 1 },
    label: { fontSize: 12, color: '#757575' },
    value: { fontSize: 15, color: '#212121', marginTop: 2, fontWeight: '500' },
    divider: { height: 1, backgroundColor: '#f0f0f0', marginVertical: 4 },
    sectionTitle: { fontSize: 16, fontWeight: '700', color: '#212121', marginBottom: 12 },
    itemRow: {
        flexDirection: 'row', alignItems: 'center',
        paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
    },
    itemContent: { flex: 1 },
    itemName: { fontSize: 14, color: '#212121', fontWeight: '500' },
    itemCategory: { fontSize: 11, color: '#9e9e9e', marginTop: 2 },
    itemPriceRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 8 },
    itemPrice: { fontSize: 14, color: '#2e7d32', fontWeight: '600' },
    itemPriceCrossed: { textDecorationLine: 'line-through', color: '#9e9e9e' },
    itemPromoPrice: { fontSize: 14, color: '#c62828', fontWeight: '600' },
    editButton: { padding: 8 },
    addItemButton: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
    gap: 8,
    },
    addItemText: { fontSize: 14, color: '#2e7d32', fontWeight: '500' },
});