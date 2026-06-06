import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useState, useCallback, useMemo, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../../constants/theme';
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

    const [entries, setEntries] = useState<SplitListEntry[]>([]);
    const [entriesLoaded, setEntriesLoaded] = useState(!basketId);
    const [activeListId, setActiveListId] = useState(parseInt(id));
    const [listSummaries, setListSummaries] = useState<Map<number, { itemCount: number; checkedCount: number }>>(new Map());

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

    // Brief loading state only when basketId is provided and entries haven't loaded yet
    if (!entriesLoaded) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator color={colors.primary} />
            </View>
        );
    }

    return (
        <View style={{ flex: 1 }}>
            <ShoppingListDetail
                key={activeListId}
                listId={activeListId}
                expectedCount={expectedCount ? parseInt(expectedCount) : undefined}
                isPartOfBasket={isMulti}
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
        </View>
    );
}

const styles = StyleSheet.create({
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
