import {
    View,
    Text,
    FlatList,
    StyleSheet,
    ActivityIndicator,
    TouchableOpacity,
} from 'react-native';
import { useState, useCallback, useMemo } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../constants/theme';
import { isWeighableDisplay } from '../utils/weighable';
import { API_BASE_URL } from '../config/api';
import { formatEuro } from '../utils/formatCurrency';
import { ProductImage } from './ProductImage';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';

interface ShoppingListItem {
    id: number;
    listId: number;
    productId: number | null;
    productName: string;
    quantity: number;
    price: number | null;
    isChecked: boolean;
    imageUrls?: (string | null | undefined)[] | string | null;
    isWeighable: boolean;
    unit?: string;
    storeProductId?: number | null;
    l2CategoryId?: number | null;
    l2CategoryName?: string | null;
}

interface Props {
    listId: number;
}

type ListRow =
    | { kind: 'category'; name: string | null }
    | { kind: 'item'; data: ShoppingListItem }
    | { kind: 'checked_header' }
    | { kind: 'footer' };

function sortItems(arr: ShoppingListItem[]): ShoppingListItem[] {
    return [...arr].sort((a, b) => {
        if (a.isChecked !== b.isChecked) return Number(a.isChecked) - Number(b.isChecked);
        if (!a.isChecked) {
            const ca = a.l2CategoryName ?? '￿';
            const cb = b.l2CategoryName ?? '￿';
            if (ca !== cb) return ca.localeCompare(cb, 'lt');
        }
        return a.productName.localeCompare(b.productName, 'lt');
    });
}

export default function ShoppingListEmbed({ listId }: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();
    const router = useRouter();

    const [items, setItems] = useState<ShoppingListItem[]>([]);
    const [loading, setLoading] = useState(true);

    useFocusEffect(useCallback(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const res = await fetch(`${API_BASE_URL}/api/shopping-lists/${listId}/items`);
                if (!res.ok) return;
                const data: ShoppingListItem[] = await res.json();
                if (!cancelled) setItems(sortItems(data));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [listId]));

    const handleToggle = async (item: ShoppingListItem) => {
        const next = !item.isChecked;
        Haptics.impactAsync(next ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);
        setItems(prev => sortItems(prev.map(i => i.id === item.id ? { ...i, isChecked: next } : i)));
        try {
            await fetch(`${API_BASE_URL}/api/list-items/${item.id}/toggle`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isChecked: next }),
            });
        } catch {
            setItems(prev => sortItems(prev.map(i => i.id === item.id ? { ...i, isChecked: !next } : i)));
        }
    };

    const handleDelete = async (itemId: number) => {
        setItems(prev => prev.filter(i => i.id !== itemId));
        try {
            await fetch(`${API_BASE_URL}/api/list-items/${itemId}`, { method: 'DELETE' });
        } catch {
            // Restore on failure — re-fetch
            const res = await fetch(`${API_BASE_URL}/api/shopping-lists/${listId}/items`).catch(() => null);
            if (res?.ok) {
                const data = await res.json();
                setItems(sortItems(data));
            }
        }
    };

    const checkedCount = items.filter(i => i.isChecked).length;
    const total = items.length;
    const progress = total > 0 ? checkedCount / total : 0;
    const totalPrice = items.filter(i => !i.isChecked).reduce((s, i) => s + (i.price ?? 0), 0);

    // Build flat rows with category headers for unchecked, then a checked section
    const rows: ListRow[] = useMemo(() => {
        const unchecked = items.filter(i => !i.isChecked);
        const checked = items.filter(i => i.isChecked);

        const out: ListRow[] = [];
        const byCategory = new Map<string, ShoppingListItem[]>();
        for (const item of unchecked) {
            const key = item.l2CategoryName ?? '';
            if (!byCategory.has(key)) byCategory.set(key, []);
            byCategory.get(key)!.push(item);
        }
        const groups = Array.from(byCategory.entries())
            .sort(([a], [b]) => {
                if (!a && !b) return 0;
                if (!a) return 1;
                if (!b) return -1;
                return a.localeCompare(b, 'lt');
            });

        for (const [key, groupItems] of groups) {
            if (key) out.push({ kind: 'category', name: key });
            for (const item of groupItems) out.push({ kind: 'item', data: item });
        }
        if (checked.length > 0) {
            out.push({ kind: 'checked_header' });
            for (const item of checked) out.push({ kind: 'item', data: item });
        }
        out.push({ kind: 'footer' });
        return out;
    }, [items]);

    if (loading) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator color={colors.primary} />
            </View>
        );
    }

    return (
        <View style={styles.root}>
            {/* Progress bar */}
            <View style={styles.progressRow}>
                <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                </View>
                <Text style={styles.progressText}>{checkedCount}/{total}</Text>
            </View>

            <FlatList
                style={styles.list}
                data={rows}
                keyExtractor={(row, i) => {
                    if (row.kind === 'item') return `item-${row.data.id}`;
                    if (row.kind === 'category') return `cat-${row.name ?? 'none'}-${i}`;
                    return row.kind;
                }}
                contentContainerStyle={styles.listContent}
                renderItem={({ item: row }) => {
                    if (row.kind === 'category') {
                        return <Text style={styles.categoryHeader}>{row.name}</Text>;
                    }
                    if (row.kind === 'checked_header') {
                        return <Text style={styles.categoryHeader}>{t('shoppingListDetail.sectionChecked') ?? 'Sudėti į krepšelį'}</Text>;
                    }
                    if (row.kind === 'footer') {
                        return (
                            <View style={styles.footer}>
                                <Text style={styles.footerTotal}>
                                    {formatEuro(totalPrice)} · {items.filter(i => !i.isChecked).length} pr.
                                </Text>
                                <TouchableOpacity
                                    style={styles.fullScreenBtn}
                                    onPress={() => router.push(`/shopping-list/${listId}` as any)}
                                >
                                    <Ionicons name="expand-outline" size={15} color={colors.primary} />
                                    <Text style={styles.fullScreenBtnText}>Rodyti pilnai</Text>
                                </TouchableOpacity>
                            </View>
                        );
                    }
                    const item = row.data;
                    return (
                        <EmbedItemCard
                            item={item}
                            onToggle={handleToggle}
                            onDelete={handleDelete}
                            styles={styles}
                            colors={colors}
                        />
                    );
                }}
                ListEmptyComponent={
                    <View style={styles.centered}>
                        <Text style={styles.emptyText}>Sąrašas tuščias</Text>
                    </View>
                }
            />
        </View>
    );
}

