import { View, FlatList, TouchableOpacity, Text, StyleSheet, ActivityIndicator, TextInput, LayoutAnimation, UIManager, Platform } from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../../config/api';
import { useBasketState } from '../../../state/basketState';
import { addProductToBasket } from '../../../utils/basketUtils';
import { Alert } from 'react-native';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface Category {
    id: number;
    name: string;
    parentCategoryId: number | null;
}

interface Product {
    id: number;
    name: string;
    categoryId: number;
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
export default function BrowseIndex() {
    const [l1Categories, setL1Categories] = useState<Category[]>([]);
    const [l2Map, setL2Map] = useState<Record<number, Category[]>>({});
    const [expandedL1, setExpandedL1] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [searchVisible, setSearchVisible] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<Product[]>([]);
    const [searching, setSearching] = useState(false);
    const router = useRouter();
    const { draftBasketId, setDraftBasketId } = useBasketState();

    useEffect(() => {
        fetch(`${API_BASE_URL}/api/categories`)
            .then(r => r.json())
            .then(data => {
                setL1Categories(Array.isArray(data) ? data : []);
            })
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        if (!searchQuery.trim()) { setSearchResults([]); return; }
        const timeout = setTimeout(async () => {
            setSearching(true);
            try {
                const res = await fetch(`${API_BASE_URL}/api/products/search?q=${encodeURIComponent(searchQuery)}`);
                const data = await res.json();
                setSearchResults(Array.isArray(data) ? data : []);
            } finally {
                setSearching(false);
            }
        }, 400);
        return () => clearTimeout(timeout);
    }, [searchQuery]);

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

    const closeSearch = () => {
        setSearchVisible(false);
        setSearchQuery('');
        setSearchResults([]);
    };

    if (loading) return <ActivityIndicator style={styles.centered} size="large" color="#2e7d32" />;

    return (
        <>
            <Stack.Screen
                options={{
                    title: searchVisible ? '' : 'Naršyti',
                    headerRight: () => (
                        <TouchableOpacity
                            onPress={() => searchVisible ? closeSearch() : setSearchVisible(true)}
                            style={{ marginRight: 12 }}
                        >
                            <Ionicons name={searchVisible ? 'close' : 'search'} size={24} color="#2e7d32" />
                        </TouchableOpacity>
                    ),
                    headerTitle: searchVisible ? () => (
                        <TextInput
                            autoFocus
                            placeholder="Ieškoti produktų..."
                            placeholderTextColor="#9e9e9e"
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                            style={styles.searchInput}
                        />
                    ) : undefined,
                }}
            />

            {searchVisible ? (
                searching ? (
                    <ActivityIndicator style={styles.centered} size="large" color="#2e7d32" />
                ) : (
                    <FlatList
                        data={searchResults}
                        keyExtractor={item => item.id.toString()}
                        contentContainerStyle={styles.list}
                        ListEmptyComponent={
                            <Text style={styles.emptyText}>
                                {searchQuery.trim() ? 'Produktų nerasta' : 'Įveskite paieškos tekstą'}
                            </Text>
                        }
                        renderItem={({ item }) => (
                            <View style={styles.productRow}>
                                <View style={styles.productIcon}>
                                    <Ionicons name="cube-outline" size={20} color="#bdbdbd" />
                                </View>
                                <Text style={styles.productName}>{item.name}</Text>
                                <TouchableOpacity
                                    onPress={async () => {
                                        const result = await addProductToBasket(item.id, draftBasketId, setDraftBasketId);
                                        Alert.alert(result.success ? 'Pridėta' : 'Klaida', result.message);
                                    }}
                                >
                                    <Ionicons name="add-circle-outline" size={24} color="#2e7d32" />
                                </TouchableOpacity>
                            </View>
                        )}
                    />
                )
            ) : (
                <FlatList
                    data={l1Categories}
                    keyExtractor={item => item.id.toString()}
                    contentContainerStyle={styles.list}
                    renderItem={({ item }) => {
                        const isExpanded = expandedL1 === item.id;
                        const l2 = l2Map[item.id] || [];
                        return (
                            <View style={styles.l1Container}>
                                <TouchableOpacity
                                    style={styles.l1Row}
                                    onPress={() => toggleL1(item.id)}
                                >
                                    <Text style={styles.l1Icon}>{CATEGORY_ICONS[item.name] || '📦'}</Text>
                                    <Text style={styles.l1Text}>{item.name}</Text>
                                    <Ionicons
                                        name={isExpanded ? 'chevron-up' : 'chevron-down'}
                                        size={20}
                                        color="#757575"
                                    />
                                </TouchableOpacity>
                                {isExpanded && (
                                    <View style={styles.l2Container}>
                                        {l2.length === 0 ? (
                                            <ActivityIndicator size="small" color="#2e7d32" style={{ padding: 12 }} />
                                        ) : (
                                            l2.map((cat, index) => (
                                                <View key={cat.id}>
                                                    {index > 0 && <View style={styles.divider} />}
                                                    <TouchableOpacity
                                                        style={styles.l2Row}
                                                        onPress={() => router.push(`/browse/${cat.id}?name=${encodeURIComponent(cat.name)}`)}
                                                    >
                                                        <Text style={styles.l2Text}>{cat.name}</Text>
                                                        <Ionicons name="chevron-forward" size={18} color="#9e9e9e" />
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
            )}
        </>
    );
}

const styles = StyleSheet.create({
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    list: { padding: 16 },
    searchInput: { fontSize: 16, flex: 1, color: '#212121' },
    l1Container: {
        backgroundColor: 'white',
        borderRadius: 12,
        marginBottom: 8,
        overflow: 'hidden',
        elevation: 1,
        shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05, shadowRadius: 2,
    },
    l1Row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    l1Text: {
        fontSize: 15,
        fontWeight: '600',
        color: '#212121',
        flex: 1,
    },
    l2Container: {
        borderTopWidth: 0.5,
        borderTopColor: '#e0e0e0',
    },
    l2Row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        paddingLeft: 24,
    },
    l2Text: {
        fontSize: 14,
        color: '#424242',
        flex: 1,
    },
    divider: {
        height: 0.5,
        backgroundColor: '#f0f0f0',
        marginLeft: 24,
    },
    productRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        gap: 12,
    },
    productIcon: {
        width: 36, height: 36, borderRadius: 8,
        backgroundColor: '#f5f5f5',
        alignItems: 'center', justifyContent: 'center',
    },
    productName: { flex: 1, fontSize: 14, color: '#212121' },
    emptyText: { textAlign: 'center', padding: 32, fontSize: 15, color: '#757575' },
    l1Icon: {
        fontSize: 20,
        marginRight: 12,
    },
});