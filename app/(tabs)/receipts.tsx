import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

interface Receipt {
    id: number;
    filePath: string;
    fileType: string;
    processingStatus: string;
    receiptDate: string | null;
    receiptNo: string | null;
}

export default function ReceiptsScreen() {
    const [receipts, setReceipts] = useState<Receipt[]>([]);
    const [loading, setLoading] = useState(true);
    const router = useRouter();

    const fetchReceipts = async () => {
        try {
            const userId = await getUserId();
            const response = await fetch(`${API_BASE_URL}/api/users/${userId}/receipts`);
            const data = await response.json();
            setReceipts(data);
        } catch (error) {
            console.error('Failed to fetch receipts:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchReceipts();
    }, []);

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'completed': return '#2e7d32';
            case 'processing': return '#f57c00';
            case 'failed': return '#c62828';
            default: return '#757575';
        }
    };

    const getStatusText = (status: string) => {
        switch (status) {
            case 'completed': return 'Apdorotas';
            case 'processing': return 'Apdorojama';
            case 'failed': return 'Nepavyko';
            default: return 'Laukiama';
        }
    };

    if (loading) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" color="#2e7d32" />
            </View>
        );
    }
    const handleUpload = async () => {
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            base64: true,
            quality: 1,
        });

        if (result.canceled || !result.assets[0]) return;

        const asset = result.assets[0];
        const filename = asset.fileName || 'receipt.jpg';
        const mimeType = asset.mimeType || 'image/jpeg';
        const imageBase64 = asset.base64;
        const userId = await getUserId();

        try {
            const response = await fetch(`${API_BASE_URL}/api/receipts/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageBase64, filename, mimeType, userId }),
            });
            const data = await response.json();
            if (data.receiptId) {
                fetchReceipts();
            }
        } catch (error) {
            console.error('Upload failed:', error);
        }
    };

    return (
        <View style={styles.container}>
            <FlatList
                data={receipts}
                keyExtractor={(item) => item.id.toString()}
                contentContainerStyle={styles.list}
                ListEmptyComponent={
                    <View style={styles.centered}>
                        <Text style={styles.emptyText}>Kvitų nėra</Text>
                    </View>
                }
                renderItem={({ item }) => (
                    <TouchableOpacity style={styles.card} onPress={() => router.push(`/receipt/${item.id}`)}>
                        <View style={styles.cardLeft}>
                            <Ionicons name="receipt-outline" size={28} color="#2e7d32" />
                        </View>
                        <View style={styles.cardContent}>
                            <Text style={styles.cardTitle}>
                                {item.receiptNo ? `Kvitas Nr. ${item.receiptNo}` : 'Kvitas'}
                            </Text>
                            <Text style={styles.cardDate}>
                                {item.receiptDate
                                    ? new Date(item.receiptDate).toLocaleDateString('lt-LT')
                                    : 'Data nenurodyta'}
                            </Text>
                        </View>
                        <View style={[styles.statusBadge, { backgroundColor: getStatusColor(item.processingStatus) }]}>
                            <Text style={styles.statusText}>{getStatusText(item.processingStatus)}</Text>
                        </View>
                    </TouchableOpacity>
                )}
            />
            <TouchableOpacity style={styles.fab} onPress={handleUpload}>
                <Ionicons name="add" size={28} color="white" />
            </TouchableOpacity>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    list: { padding: 16, paddingBottom: 80 },
    card: {
        backgroundColor: 'white',
        borderRadius: 12,
        padding: 16,
        marginBottom: 12,
        flexDirection: 'row',
        alignItems: 'center',
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
    },
    cardLeft: { marginRight: 12 },
    cardContent: { flex: 1 },
    cardTitle: { fontSize: 15, fontWeight: '600', color: '#212121' },
    cardDate: { fontSize: 13, color: '#757575', marginTop: 2 },
    statusBadge: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
    },
    statusText: { fontSize: 11, color: 'white', fontWeight: '600' },
    emptyText: { fontSize: 16, color: '#757575' },
    fab: {
        position: 'absolute',
        bottom: 24,
        right: 24,
        backgroundColor: '#2e7d32',
        width: 56,
        height: 56,
        borderRadius: 28,
        alignItems: 'center',
        justifyContent: 'center',
        elevation: 4,
    },
});