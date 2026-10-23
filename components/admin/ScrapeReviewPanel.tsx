import { View, Text, FlatList, TouchableOpacity, TextInput, Modal, StyleSheet } from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme, type AppTheme } from '../../constants/theme';
import { API_BASE_URL } from '../../config/api';
import { MaterialProgress } from '../MaterialProgress';
import { DateFilterButton } from '../DateFilterButton';
import { FilterDropdownModal, type FilterOption } from '../FilterDropdownModal';
import AdminProductCard, { type AdminProduct } from './AdminProductCard';
import { CategoryQuickAssignSheet } from './CategoryQuickAssignSheet';
import {
    getScrapeDays, getScrapeReview, setScrapeVerification,
    type ScrapeReviewProduct,
} from '../../services/adminClient';

/**
 * Scrape review: pick a chain + scrape day → cross-category product list of
 * everything that scrape CHANGED, narrowed by L1/L2/L3 dropdowns (same
 * FilterDropdownModal as the discounts screen). Verification mode overlays
 * ✓ / 🚩 on each card — checkmarked products leave the view, flags carry an
 * optional note; both are pulled later via scripts/scrapeReviewPull.
 */

interface Category { id: number; name: string; parentCategoryId: number | null; }

const CHAINS: { id: number; label: string }[] = [
    { id: 1, label: 'Maxima' },
    { id: 2, label: 'Rimi' },
    { id: 3, label: 'IKI' },
    { id: 4, label: 'Norfa' },
    { id: 5, label: 'Lidl' },
];
const NEPRISKIRTA_ID = 688;
const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function ScrapeReviewFilterBar({
    chainId, onChain, date, onDate, verifyMode, onVerifyMode,
}: {
    chainId: number | null;
    onChain: (id: number | null) => void;
    date: Date | null;
    onDate: (d: Date | null) => void;
    verifyMode: boolean;
    onVerifyMode: (v: boolean) => void;
}) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [days, setDays] = useState<Map<string, string[]>>(new Map());

    useEffect(() => {
        if (!chainId) { setDays(new Map()); return; }
        getScrapeDays(chainId)
            .then(r => setDays(new Map(r.days.map(d => [d, [colors.primary]]))))
            .catch(() => setDays(new Map()));
    }, [chainId, colors.primary]);

    return (
        <View style={styles.filterBar}>
            {CHAINS.map(c => {
                const active = chainId === c.id;
                return (
                    <TouchableOpacity
                        key={c.id}
                        style={[styles.chip, active && styles.chipActive]}
                        onPress={() => { onChain(active ? null : c.id); if (active) onDate(null); }}
                    >
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>{c.label}</Text>
                    </TouchableOpacity>
                );
            })}
            {chainId != null && (
                <DateFilterButton value={date} onChange={onDate} label="Data" markedDates={days} />
            )}
            {chainId != null && date != null && (
                <TouchableOpacity
                    style={[styles.chip, verifyMode && styles.chipActive]}
                    onPress={() => onVerifyMode(!verifyMode)}
                >
                    <Ionicons name="shield-checkmark-outline" size={14}
                        color={verifyMode ? colors.onPrimary : colors.textSecondary} />
                    <Text style={[styles.chipText, verifyMode && styles.chipTextActive]}>Patikra</Text>
                </TouchableOpacity>
            )}
        </View>
    );
}