interface ItemCardProps {
    item: ShoppingListItem;
    onToggle: (item: ShoppingListItem) => void;
    onDelete: (id: number) => void;
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
}

function EmbedItemCard({ item, onToggle, onDelete, styles, colors }: ItemCardProps) {
    return (
        <View style={[styles.card, item.isChecked && styles.cardChecked]}>
            <TouchableOpacity
                style={styles.cardMain}
                onPress={() => onToggle(item)}
                activeOpacity={0.7}
            >
                <View style={[styles.checkbox, item.isChecked && styles.checkboxChecked]}>
                    {item.isChecked && <Ionicons name="checkmark" size={14} color="#fff" />}
                </View>
                <ProductImage uris={item.imageUrls} imageStyle={styles.image} />
                <View style={styles.cardContent}>
                    <Text style={[styles.itemName, item.isChecked && styles.itemNameChecked]} numberOfLines={2}>
                        {item.productName}
                    </Text>
                    <Text style={styles.itemMeta}>
                        {item.quantity} {isWeighableDisplay(item.isWeighable, item.quantity) ? 'kg' : 'vnt.'}
                        {item.price ? ` · ${formatEuro(item.price)}` : ''}
                    </Text>
                </View>
            </TouchableOpacity>
            <TouchableOpacity
                style={styles.deleteBtn}
                onPress={() => onDelete(item.id)}
                hitSlop={8}
            >
                <Ionicons name="trash-outline" size={15} color={colors.textMuted} />
            </TouchableOpacity>
        </View>
    );
}

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        root: { flex: 1 },
        centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },

        // Progress
        progressRow: {
            flexDirection: 'row', alignItems: 'center', gap: 10,
            paddingHorizontal: 14, paddingVertical: 10,
            backgroundColor: c.cardBackground,
            borderBottomWidth: 0.5, borderBottomColor: c.border,
        },
        progressTrack: { flex: 1, height: 6, backgroundColor: c.border, borderRadius: 3, overflow: 'hidden' },
        progressFill: { height: '100%', backgroundColor: c.primary, borderRadius: 3 },
        progressText: { fontSize: 12, color: c.textSecondary, minWidth: 36, textAlign: 'right' },

        // List
        list: { flex: 1 },
        listContent: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24 },

        categoryHeader: {
            fontSize: 11, fontWeight: '700', color: c.textMuted,
            textTransform: 'uppercase', letterSpacing: 0.6,
            paddingTop: 14, paddingBottom: 4, paddingHorizontal: 2,
        },

        // Item card
        card: {
            flexDirection: 'row', alignItems: 'center',
            backgroundColor: c.cardBackground, borderRadius: 10,
            marginBottom: 6, overflow: 'hidden',
        },
        cardMain: {
            flex: 1, flexDirection: 'row', alignItems: 'center',
            gap: 10, padding: 10,
        },
        cardChecked: { opacity: 0.55 },
        checkbox: {
            width: 22, height: 22, borderRadius: 11,
            borderWidth: 2, borderColor: c.border,
            alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
        },
        checkboxChecked: { backgroundColor: c.primary, borderColor: c.primary },
        image: { width: 38, height: 38, borderRadius: 8 },
        cardContent: { flex: 1 },
        itemName: { fontSize: 14, fontWeight: '500', color: c.textPrimary, lineHeight: 18 },
        itemNameChecked: { textDecorationLine: 'line-through', color: c.textMuted },
        itemMeta: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
        deleteBtn: { padding: 12 },

        // Footer
        footer: {
            paddingVertical: 12, paddingHorizontal: 4,
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        },
        footerTotal: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
        fullScreenBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
        fullScreenBtnText: { fontSize: 13, color: c.primary, fontWeight: '600' },

        emptyText: { fontSize: 14, color: c.textMuted },
    });
