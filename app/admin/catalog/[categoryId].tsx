import {
    View, Text, FlatList, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { useProfileStore } from '../../../state/profileStore';
import { API_BASE_URL } from '../../../config/api';
import { SkeletonBox } from '../../../components/SkeletonBox';
import { Toast, type ToastHandle } from '../../../components/Toast';
import CategoryBubbles from '../../../components/browse/CategoryBubbles';
import AdminProductCard, { type AdminProduct } from '../../../components/admin/AdminProductCard';
import SelectionBar from '../../../components/admin/SelectionBar';
import CategoryPickerModal from '../../../components/admin/CategoryPickerModal';
import ProductEditModal from '../../../components/admin/ProductEditModal';
import MergeModal from '../../../components/admin/MergeModal';
import { adminMergeProducts, adminMoveProducts, adminRenameProduct } from '../../../services/adminClient';

interface Category {
    id: number;
    name: string;
    parentCategoryId: number | null;
}

type ActiveModal =
    | null
    | { kind: 'move' }
    | { kind: 'merge' }
    | { kind: 'rename'; product: AdminProduct };

export default function CatalogCategoryScreen() {
    const { t } = useTranslation();
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { top } = useSafeAreaInsets();
    const router = useRouter();
    const toastRef = useRef<ToastHandle>(null);
    const profile = useProfileStore(s => s.profile);
    const isSuperAdmin = profile?.role === 'superadmin';

    const { categoryId, catName } = useLocalSearchParams<{
        categoryId: string;
        catName: string;
        l1name: string;
    }>();
    const catIdNum = Number(categoryId);

    // ── Product + L3 data ────────────────────────────────────────────────────
    const [products, setProducts] = useState<AdminProduct[]>([]);
    const [l3Categories, setL3Categories] = useState<Category[]>([]);
    const [selectedL3, setSelectedL3] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!catIdNum) return;
        setLoading(true);
        Promise.all([
            fetch(`${API_BASE_URL}/api/categories/${catIdNum}/all-products-with-amounts?mode=sku`).then(r => r.json()),
            fetch(`${API_BASE_URL}/api/categories/${catIdNum}/subcategories`).then(r => r.json()),
        ])
            .then(([prodData, subData]) => {
                setProducts(Array.isArray(prodData) ? prodData : []);
                setL3Categories(Array.isArray(subData) ? subData : []);
            })
            .catch(() => setProducts([]))
            .finally(() => setLoading(false));
    }, [catIdNum]);

    const selectL3 = useCallback(async (l3Id: number | null) => {
        setSelectedL3(l3Id);
        setLoading(true);
        try {
            const url = l3Id
                ? `${API_BASE_URL}/api/categories/${l3Id}/products-with-amounts?mode=sku`
                : `${API_BASE_URL}/api/categories/${catIdNum}/all-products-with-amounts?mode=sku`;
            const data = await fetch(url).then(r => r.json());
            setProducts(Array.isArray(data) ? data : []);
        } catch {
            setProducts([]);
        } finally {
            setLoading(false);
        }
    }, [catIdNum]);

    // ── Selection ────────────────────────────────────────────────────────────
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

    const enterSelectionMode = useCallback((productId: number) => {
        setSelectionMode(true);
        setSelectedIds(new Set([productId]));
    }, []);

    const toggleSelect = useCallback((productId: number) => {
        if (!selectionMode) { enterSelectionMode(productId); return; }
        setSelectedIds(prev => {
            const next = new Set(prev);
            next.has(productId) ? next.delete(productId) : next.add(productId);
            if (next.size === 0) setSelectionMode(false);
            return next;
        });
    }, [selectionMode, enterSelectionMode]);

    const selectAll = useCallback(() => {
        setSelectedIds(new Set(products.map(p => p.id)));
    }, [products]);

    const cancelSelection = useCallback(() => {
        setSelectionMode(false);
        setSelectedIds(new Set());
    }, []);

    // ── Modals ───────────────────────────────────────────────────────────────
    const [activeModal, setActiveModal] = useState<ActiveModal>(null);
    const [merging, setMerging] = useState(false);

    const handleMove = useCallback(async (categoryId: number, categoryName: string) => {
        const ids = Array.from(selectedIds);
        setActiveModal(null);
        try {
            const result = await adminMoveProducts(ids, categoryId);
            cancelSelection();
            setProducts(prev => prev.filter(p => !ids.includes(p.id)));
            toastRef.current?.show(t('admin.catalog.movedToast', { count: result.movedCount, name: categoryName }));
        } catch (e: any) {
            toastRef.current?.show(e?.message ?? t('admin.catalog.moveErrorToast'));
        }
    }, [selectedIds, cancelSelection, t]);

    const handleMerge = useCallback(async () => {
        const ids = Array.from(selectedIds);
        setMerging(true);
        try {
            const result = await adminMergeProducts(ids);
            setActiveModal(null);
            cancelSelection();
            setProducts(prev => prev.filter(p => !result.loserIds.includes(p.id)));
            toastRef.current?.show(t('admin.catalog.mergedToast', { name: result.winnerName }));
        } catch (e: any) {
            toastRef.current?.show(e?.message ?? t('admin.catalog.mergeErrorToast'));
        } finally {
            setMerging(false);
        }
    }, [selectedIds, cancelSelection, t]);

    const handleRename = useCallback(async (name: string) => {
        if (activeModal?.kind !== 'rename') return;
        const productId = activeModal.product.id;
        setActiveModal(null);
        try {
            await adminRenameProduct(productId, name);
            setProducts(prev => prev.map(p => p.id === productId ? { ...p, name } : p));
            cancelSelection();
            toastRef.current?.show(t('admin.catalog.renamedToast', { name }));
        } catch (e: any) {
            toastRef.current?.show(e?.message ?? t('admin.catalog.renameErrorToast'));
        }
    }, [activeModal, cancelSelection, t]);


    // ── Source L3 IDs for move picker (grayed chips) ─────────────────────────
    const sourceL3Ids = useMemo((): number[] => {
        const ids = Array.from(selectedIds)
            .map(id => products.find(p => p.id === id)?.categoryId)
            .filter((cid): cid is number => cid != null);
        return [...new Set(ids)];
    }, [selectedIds, products]);

    // ── Selected products for merge modal ────────────────────────────────────
    const selectedProducts = useMemo((): AdminProduct[] | null => {
        if (selectedIds.size < 2) return null;
        const list = Array.from(selectedIds)
            .map(id => products.find(p => p.id === id))
            .filter((p): p is AdminProduct => p != null);
        return list.length >= 2 ? list : null;
    }, [selectedIds, products]);

    // ── Render ───────────────────────────────────────────────────────────────
    const renderProduct = useCallback(({ item }: { item: AdminProduct }) => (
        <AdminProductCard
            product={item}
            selectionMode={selectionMode}
            selected={selectedIds.has(item.id)}
            onPress={() => {
                if (selectionMode) { toggleSelect(item.id); return; }
                router.push(`/admin/product/${item.id}`);
            }}
            onLongPress={() => { if (!selectionMode) enterSelectionMode(item.id); }}
        />
    ), [selectionMode, selectedIds, toggleSelect, enterSelectionMode, router]);

    return (
        <View style={styles.container}>
            {/* Header */}
            <View style={[styles.header, { paddingTop: top + 4 }]}>
                {selectionMode ? (
                    <>
                        <TouchableOpacity onPress={cancelSelection} style={styles.headerSide}>
                            <Text style={styles.headerAction}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <Text style={styles.headerTitle}>{t('admin.catalog.selectionCount', { count: selectedIds.size })}</Text>
                        <TouchableOpacity
                            onPress={selectAll}
                            style={[styles.headerSide, { alignItems: 'flex-end' }]}
                        >
                            <Text style={styles.headerAction}>{t('admin.catalog.selectAll')}</Text>
                        </TouchableOpacity>
                    </>
                ) : (
                    <>
                        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
                            <Ionicons name="chevron-back" size={20} color={colors.primary} />
                        </TouchableOpacity>
                        <Text style={[styles.headerTitle, { textAlign: 'left' }]} numberOfLines={1}>
                            {catName}
                        </Text>
                    </>
                )}
            </View>

            {/* L3 filter chips */}
            <CategoryBubbles
                categories={l3Categories}
                selectedId={selectedL3}
                onSelect={selectL3}
                allLabel={t('admin.catalog.allProducts')}
            />

            {/* Product grid */}
            <View style={{ flex: 1 }}>
                {loading ? (
                    <View style={styles.skeletonGrid}>
                        {Array.from({ length: 4 }).map((_, row) => (
                            <View key={row} style={styles.skeletonRow}>
                                {[0, 1].map(col => (
                                    <View key={col} style={styles.skeletonCard}>
                                        <SkeletonBox height={120} borderRadius={8} />
                                        <SkeletonBox width={100} height={12} borderRadius={5} style={{ marginTop: 8 }} />
                                        <SkeletonBox width={70} height={10} borderRadius={5} />
                                    </View>
                                ))}
                            </View>
                        ))}
                    </View>
                ) : (
                    <FlatList
                        data={products}
                        keyExtractor={item => item.id.toString()}
                        renderItem={renderProduct}
                        numColumns={2}
                        contentContainerStyle={styles.productGrid}
                        columnWrapperStyle={styles.productRow}
                        ListEmptyComponent={
                            <Text style={styles.emptyText}>{t('admin.catalog.noProducts')}</Text>
                        }
                    />
                )}
            </View>

            {/* Selection bar */}
            {selectionMode && selectedIds.size > 0 && (
                <SelectionBar
                    count={selectedIds.size}
                    isSuperAdmin={isSuperAdmin}
                    onMove={() => setActiveModal({ kind: 'move' })}
                    onMerge={() => setActiveModal({ kind: 'merge' })}
                    onRename={() => {
                        const id = Array.from(selectedIds)[0];
                        const product = products.find(p => p.id === id);
                        if (product) setActiveModal({ kind: 'rename', product });
                    }}
                />
            )}

            {/* Modals */}
            <CategoryPickerModal
                visible={activeModal?.kind === 'move'}
                selectionCount={selectedIds.size}
                sourceL3Ids={sourceL3Ids}
                onConfirm={handleMove}
                onCancel={() => setActiveModal(null)}
            />
            <MergeModal
                visible={activeModal?.kind === 'merge'}
                products={selectedProducts}
                loading={merging}
                onConfirm={handleMerge}
                onCancel={() => setActiveModal(null)}
            />
            <ProductEditModal
                visible={activeModal?.kind === 'rename'}
                product={activeModal?.kind === 'rename' ? activeModal.product : null}
                onSave={handleRename}
                onCancel={() => setActiveModal(null)}
            />

            <Toast ref={toastRef} />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingBottom: 10,
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
        gap: 8,
    },
    backBtn: {
        padding: 4,
        marginRight: 4,
        justifyContent: 'center',
    },
    headerTitle: {
        flex: 1,
        fontSize: 15,
        fontWeight: '700',
        color: c.textPrimary,
        textAlign: 'center',
    },
    headerSide: {
        flex: 1,
        justifyContent: 'center',
    },
    headerAction: {
        fontSize: 14,
        color: c.primary,
        fontWeight: '600',
    },

    productGrid: { padding: 12 },
    productRow: { gap: 12, marginBottom: 12 },
    emptyText: {
        textAlign: 'center',
        padding: 32,
        fontSize: 15,
        color: c.textSecondary,
    },

    skeletonGrid: { padding: 12, gap: 12 },
    skeletonRow: { flexDirection: 'row', gap: 12 },
    skeletonCard: {
        flex: 1,
        backgroundColor: c.cardBackground,
        borderRadius: 12,
        padding: 12,
        gap: 6,
    },
});
