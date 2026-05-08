import { View, FlatList, TouchableOpacity, Text, StyleSheet, ActivityIndicator, LayoutAnimation } from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../../config/api';
import { useTheme, type AppTheme } from '../../../constants/theme';

interface Category {
    id: number;
    name: string;
    parentCategoryId: number | null;
}

const CATEGORY_ICONS: Record<string, string> = {
    'Daržovės ir vaisiai': '🥦',
    'Pieno gaminiai, kiaušiniai ir majonezas': '🥛',
    'Duonos gaminiai ir konditerija': '🍞',
    'Mėsa, žuvis ir kulinarija': '🥩',
    'Bakalėja': '🫙',
    'Šaldytas maistas': '🧊',
    'Gėrimai': '🥤',
    'Kūdikių ir vaikų prekės': '🍼',
    'Kosmetika ir higiena': '🧴',
    'Švaros ir gyvūnų prekės': '🧹',
    'Namai ir laisvalaikis': '🏠',
};

export default function ReceiptBrowseIndex() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { chainId, productIndex, preselectL1, ocrName } = useLocalSearchParams<{
        chainId: string;
        productIndex: string;
        preselectL1?: string;
        ocrName?: string;
    }>();
    const router = useRouter();
    const [l1Categories, setL1Categories] = useState<Category[]>([]);
    const [l2Map, setL2Map] = useState<Record<number, Category[]>>({});
    const [expandedL1, setExpandedL1] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/api/categories`);
                const data = await res.json();
                const l1s = Array.isArray(data) ? data : [];
                setL1Categories(l1s);

                if (preselectL1) {
                    const preselId = Number(preselectL1);
                    const subRes = await fetch(`${API_BASE_URL}/api/categories/${preselId}/subcategories`);
                    const subData = await subRes.json();
                    setL2Map({ [preselId]: Array.isArray(subData) ? subData : [] });
                    setExpandedL1(preselId);
                }
            } finally {
                setLoading(false);
            }
        })();
    }, [preselectL1]);

    const toggleL1 = async (id: number) => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        if (expandedL1 === id) {
            setExpandedL1(null);
            return;
        }
        setExpandedL1(id);
        if (!l2Map[id]) {
            const res = await fetch(`${API_BASE_URL}/api/categories/${id}/subcategories`);
            const data = await res.json();
            setL2Map(prev => ({ ...prev, [id]: Array.isArray(data) ? data : [] }));
        }
    };

    if (loading) return <ActivityIndicator style={styles.centered} size="large" color={colors.primary} />;

    return (
        <>
            <Stack.Screen
                options={{
                    title: 'Pasirinkite kategoriją',
                    headerRight: () => (
                        <TouchableOpacity
                            onPress={() => router.push({
                                pathname: '/search',
                                params: {
                                    mode: 'store-products',
                                    chainId,
                                    productIndex,
                                    source: 'receipt-index',
                                    ...(ocrName ? { ocrName } : {}),
                                },
                            })}
                            style={{ marginRight: 12 }}
                        >
                            <Ionicons name="search" size={24} color={colors.primary} />
                        </TouchableOpacity>
                    ),
                }}
            />
            <FlatList
                data={l1Categories}
                keyExtractor={item => item.id.toString()}
                contentContainerStyle={styles.list}
                renderItem={({ item }) => {
                    const isExpanded = expandedL1 === item.id;
                    const l2 = l2Map[item.id] || [];
                    return (
                        <View style={styles.l1Container}>
                            <TouchableOpacity style={styles.l1Row} onPress={() => toggleL1(item.id)}>
                                <Text style={styles.l1Icon}>{CATEGORY_ICONS[item.name] || '📦'}</Text>
                                <Text style={styles.l1Text}>{item.name}</Text>
                                <Ionicons
                                    name={isExpanded ? 'chevron-up' : 'chevron-down'}
                                    size={20} color={colors.textSecondary}
                                />
                            </TouchableOpacity>
                            {isExpanded && (
                                <View style={styles.l2Container}>
                                    {l2.length === 0 ? (
                                        <ActivityIndicator size="small" color={colors.primary} style={{ padding: 12 }} />
                                    ) : (
                                        l2.map((cat, index) => (
                                            <View key={cat.id}>
                                                {index > 0 && <View style={styles.divider} />}
                                                <TouchableOpacity
                                                    style={styles.l2Row}
                                                    onPress={() => router.push({
                                                        pathname: `/receipt/browse/[categoryId]`,
                                                         params: {
                                                             categoryId: String(cat.id),
                                                             name: cat.name,
                                                             chainId,
                                                             productIndex,
                                                             ocrName,
                                                         },
                                                     })}
                                                >
                                                    <Text style={styles.l2Text}>{cat.name}</Text>
                                                    <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                                                </TouchableOpacity>
                                            </View>
                                        ))
                                    )}
                                </View>
                            )}
                        </View>
                    );
                }}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    list: { padding: 16 },
    l1Container: {
        backgroundColor: c.cardBackground, borderRadius: 12, marginBottom: 8, overflow: 'hidden',
        elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05, shadowRadius: 2,
    },
    l1Row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
    l1Text: { fontSize: 15, fontWeight: '600', color: c.textPrimary, flex: 1 },
    l2Container: { borderTopWidth: 0.5, borderTopColor: c.border },
    l2Row: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 16, paddingVertical: 12, paddingLeft: 24,
    },
    l2Text: { fontSize: 14, color: c.textPrimary, flex: 1 },
    divider: { height: 0.5, backgroundColor: c.borderSubtle, marginLeft: 24 },
    l1Icon: { fontSize: 20, marginRight: 12 },
});
