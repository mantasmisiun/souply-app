import {
    View,
    Text,
    Modal,
    TouchableOpacity,
    StyleSheet,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useLocalSearchParams, useFocusEffect, useRouter } from 'expo-router';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme, spacing, radius, typography, elevation, type AppTheme } from '../../constants/theme';
import { ShoppingListDetail } from '../../components/ShoppingListDetail';
import { StoreChipBar } from '../../components/StoreChipBar';
import { getMiniLogoUrl, chainBrandName } from '../../utils/chainBrandName';
import { formatStoreStreet } from '../../utils/formatAddress';
import { API_BASE_URL } from '../../config/api';

interface SplitListEntry {
    storeId: number;
    storeName: string;
    storeAddress?: string;
    chainName: string;
    chainLogoUrl: string | null;
    listId: number;
}

export default function UnifiedShoppingListScreen() {
    const colors = useTheme();
    const { id, basketId, expectedCount } = useLocalSearchParams<{
        id: string;
        basketId?: string;
        expectedCount?: string;
    }>();

    const router = useRouter();
    const { t } = useTranslation();
    const [entries, setEntries] = useState<SplitListEntry[]>([]);
    const [entriesLoaded, setEntriesLoaded] = useState(!basketId);
    const [activeListId, setActiveListId] = useState(parseInt(id));
    const [listSummaries, setListSummaries] = useState<Map<number, { itemCount: number; checkedCount: number }>>(new Map());
    // Whole-trip completion confirm (shown only when EVERY store's items are
    // checked). One-shot per basket, persisted like the single-list prompt.
    const [tripCompleteModal, setTripCompleteModal] = useState(false);
    const tripPromptClaimedRef = useRef(false);
    // Silent advance-to-next-store: once per list, so unticking/reticking an
    // item can't bounce the user between stores.
    const advancedRef = useRef<Set<number>>(new Set());

    // Load split basket entries from AsyncStorage (very fast local read)
    useEffect(() => {
        if (!basketId) return;
        AsyncStorage.getItem(`split_lists_${basketId}`).then(raw => {
            if (raw) {
                const parsed: SplitListEntry[] = JSON.parse(raw);
                setEntries(parsed);
                // If the current id isn't in the entries, default to the first
                if (parsed.length > 0 && !parsed.find(e => e.listId === parseInt(id))) {
                    setActiveListId(parsed[0].listId);
                }
            }
            setEntriesLoaded(true);
        });
    }, []);

    // Refresh entries when screen comes back into focus (in case list was deleted)
    useFocusEffect(useCallback(() => {
        if (!basketId) return;
        AsyncStorage.getItem(`split_lists_${basketId}`).then(raw => {
            if (raw) setEntries(JSON.parse(raw));
        });
    }, [basketId]));

    // Fetch remaining-item counts for each store's chip badge.
    // The individual list endpoint doesn't aggregate counts so we fetch items directly.
    useEffect(() => {
        if (entries.length < 2) return;
        Promise.all(
            entries.map(e =>
                fetch(`${API_BASE_URL}/api/shopping-lists/${e.listId}/items`)
                    .then(r => r.ok ? r.json() : [])
                    .then((items: { isChecked: boolean }[]) => {
                        const total = items.length;
                        const checked = items.filter(i => i.isChecked).length;
                        return [e.listId, { itemCount: total, checkedCount: checked }] as const;
                    })
                    .catch(() => null)
            )
        ).then(results => {
            const map = new Map<number, { itemCount: number; checkedCount: number }>();
            results.forEach(r => { if (r) map.set(r[0], r[1]); });
            setListSummaries(map);
        });
    }, [entries]);

    const isMulti = entries.length > 1;

    const chips = useMemo(() => entries.map(e => {
        const summary = listSummaries.get(e.listId);
        const remaining = summary ? summary.itemCount - summary.checkedCount : undefined;
        return {
            id: e.listId,
            label: chainBrandName(e.chainName),
            count: remaining,
            logoUrl: e.chainLogoUrl ? getMiniLogoUrl(e.chainName, e.chainLogoUrl) : null,
        };
    }), [entries, listSummaries]);

    // Title row = the short chain names; breadcrumb under it = the addresses.
    // Single store derives these from the list itself inside ShoppingListDetail.
    const storeNames = useMemo(
        () => isMulti ? entries.map(e => chainBrandName(e.chainName)).filter(Boolean).join(' · ') : undefined,
        [isMulti, entries]
    );
    const storeAddresses = useMemo(
        () => isMulti ? entries.map(e => formatStoreStreet(e.storeAddress) || e.storeName).filter(Boolean).join(' · ') : undefined,
        [isMulti, entries]
    );

    // Live per-list progress from the mounted detail (load + every toggle).
    const handleItemsProgress = useCallback((listId: number, checkedCount: number, itemCount: number) => {
        setListSummaries(prev => {
            const cur = prev.get(listId);
            if (cur && cur.checkedCount === checkedCount && cur.itemCount === itemCount) return prev;
            const next = new Map(prev);
            next.set(listId, { itemCount, checkedCount });
            return next;
        });
    }, []);

    const fullyChecked = (s?: { itemCount: number; checkedCount: number }) =>
        s != null && s.itemCount > 0 && s.checkedCount >= s.itemCount;

    // React to progress: advance to the next unfinished store when the ACTIVE
    // one finishes (silent, once per list), and prompt the whole-trip
    // completion only when EVERY store is fully checked.
    useEffect(() => {
        if (!isMulti || entries.length === 0) return;
        const active = listSummaries.get(activeListId);
        const allDone = entries.every(e => fullyChecked(listSummaries.get(e.listId)));
        if (allDone) {
            if (tripPromptClaimedRef.current) return;
            tripPromptClaimedRef.current = true;
            (async () => {
                const key = `sl_prompted_basket_${basketId}`;
                const already = await AsyncStorage.getItem(key);
                if (already === '1') return;
                await AsyncStorage.setItem(key, '1');
                setTripCompleteModal(true);
            })();
            return;
        }
        if (fullyChecked(active) && !advancedRef.current.has(activeListId)) {
            advancedRef.current.add(activeListId);
            const next = entries.find(e => e.listId !== activeListId && !fullyChecked(listSummaries.get(e.listId)));
            if (next) setActiveListId(next.listId);
        }
         
    }, [listSummaries, activeListId, entries, isMulti, basketId]);

    // Brief loading state only when basketId is provided and entries haven't loaded yet
    if (!entriesLoaded) {
        return (
            <View style={styles.centered}>
                <MaterialProgress color={colors.primary} />
            </View>
        );
    }

    // Confirm: mark EVERY store's sub-list completed, then leave.
    const completeWholeTrip = async () => {
        setTripCompleteModal(false);
        await Promise.all(entries.map(e =>
            fetch(`${API_BASE_URL}/api/shopping-lists/${e.listId}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'completed' }),
            }).catch(() => {}),
        ));
        router.back();
    };

    return (
        <View style={{ flex: 1 }}>
            <ShoppingListDetail
                key={activeListId}
                listId={activeListId}
                expectedCount={expectedCount ? parseInt(expectedCount) : undefined}
                isPartOfBasket={isMulti}
                onItemsProgress={isMulti ? handleItemsProgress : undefined}
                headerTitle={storeNames}
                headerSubtitle={storeAddresses}
                pinnedHeader={isMulti ? (
                    <StoreChipBar
                        chips={chips}
                        selectedId={activeListId}
                        onSelect={listId => setActiveListId(listId as number)}
                    />
                ) : undefined}
            />

            {/* Whole-trip completion confirm — every store's items are checked. */}
            <Modal visible={tripCompleteModal} transparent animationType="fade" onRequestClose={() => setTripCompleteModal(false)}>
                <View style={mStyles(colors).overlay}>
                    <TouchableOpacity style={StyleSheet.absoluteFillObject} activeOpacity={1} onPress={() => setTripCompleteModal(false)} />
                    <View style={mStyles(colors).card}>
                        <Text style={mStyles(colors).title}>{t('shoppingListDetail.completeTitle')}</Text>
                        <Text style={mStyles(colors).body}>{t('shoppingListDetail.completeConfirm')}</Text>
                        <View style={mStyles(colors).buttons}>
                            <TouchableOpacity style={mStyles(colors).cancel} onPress={() => setTripCompleteModal(false)}>
                                <Text style={mStyles(colors).cancelText}>{t('shoppingListDetail.completeNo')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={mStyles(colors).confirm} onPress={completeWholeTrip}>
                                <Text style={mStyles(colors).confirmText}>{t('shoppingListDetail.completeYes')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

// Trip-completion modal styles — mirrors ShoppingListDetail's completion modal.
const mStyles = (c: AppTheme) => StyleSheet.create({
    overlay: { flex: 1, backgroundColor: c.overlayBackdrop, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
    card: { backgroundColor: c.cardBackground, borderRadius: radius.xl, padding: spacing.xl, width: '100%', maxWidth: 360, ...elevation.level3 },
    title: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary, marginBottom: spacing.sm },
    body: { ...typography.bodySmall, color: c.textSecondary, marginBottom: spacing.xl },
    buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md },
    cancel: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
    cancelText: { ...typography.body, color: c.textSecondary },
    confirm: { backgroundColor: c.primary, borderRadius: radius.pill, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
    confirmText: { ...typography.body, color: c.onPrimary, fontWeight: '600' },
});