export function ScrapeReviewList({
    chainId, date, verifyMode,
}: { chainId: number; date: Date; verifyMode: boolean }) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();

    const [cats, setCats] = useState<Category[]>([]);
    const [l1, setL1] = useState<number | null>(null);
    const [l2, setL2] = useState<number | null>(null);
    const [l3, setL3] = useState<number | null>(null);
    const [openFilter, setOpenFilter] = useState<null | 'l1' | 'l2' | 'l3'>(null);
    const [rows, setRows] = useState<ScrapeReviewProduct[]>([]);
    const [loading, setLoading] = useState(false);
    const [noteFor, setNoteFor] = useState<ScrapeReviewProduct | null>(null);
    const [noteText, setNoteText] = useState('');
    const [assignFor, setAssignFor] = useState<ScrapeReviewProduct | null>(null);
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
        return () => clearTimeout(t);
    }, [search]);

    useEffect(() => {
        fetch(`${API_BASE_URL}/api/categories`)
            .then(r => r.json())
            .then((all: Category[]) => Array.isArray(all) && setCats(all))
            .catch(() => {});
    }, []);

    const toOptions = (items: Category[]): FilterOption[] =>
        items.map(c => ({ id: c.id, label: c.name }));
    const l1Options = useMemo(() => {
        // /api/categories hides Nepriskirta (isHidden) — synthesize it first.
        const roots = cats.filter(c => c.parentCategoryId === null && c.id !== NEPRISKIRTA_ID);
        return [{ id: NEPRISKIRTA_ID, label: 'Nepriskirta' }, ...toOptions(roots)];
    }, [cats]);
    const l2Options = useMemo(
        () => (l1 && l1 !== NEPRISKIRTA_ID ? toOptions(cats.filter(c => c.parentCategoryId === l1)) : []),
        [cats, l1]);
    const l3Options = useMemo(
        () => (l2 ? toOptions(cats.filter(c => c.parentCategoryId === l2)) : []),
        [cats, l2]);
    const nameOf = (id: number | null) =>
        id === NEPRISKIRTA_ID ? 'Nepriskirta' : (cats.find(c => c.id === id)?.name ?? null);

    const dateStr = fmtDate(date);
    const load = useCallback(() => {
        setLoading(true);
        getScrapeReview({ chainId, date: dateStr, l1, l2, l3, unresolvedOnly: verifyMode, q: debouncedSearch || undefined })
            .then(r => setRows(r.products))
            .catch(() => setRows([]))
            .finally(() => setLoading(false));
    }, [chainId, dateStr, l1, l2, l3, verifyMode, debouncedSearch]);
    useEffect(load, [load]);

    const verify = useCallback(async (p: ScrapeReviewProduct, status: 'checked' | 'flagged' | null, note?: string) => {
        // optimistic: checked rows vanish in verify mode; flags mark in place
        setRows(prev => verifyMode && status === 'checked'
            ? prev.filter(r => r.id !== p.id)
            : prev.map(r => (r.id === p.id ? { ...r, verifyStatus: status, verifyNote: note ?? null } : r)));
        try {
            await setScrapeVerification({ chainId, date: dateStr, productId: p.id, status, note: note ?? null });
        } catch {
            load(); // roll back to server truth
        }
    }, [chainId, dateStr, verifyMode, load]);

    const renderCard = useCallback(({ item }: { item: ScrapeReviewProduct }) => (
        <View style={styles.cardCell}>
            <AdminProductCard
                product={item as unknown as AdminProduct}
                selectionMode={false}
                selected={false}
                onPress={() => router.push(`/admin/product/${item.id}` as any)}
                onLongPress={() => {}}
                containerStyle={{ maxWidth: '100%' }}
            />
            {verifyMode && (
                <View style={styles.verifyOverlay}>
                    <TouchableOpacity
                        style={[styles.verifyBtn, item.verifyStatus === 'checked' && styles.verifyBtnOn]}
                        onPress={() => verify(item, item.verifyStatus === 'checked' ? null : 'checked')}
                        hitSlop={6}
                    >
                        <Ionicons name="checkmark" size={16}
                            color={item.verifyStatus === 'checked' ? '#fff' : colors.textSecondary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.verifyBtn, item.verifyStatus === 'flagged' && styles.flagBtnOn]}
                        onPress={() => {
                            if (item.verifyStatus === 'flagged') { verify(item, null); return; }
                            setNoteFor(item); setNoteText('');
                        }}
                        hitSlop={6}
                    >
                        <Ionicons name="flag-outline" size={14}
                            color={item.verifyStatus === 'flagged' ? '#fff' : colors.textSecondary} />
                    </TouchableOpacity>
                </View>
            )}
            {item.verifyStatus === 'flagged' && (
                <View style={styles.flagBanner}>
                    <Ionicons name="flag" size={12} color="#fff" />
                    <Text style={styles.flagText} numberOfLines={1}>{item.verifyNote || 'Pažymėta'}</Text>
                </View>
            )}
            <TouchableOpacity
                style={[styles.assignBtn, item.categoryId !== NEPRISKIRTA_ID && styles.assignBtnQuiet]}
                onPress={() => setAssignFor(item)}
            >
                <Ionicons name="pricetag-outline" size={12}
                    color={item.categoryId === NEPRISKIRTA_ID ? colors.onPrimary : colors.textSecondary} />
                <Text style={[styles.assignText, item.categoryId !== NEPRISKIRTA_ID && styles.assignTextQuiet]}
                    numberOfLines={1}>
                    {item.categoryId === NEPRISKIRTA_ID ? 'Kategorija?' : (item.categoryName ?? 'Kategorija')}
                </Text>
            </TouchableOpacity>
        </View>
    ), [styles, colors, verifyMode, verify, router]);

    return (
        <View style={{ flex: 1 }}>
            {/* Search — matches ONLY the selected chain's SP names (spec). */}
            <View style={styles.searchWrap}>
                <Ionicons name="search" size={16} color={colors.textMuted} />
                <TextInput
                    style={styles.searchInput}
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Ieškoti pagal tinklo SP pavadinimą…"
                    placeholderTextColor={colors.textMuted}
                    returnKeyType="search"
                />
                {search.length > 0 && (
                    <TouchableOpacity onPress={() => setSearch('')} hitSlop={8}>
                        <Ionicons name="close" size={16} color={colors.textMuted} />
                    </TouchableOpacity>
                )}
            </View>
            {/* Category dropdowns — same interaction as the discounts screen. */}
            <View style={styles.catBar}>
                <TouchableOpacity
                    style={[styles.chip, l1 != null && styles.chipActive]}
                    onPress={() => setOpenFilter('l1')}
                >
                    <Text style={[styles.chipText, l1 != null && styles.chipTextActive]} numberOfLines={1}>
                        {nameOf(l1) ?? 'Kategorija'}
                    </Text>
                    <Ionicons name="chevron-down" size={13} color={l1 != null ? colors.onPrimary : colors.textSecondary} />
                </TouchableOpacity>
                {l1 != null && l2Options.length > 0 && (
                    <TouchableOpacity
                        style={[styles.chip, l2 != null && styles.chipActive]}
                        onPress={() => setOpenFilter('l2')}
                    >
                        <Text style={[styles.chipText, l2 != null && styles.chipTextActive]} numberOfLines={1}>
                            {nameOf(l2) ?? 'Subkategorija'}
                        </Text>
                        <Ionicons name="chevron-down" size={13} color={l2 != null ? colors.onPrimary : colors.textSecondary} />
                    </TouchableOpacity>
                )}
                {l2 != null && l3Options.length > 0 && (
                    <TouchableOpacity
                        style={[styles.chip, l3 != null && styles.chipActive]}
                        onPress={() => setOpenFilter('l3')}
                    >
                        <Text style={[styles.chipText, l3 != null && styles.chipTextActive]} numberOfLines={1}>
                            {nameOf(l3) ?? 'Grupė'}
                        </Text>
                        <Ionicons name="chevron-down" size={13} color={l3 != null ? colors.onPrimary : colors.textSecondary} />
                    </TouchableOpacity>
                )}
            </View>

            {loading ? (
                <MaterialProgress size="large" color={colors.primary} style={{ marginTop: 40 }} />
            ) : (
                <FlatList
                    data={rows}
                    keyExtractor={p => String(p.id)}
                    renderItem={renderCard}
                    numColumns={2}
                    columnWrapperStyle={styles.productRow}
                    contentContainerStyle={{ padding: 12, paddingBottom: 90 }}
                    ListEmptyComponent={<Text style={styles.empty}>Nieko nerasta šiai dienai.</Text>}
                />
            )}

            <FilterDropdownModal
                visible={openFilter !== null}
                title={openFilter === 'l1' ? 'Kategorija' : openFilter === 'l2' ? 'Subkategorija' : 'Grupė'}
                options={openFilter === 'l1' ? l1Options : openFilter === 'l2' ? l2Options : l3Options}
                onClose={() => setOpenFilter(null)}
                config={{
                    mode: 'single',
                    selectedId: openFilter === 'l1' ? l1 : openFilter === 'l2' ? l2 : l3,
                    allLabel: 'Visos',
                    onSelect: (id: number | null) => {
                        if (openFilter === 'l1') { setL1(id); setL2(null); setL3(null); }
                        else if (openFilter === 'l2') { setL2(id); setL3(null); }
                        else setL3(id);
                    },
                }}
            />

            {assignFor && (
                <CategoryQuickAssignSheet
                    productId={assignFor.id}
                    productName={assignFor.name}
                    visible={assignFor != null}
                    onClose={() => setAssignFor(null)}
                    onAssigned={(categoryId, categoryName) => {
                        setRows(prev => prev.map(r => (r.id === assignFor.id
                            ? { ...r, categoryId, categoryName } : r)));
                    }}
                />
            )}

            {/* Flag note */}
            <Modal visible={noteFor != null} transparent animationType="fade" onRequestClose={() => setNoteFor(null)}>
                <View style={styles.noteOverlay}>
                    <View style={styles.noteCard}>
                        <Text style={styles.noteTitle} numberOfLines={2}>🚩 {noteFor?.name}</Text>
                        <TextInput
                            style={styles.noteInput}
                            placeholder="Pastaba (nebūtina)"
                            placeholderTextColor={colors.textMuted}
                            value={noteText}
                            onChangeText={setNoteText}
                            multiline
                            autoFocus
                        />
                        <View style={styles.noteActions}>
                            <TouchableOpacity onPress={() => setNoteFor(null)}>
                                <Text style={styles.noteCancel}>Atšaukti</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.noteSave}
                                onPress={() => {
                                    if (noteFor) verify(noteFor, 'flagged', noteText.trim() || undefined);
                                    setNoteFor(null);
                                }}
                            >
                                <Text style={styles.noteSaveText}>Pažymėti</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    filterBar: {
        flexDirection: 'row', flexWrap: 'wrap', gap: 6,
        paddingHorizontal: 12, paddingVertical: 8,
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5, borderBottomColor: c.border,
        alignItems: 'center',
    },
    searchWrap: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        marginHorizontal: 12, marginTop: 8,
        paddingHorizontal: 12, paddingVertical: 8,
        borderRadius: 20, backgroundColor: c.cardBackground,
        borderWidth: 1, borderColor: c.border,
    },
    searchInput: { flex: 1, fontSize: 14, color: c.textPrimary, padding: 0 },
    catBar: {
        flexDirection: 'row', gap: 6,
        paddingHorizontal: 12, paddingVertical: 8,
        alignItems: 'center',
    },
    chip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingHorizontal: 12, paddingVertical: 7,
        borderRadius: 16, backgroundColor: c.pageBackground,
        borderWidth: 1, borderColor: c.border,
    },
    chipActive: { backgroundColor: c.primary, borderColor: c.primary },
    chipText: { fontSize: 13, color: c.textPrimary, maxWidth: 150 },
    chipTextActive: { color: c.onPrimary, fontWeight: '600' },

    // Grid — mirrors admin/catalog/[categoryId]: the card itself is flex:1,
    // the cell only adds the verify overlay anchor.
    productRow: { gap: 12, marginBottom: 12 },
    cardCell: { flex: 1, maxWidth: '50%' },
    verifyOverlay: {
        position: 'absolute', top: 6, right: 6,
        flexDirection: 'row', gap: 6, zIndex: 2,
    },
    verifyBtn: {
        width: 30, height: 30, borderRadius: 15,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.border,
        elevation: 2,
    },
    verifyBtnOn: { backgroundColor: '#2e9e5b', borderColor: '#2e9e5b' },
    flagBtnOn: { backgroundColor: '#d9534f', borderColor: '#d9534f' },
    flagBanner: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: '#d9534f', borderRadius: 6,
        paddingHorizontal: 6, paddingVertical: 3, marginTop: 4,
    },
    flagText: { fontSize: 11, color: '#fff', flex: 1 },
    assignBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
        backgroundColor: c.primary, borderRadius: 6,
        paddingHorizontal: 6, paddingVertical: 4, marginTop: 4,
    },
    assignText: { fontSize: 11, color: c.onPrimary, fontWeight: '600' },
    assignBtnQuiet: { backgroundColor: c.pageBackground, borderWidth: 1, borderColor: c.border },
    assignTextQuiet: { color: c.textSecondary, fontWeight: '400' },
    empty: { textAlign: 'center', color: c.textSecondary, marginTop: 40 },

    noteOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 },
    noteCard: { backgroundColor: c.cardBackground, borderRadius: 14, padding: 16, gap: 12 },
    noteTitle: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
    noteInput: {
        minHeight: 70, borderWidth: 1, borderColor: c.border, borderRadius: 8,
        padding: 10, color: c.textPrimary, textAlignVertical: 'top',
    },
    noteActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 16 },
    noteCancel: { color: c.textSecondary, fontSize: 14 },
    noteSave: { backgroundColor: c.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
    noteSaveText: { color: c.onPrimary, fontWeight: '600' },
});
