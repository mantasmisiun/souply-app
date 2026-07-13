import {
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState } from 'react';
import {
    Modal,
    View,
    Text,
    TextInput,
    TouchableOpacity,
    ScrollView,
    FlatList,
    StyleSheet,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config/api';
import { useTheme, type AppTheme } from '../../constants/theme';
import { ProductImage } from '../ProductImage';
import type { AdminProduct } from './AdminProductCard';

interface Category {
    id: number;
    name: string;
    parentCategoryId: number | null;
}

interface L3WithCount {
    id: number;
    name: string;
    productCount: number;
}

interface SearchResult {
    id: number;
    name: string;
    l2Id: number;
    l2Name: string;
    path: string;
}

// Renamed from `View` to avoid shadowing react-native's View component
// (the local type would silently override the import and TS flags it).
type PickerView =
    | { kind: 'l1' }
    | { kind: 'l2'; l2Id: number; l2Name: string };

export type SpMovePayload =
    | { mode: 'existing'; productId: number }
    | { mode: 'new'; name: string; categoryId: number };

interface Props {
    visible: boolean;
    selectionCount: number;
    sourceL3Ids: number[];
    onConfirm: (categoryId: number, categoryName: string) => void;
    onCancel: () => void;
    // SP move mode — tapping a product immediately calls onSpMoveConfirm
    spMoveMode?: boolean;
    prefilledName?: string;
    onSpMoveConfirm?: (payload: SpMovePayload) => void;
}

// ─── L1 accordion item (same pattern as catalog/index.tsx) ───────────────────

const L1Item = memo(function L1Item({
    item, isExpanded, l2, onToggle, onSelectL2, colors, styles,
}: {
    item: Category;
    isExpanded: boolean;
    l2: Category[];
    onToggle: (id: number) => void;
    onSelectL2: (cat: Category) => void;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}) {
    const contentHeightRef = useRef(0);
    const animatedHeight = useSharedValue(0);
    const chevronRotation = useSharedValue(0);

    useLayoutEffect(() => {
        animatedHeight.value = withTiming(isExpanded ? contentHeightRef.current : 0, {
            duration: 220,
            easing: Easing.inOut(Easing.quad),
        });
        chevronRotation.value = withTiming(isExpanded ? 1 : 0, { duration: 220 });
    }, [isExpanded]);

    const animatedContentStyle = useAnimatedStyle(() => ({
        height: animatedHeight.value,
        overflow: 'hidden',
    }));

    const chevronStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${chevronRotation.value * 180}deg` }],
    }));

    const handleLayout = (e: { nativeEvent: { layout: { height: number } } }) => {
        const h = e.nativeEvent.layout.height;
        if (h > 0 && h !== contentHeightRef.current) {
            contentHeightRef.current = h;
            if (isExpanded) animatedHeight.value = withTiming(h, { duration: 150 });
        }
    };

    return (
        <View style={[styles.l1Container, isExpanded && styles.l1ContainerExpanded]}>
            <TouchableOpacity style={styles.l1Row} onPress={() => onToggle(item.id)}>
                <Text style={styles.l1Text}>{item.name}</Text>
                <Animated.View style={chevronStyle}>
                    <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
                </Animated.View>
            </TouchableOpacity>
            <Animated.View style={animatedContentStyle}>
                <View onLayout={handleLayout} style={styles.l2Container}>
                    {l2.length === 0 ? (
                        <MaterialProgress size="small" color={colors.primary} style={{ padding: 12 }} />
                    ) : (
                        l2.map((cat, index) => (
                            <View key={cat.id}>
                                {index > 0 && <View style={styles.divider} />}
                                <TouchableOpacity style={styles.l2Row} onPress={() => onSelectL2(cat)}>
                                    <Text style={styles.l2Text}>{cat.name}</Text>
                                    <Ionicons name="chevron-forward" size={16} color={colors.primary} />
                                </TouchableOpacity>
                            </View>
                        ))
                    )}
                </View>
            </Animated.View>
        </View>
    );
});

// ─── Main component ───────────────────────────────────────────────────────────

export default function CategoryPickerModal({
    visible, selectionCount, sourceL3Ids, onConfirm, onCancel,
    spMoveMode = false, prefilledName, onSpMoveConfirm,
}: Props) {
    const { t } = useTranslation();
    const colors = useTheme();
    const { top, bottom } = useSafeAreaInsets();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    // ── Shared data ────────────────────────────────────────────────────────
    const [allCats, setAllCats] = useState<Category[]>([]);
    const [l1Loading, setL1Loading] = useState(false);
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── L1 view state ──────────────────────────────────────────────────────
    const [view, setView] = useState<PickerView>({ kind: 'l1' });
    const [expandedL1, setExpandedL1] = useState<number | null>(null);
    const [l2Map, setL2Map] = useState<Record<number, Category[]>>({});
    const [search, setSearch] = useState('');

    // ── L2 view state ──────────────────────────────────────────────────────
    const [l3s, setL3s] = useState<L3WithCount[]>([]);
    const [l3sLoading, setL3sLoading] = useState(false);
    const [selectedL3, setSelectedL3] = useState<{ id: number; name: string } | null>(null);
    const [products, setProducts] = useState<AdminProduct[]>([]);
    const [productsLoading, setProductsLoading] = useState(false);

    // ── SP move: new-product inline form ──────────────────────────────────
    const [showNewProductForm, setShowNewProductForm] = useState(false);
    const [newProductName, setNewProductName] = useState('');

    // ── Load on open ───────────────────────────────────────────────────────
    useEffect(() => {
        if (!visible) return;
        setView({ kind: 'l1' });
        setExpandedL1(null);
        setSearch('');
        setSelectedL3(null);
        setProducts([]);
        setShowNewProductForm(false);
        setNewProductName(prefilledName ?? '');
        if (allCats.length > 0) return;
        setL1Loading(true);
        fetch(`${API_BASE_URL}/api/categories`)
            .then(r => r.json())
            .then((data: Category[]) => { if (Array.isArray(data)) setAllCats(data); })
            .catch(() => {})
            .finally(() => setL1Loading(false));
    }, [visible]);

    // ── L1 accordion ───────────────────────────────────────────────────────
    const l1s = useMemo(() => allCats.filter(c => c.parentCategoryId === null), [allCats]);

    const toggleL1 = useCallback((l1Id: number) => {
        const next = expandedL1 === l1Id ? null : l1Id;
        setExpandedL1(next);
        if (next && !l2Map[next]) {
            fetch(`${API_BASE_URL}/api/categories/${next}/subcategories`)
                .then(r => r.json())
                .then((data: Category[]) => {
                    if (Array.isArray(data)) setL2Map(prev => ({ ...prev, [next]: data }));
                })
                .catch(() => {});
        }
    }, [expandedL1, l2Map]);

    const openL2 = useCallback((cat: Category, preSelectL3Id?: number) => {
        setView({ kind: 'l2', l2Id: cat.id, l2Name: cat.name });
        setSelectedL3(null);
        setProducts([]);
        setL3sLoading(true);
        fetch(`${API_BASE_URL}/api/categories/${cat.id}/subcategories-with-counts`)
            .then(r => r.json())
            .then((data: L3WithCount[]) => {
                if (!Array.isArray(data)) return;
                setL3s(data);
                if (preSelectL3Id != null) {
                    const hit = data.find(l => l.id === preSelectL3Id);
                    if (hit) {
                        setSelectedL3({ id: hit.id, name: hit.name });
                        setProductsLoading(true);
                        fetch(`${API_BASE_URL}/api/categories/${hit.id}/products-with-amounts?mode=sku`)
                            .then(r => r.json())
                            .then((pd: AdminProduct[]) => { if (Array.isArray(pd)) setProducts(pd); })
                            .catch(() => setProducts([]))
                            .finally(() => setProductsLoading(false));
                    }
                }
            })
            .catch(() => setL3s([]))
            .finally(() => setL3sLoading(false));
    }, []);

    // ── Search — debounced API call to /categories/l3/search ──────────────
    useEffect(() => {
        if (searchTimer.current) clearTimeout(searchTimer.current);
        if (!search.trim()) { setSearchResults([]); return; }
        setSearchLoading(true);
        searchTimer.current = setTimeout(() => {
            fetch(`${API_BASE_URL}/api/categories/l3/search?q=${encodeURIComponent(search.trim())}`)
                .then(r => r.json())
                .then((data: SearchResult[]) => { if (Array.isArray(data)) setSearchResults(data); })
                .catch(() => setSearchResults([]))
                .finally(() => setSearchLoading(false));
        }, 300);
        return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    }, [search]);

    const selectFromSearch = useCallback((result: SearchResult) => {
        setSearch('');
        setSearchResults([]);
        openL2({ id: result.l2Id, name: result.l2Name, parentCategoryId: null }, result.id);
    }, [openL2]);

    // ── L3 chip selection ──────────────────────────────────────────────────
    const selectL3 = useCallback((l3: L3WithCount) => {
        if (sourceL3Ids.includes(l3.id)) return;
        setSelectedL3({ id: l3.id, name: l3.name });
        setShowNewProductForm(false);
        setNewProductName(prefilledName ?? '');
        setProductsLoading(true);
        fetch(`${API_BASE_URL}/api/categories/${l3.id}/products-with-amounts?mode=sku`)
            .then(r => r.json())
            .then((data: AdminProduct[]) => { if (Array.isArray(data)) setProducts(data); })
            .catch(() => setProducts([]))
            .finally(() => setProductsLoading(false));
    }, [sourceL3Ids, prefilledName]);

    // ── Render: product row in L2 view ────────────────────────────────────
    const renderProduct = useCallback(({ item }: { item: AdminProduct }) => {
        const inner = (
            <>
                <View style={styles.productThumb}>
                    <ProductImage
                        uris={item.imageUrls}
                        imageStyle={{ width: '100%', height: '100%' }}
                        placeholderStyle={styles.productThumbPlaceholder}
                        emojiStyle={{ fontSize: 18, opacity: 0.4 }}
                    />
                </View>
                <View style={{ flex: 1 }}>
                    <Text style={styles.productName} numberOfLines={2}>{item.name}</Text>
                    <Text style={styles.productId}>ID {item.id}</Text>
                </View>
                {spMoveMode && <Ionicons name="chevron-forward" size={16} color={colors.primary} />}
            </>
        );
        if (spMoveMode) {
            return (
                <TouchableOpacity
                    style={styles.productRow}
                    onPress={() => onSpMoveConfirm?.({ mode: 'existing', productId: item.id })}
                    activeOpacity={0.7}
                >
                    {inner}
                </TouchableOpacity>
            );
        }
        return <View style={styles.productRow}>{inner}</View>;
    }, [styles, spMoveMode, onSpMoveConfirm, colors]);

    const isL1View = view.kind === 'l1';

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
            <View style={[styles.container, { paddingTop: top }]}>

                {/* ── Header ─────────────────────────────────────────────── */}
                <View style={styles.header}>
                    {isL1View ? (
                        <TouchableOpacity onPress={onCancel} style={styles.headerSide}>
                            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                    ) : (
                        <TouchableOpacity
                            onPress={() => { setView({ kind: 'l1' }); setSelectedL3(null); setProducts([]); }}
                            style={styles.headerSide}
                        >
                            <Ionicons name="chevron-back" size={20} color={colors.primary} />
                        </TouchableOpacity>
                    )}
                    <Text style={styles.headerTitle} numberOfLines={1}>
                        {isL1View
                            ? (spMoveMode
                                ? t('admin.categoryPicker.moveSpTitle')
                                : t('admin.categoryPicker.moveProductsTitle', { count: selectionCount }))
                            : (view as { kind: 'l2'; l2Name: string }).l2Name}
                    </Text>
                    <View style={styles.headerSide} />
                </View>

                {/* ── L1 view ────────────────────────────────────────────── */}
                {isL1View && (
                    <>
                        {/* Search bar */}
                        <View style={styles.searchRow}>
                            <Ionicons name="search" size={16} color={colors.textMuted} style={{ marginRight: 8 }} />
                            <TextInput
                                style={styles.searchInput}
                                placeholder={t('admin.categoryPicker.searchPlaceholder')}
                                placeholderTextColor={colors.textMuted}
                                value={search}
                                onChangeText={setSearch}
                                returnKeyType="search"
                                autoCorrect={false}
                            />
                            {search.length > 0 && (
                                <TouchableOpacity onPress={() => setSearch('')}>
                                    <Ionicons name="close-circle" size={16} color={colors.textMuted} />
                                </TouchableOpacity>
                            )}
                        </View>

                        {l1Loading ? (
                            <MaterialProgress style={{ flex: 1 }} color={colors.primary} />
                        ) : search.trim() ? (
                            // Search results — flat L3 list
                            <FlatList
                                data={searchResults}
                                keyExtractor={item => String(item.id)}
                                style={{ flex: 1 }}
                                keyboardShouldPersistTaps="handled"
                                ListEmptyComponent={
                                    searchLoading
                                        ? <MaterialProgress color={colors.primary} style={{ padding: 24 }} />
                                        : <Text style={styles.emptyText}>{t('admin.categoryPicker.searchEmpty')}</Text>
                                }
                                renderItem={({ item }) => (
                                    <TouchableOpacity
                                        style={styles.searchResultRow}
                                        onPress={() => selectFromSearch(item)}
                                    >
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.searchResultL3}>{item.name}</Text>
                                            <Text style={styles.searchResultL2}>{item.l2Name}</Text>
                                        </View>
                                        <Ionicons name="chevron-forward" size={16} color={colors.primary} />
                                    </TouchableOpacity>
                                )}
                            />
                        ) : (
                            // L1 accordion
                            <FlatList
                                data={l1s}
                                keyExtractor={item => String(item.id)}
                                style={{ flex: 1 }}
                                renderItem={({ item }) => (
                                    <L1Item
                                        item={item}
                                        isExpanded={expandedL1 === item.id}
                                        l2={l2Map[item.id] ?? []}
                                        onToggle={toggleL1}
                                        onSelectL2={openL2}
                                        colors={colors}
                                        styles={styles}
                                    />
                                )}
                            />
                        )}
                    </>
                )}

                {/* ── L2 view ────────────────────────────────────────────── */}
                {!isL1View && (
                    <>
                        {/* L3 chips */}
                        {l3sLoading ? (
                            <View style={styles.chipsLoader}>
                                <MaterialProgress color={colors.primary} />
                            </View>
                        ) : (
                            <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                contentContainerStyle={styles.chipsContainer}
                                style={styles.chipsRow}
                            >
                                {l3s.map(l3 => {
                                    const isSource = sourceL3Ids.includes(l3.id);
                                    const isSelected = selectedL3?.id === l3.id;
                                    return (
                                        <TouchableOpacity
                                            key={l3.id}
                                            style={[
                                                styles.chip,
                                                isSelected && styles.chipActive,
                                                isSource && styles.chipDisabled,
                                            ]}
                                            onPress={() => selectL3(l3)}
                                            disabled={isSource}
                                            activeOpacity={isSource ? 1 : 0.7}
                                        >
                                            <Text style={[
                                                styles.chipText,
                                                isSelected && styles.chipTextActive,
                                                isSource && styles.chipTextDisabled,
                                            ]}>
                                                {l3.name} ({l3.productCount})
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        )}

                        {/* Product list */}
                        {productsLoading ? (
                            <MaterialProgress style={{ flex: 1 }} color={colors.primary} />
                        ) : selectedL3 ? (
                            <KeyboardAvoidingView style={{ flex: 1 }}>
                                <FlatList
                                    data={products}
                                    keyExtractor={item => String(item.id)}
                                    renderItem={renderProduct}
                                    style={{ flex: 1 }}
                                    keyboardShouldPersistTaps="handled"
                                    contentContainerStyle={{ paddingBottom: 8 }}
                                    ListHeaderComponent={spMoveMode ? (
                                        <View>
                                            {showNewProductForm ? (
                                                <View style={styles.newProductForm}>
                                                    <TextInput
                                                        style={styles.newProductInput}
                                                        value={newProductName}
                                                        onChangeText={setNewProductName}
                                                        placeholder={t('admin.categoryPicker.newProductNamePlaceholder')}
                                                        placeholderTextColor={colors.textMuted}
                                                        autoFocus
                                                        returnKeyType="done"
                                                        onSubmitEditing={() => {
                                                            if (newProductName.trim() && selectedL3) {
                                                                onSpMoveConfirm?.({ mode: 'new', name: newProductName.trim(), categoryId: selectedL3.id });
                                                            }
                                                        }}
                                                    />
                                                    <View style={styles.newProductActions}>
                                                        <TouchableOpacity
                                                            style={styles.newProductCancel}
                                                            onPress={() => { setShowNewProductForm(false); setNewProductName(prefilledName ?? ''); }}
                                                        >
                                                            <Text style={styles.newProductCancelText}>{t('common.cancel')}</Text>
                                                        </TouchableOpacity>
                                                        <TouchableOpacity
                                                            style={[styles.newProductConfirm, !newProductName.trim() && styles.newProductConfirmDisabled]}
                                                            onPress={() => {
                                                                if (newProductName.trim() && selectedL3) {
                                                                    onSpMoveConfirm?.({ mode: 'new', name: newProductName.trim(), categoryId: selectedL3.id });
                                                                }
                                                            }}
                                                            disabled={!newProductName.trim()}
                                                        >
                                                            <Text style={styles.newProductConfirmText}>{t('admin.categoryPicker.newProductConfirm')}</Text>
                                                        </TouchableOpacity>
                                                    </View>
                                                </View>
                                            ) : (
                                                <TouchableOpacity
                                                    style={styles.newProductRow}
                                                    onPress={() => { setShowNewProductForm(true); }}
                                                    activeOpacity={0.7}
                                                >
                                                    <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
                                                    <Text style={styles.newProductRowText}>{t('admin.categoryPicker.newProduct')}</Text>
                                                </TouchableOpacity>
                                            )}
                                            <View style={styles.divider} />
                                        </View>
                                    ) : null}
                                    ListEmptyComponent={
                                        <Text style={styles.emptyText}>{t('admin.categoryPicker.categoryEmpty')}</Text>
                                    }
                                />
                            </KeyboardAvoidingView>
                        ) : (
                            <View style={styles.pickHint}>
                                <Text style={styles.pickHintText}>{t('admin.categoryPicker.pickCategoryHint')}</Text>
                            </View>
                        )}

                        {/* Confirm banner — not shown in SP move mode (tap selects directly) */}
                        {selectedL3 && !spMoveMode && (
                            <View style={[styles.banner, { paddingBottom: Math.max(16, bottom) }]}>
                                <TouchableOpacity
                                    style={styles.bannerBtn}
                                    onPress={() => onConfirm(selectedL3.id, selectedL3.name)}
                                >
                                    <Text style={styles.bannerText}>
                                        {t('admin.categoryPicker.confirmBanner', { count: selectionCount, name: selectedL3.name })}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        )}
                    </>
                )}
            </View>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 12,
        paddingVertical: 12,
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
    },
    headerSide: { width: 60, justifyContent: 'center' },
    headerTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: c.textPrimary, textAlign: 'center' },
    cancelText: { fontSize: 16, color: c.primary },

    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        margin: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: c.cardBackground,
        borderRadius: 12,
        borderWidth: 0.5,
        borderColor: c.border,
    },
    searchInput: { flex: 1, fontSize: 15, color: c.textPrimary },

    // L1 accordion
    l1Container: { backgroundColor: c.cardBackground, marginBottom: 1 },
    l1ContainerExpanded: { borderBottomWidth: 0.5, borderBottomColor: c.border },
    l1Row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 16, gap: 8 },
    l1Text: { flex: 1, fontSize: 16, fontWeight: '600', color: c.textPrimary },
    l2Container: { position: 'absolute', width: '100%', backgroundColor: c.pageBackground },
    l2Row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, paddingVertical: 14 },
    l2Text: { flex: 1, fontSize: 15, color: c.textPrimary },
    divider: { height: 0.5, backgroundColor: c.borderSubtle, marginLeft: 24 },

    // Search results
    searchResultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.borderSubtle,
        gap: 8,
    },
    searchResultL3: { fontSize: 14, color: c.textPrimary, fontWeight: '500' },
    searchResultL2: { fontSize: 12, color: c.textMuted, marginTop: 1 },

    // L3 chips
    chipsRow: { backgroundColor: c.cardBackground, borderBottomWidth: 0.5, borderBottomColor: c.border, flexGrow: 0, flexShrink: 0 },
    chipsContainer: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
    chipsLoader: { height: 52, justifyContent: 'center', alignItems: 'center', backgroundColor: c.cardBackground, borderBottomWidth: 0.5, borderBottomColor: c.border },
    chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: c.border, backgroundColor: c.cardBackground },
    chipActive: { backgroundColor: c.primary, borderColor: c.primary },
    chipDisabled: { opacity: 0.4 },
    chipText: { fontSize: 13, color: c.textPrimary },
    chipTextActive: { color: c.onPrimary, fontWeight: '600' },
    chipTextDisabled: { color: c.textMuted },

    // Product preview rows
    productRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderBottomWidth: 0.5, borderBottomColor: c.borderSubtle, backgroundColor: c.cardBackground },
    productThumb: { width: 44, height: 44, borderRadius: 8, overflow: 'hidden', backgroundColor: c.surfaceMuted, flexShrink: 0 },
    productThumbPlaceholder: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceMuted },
    productName: { fontSize: 13, color: c.textPrimary, lineHeight: 18 },
    productId: { fontSize: 11, color: c.textMuted, marginTop: 2 },

    // Misc
    emptyText: { textAlign: 'center', padding: 32, fontSize: 14, color: c.textSecondary },
    pickHint: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    pickHintText: { fontSize: 14, color: c.textMuted },

    // Confirm banner
    banner: { padding: 16, backgroundColor: c.cardBackground, borderTopWidth: 0.5, borderTopColor: c.border },
    bannerBtn: { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
    bannerText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },

    // SP move: new product row + form
    newProductRow: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        padding: 12, backgroundColor: c.cardBackground,
    },
    newProductRowText: { fontSize: 14, color: c.primary, fontWeight: '600' },
    newProductForm: { padding: 12, backgroundColor: c.cardBackground, gap: 10 },
    newProductInput: {
        borderWidth: 1, borderColor: c.border, borderRadius: 10,
        paddingHorizontal: 12, paddingVertical: 10,
        fontSize: 14, color: c.textPrimary, backgroundColor: c.pageBackground,
    },
    newProductActions: { flexDirection: 'row', gap: 8 },
    newProductCancel: {
        flex: 1, paddingVertical: 10, borderRadius: 10,
        borderWidth: 1, borderColor: c.border, alignItems: 'center',
    },
    newProductCancelText: { fontSize: 14, color: c.textSecondary },
    newProductConfirm: {
        flex: 2, paddingVertical: 10, borderRadius: 10,
        backgroundColor: c.primary, alignItems: 'center',
    },
    newProductConfirmDisabled: { opacity: 0.4 },
    newProductConfirmText: { fontSize: 14, color: c.onPrimary, fontWeight: '600' },
});
