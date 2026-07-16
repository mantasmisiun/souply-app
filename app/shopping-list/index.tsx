import {
    View,
    Text,
    FlatList,
    TouchableOpacity,
    StyleSheet,
    Alert,
    BackHandler,
    Modal,
    Platform,
    RefreshControl,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { useTheme, spacing, radius, elevation, iconSize, avatarSize, typography, type AppTheme } from '../../constants/theme';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { glassHeaderOptions } from '../../constants/navHeader';
import { ScreenHeading } from '../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../components/CollapsingHeader';
import { SkeletonBox } from '../../components/SkeletonBox';
import { formatDate } from '../../utils/formatCurrency';
import { chainBrandName, getMiniLogoUrl, chainIdByName } from '../../utils/chainBrandName';
import { ChainLogoChip } from '../../components/ChainLogoChip';
import { formatStoreStreet } from '../../utils/formatAddress';
import { launchDocumentScanner } from '../../utils/launchDocumentScanner';
import { StoreChipBar } from '../../components/StoreChipBar';
import { CardActionBar, type CardAction } from '../../components/CardActionBar';
import { useTabBarOverride } from '../../state/tabBarOverride';
import { isAwaitingReceipt, groupReceiptProgress } from '../../utils/awaitingReceipts';
import * as DocumentPicker from 'expo-document-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface StoreChain {
    id: number;
    name: string;
    logoUrl: string | null;
}

interface Store {
    id: number;
    chainId: number;
    address: string;
}

type Styles = ReturnType<typeof makeStyles>;

interface ShoppingList {
    id: number;
    storeId: number;
    storeName: string;
    address: string;
    chainName: string;
    chainId?: number;
    logoUrl: string | null;
    status: string;
    basketId?: number | null;
    createdAt: string;
    itemCount: number;
    checkedCount: number;
    receiptCount?: number;
}

/** A row from /api/users/:id/receipts — used by the "already uploaded" picker. */
interface UserReceipt {
    id: number;
    chainName: string;
    receiptDate?: string | null;
    receiptNo?: string | null;
    shoppingListId?: number | null;
    processingStatus?: string | null;
}

interface SplitGroupEntry {
    storeId: number;
    storeName: string;
    chainName: string;
    chainLogoUrl: string | null;
    listId: number;
}

interface SplitGroup {
    basketId: string;
    entries: SplitGroupEntry[];
    lists: ShoppingList[];
}

// Build a chainId→listId map for the awaiting store rows of a list/group.
// The receipt's detected chain auto-selects which row to link (no prompt).
const buildChainListMap = (rows: ShoppingList[]): Record<number, number> => {
    const map: Record<number, number> = {};
    for (const l of rows) {
        const cid = l.chainId ?? chainIdByName(l.chainName) ?? 0;
        if (cid) map[cid] = l.id;
    }
    return map;
};
const mapToParam = (map: Record<number, number>) =>
    Object.entries(map).map(([c, l]) => `${c}:${l}`).join(',');

// ─── Receipt status pill (shown on completed cards) ───────────────────────────

function ReceiptPill({ awaiting, label, styles, colors }: {
    awaiting: boolean;
    label: string;
    styles: Styles;
    colors: AppTheme;
}) {
    return (
        <View style={[styles.receiptPill, awaiting ? styles.receiptPillNeeded : styles.receiptPillDone]}>
            <Ionicons
                name={awaiting ? 'receipt-outline' : 'checkmark-circle'}
                size={iconSize.xs}
                color={awaiting ? colors.warning : colors.textMuted}
            />
            <Text style={awaiting ? styles.receiptPillTextNeeded : styles.receiptPillTextDone}>{label}</Text>
        </View>
    );
}

// ─── Single-store card ────────────────────────────────────────────────────────

function ShoppingListCard({ item, onPress, onLongPress, selectionMode, selected, styles, colors }: {
    item: ShoppingList;
    onPress: (id: number) => void;
    onLongPress?: () => void;
    selectionMode?: boolean;
    selected?: boolean;
    styles: Styles;
    colors: AppTheme;
}) {
    const { t } = useTranslation();
    const progress = item.itemCount > 0 ? item.checkedCount / item.itemCount : 0;
    const awaitingReceipt = isAwaitingReceipt(item);

    return (
        <TouchableOpacity
            style={[
                styles.card,
                item.status === 'active'
                    ? styles.cardActive
                    : awaitingReceipt ? styles.cardAwaiting : styles.cardCompleted,
            ]}
            onPress={() => onPress(item.id)}
            onLongPress={onLongPress}
            delayLongPress={350}
            activeOpacity={0.75}
        >
            {selectionMode && (
                <View style={[styles.selectCircle, selected && styles.selectCircleChecked]}>
                    {selected && <Ionicons name="checkmark" size={iconSize.xs} color={colors.onPrimary} />}
                </View>
            )}
            <View style={styles.cardLeft}>
                <ChainLogoChip chainId={chainIdByName(item.chainName) ?? 0} name={item.chainName} size={avatarSize.md} />
            </View>
            <View style={styles.cardContent}>
                <Text style={styles.storeName} numberOfLines={1}>{formatStoreStreet(item.address)}</Text>
                <Text style={styles.date}>{formatDate(item.createdAt)}</Text>
                {item.status === 'active' && item.itemCount > 0 && (
                    <View style={styles.progressRow}>
                        <View style={styles.progressBar}>
                            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                        </View>
                        <Text style={styles.progressText}>{item.checkedCount}/{item.itemCount}</Text>
                    </View>
                )}
                {item.status === 'completed' && (
                    <ReceiptPill
                        awaiting={awaitingReceipt}
                        label={awaitingReceipt
                            ? t('shoppingListTab.receiptNeeded')
                            : (item as any).receiptSkippedAt != null && (Number(item.receiptCount) || 0) === 0
                                ? t('shoppingListTab.receiptSkipped')
                                : t('shoppingListTab.receiptAdded')}
                        styles={styles}
                        colors={colors}
                    />
                )}
            </View>
            <View style={styles.badgeContainer}>
                {awaitingReceipt ? (
                    <View style={styles.uploadCue}>
                        <Ionicons name="camera" size={iconSize.sm} color={colors.onPrimary} />
                    </View>
                ) : (
                    <View style={[styles.badge, item.status === 'completed' && styles.badgeCompleted]}>
                        <Text style={[styles.badgeText, item.status === 'completed' && styles.badgeTextCompleted]}>
                            {item.itemCount}
                        </Text>
                    </View>
                )}
            </View>
        </TouchableOpacity>
    );
}

// ─── Multi-store split-basket card ───────────────────────────────────────────

function SplitGroupCard({ group, onPress, onLongPress, selectionMode, selected, styles, colors }: {
    group: SplitGroup;
    onPress: () => void;
    onLongPress?: () => void;
    selectionMode?: boolean;
    selected?: boolean;
    styles: Styles;
    colors: AppTheme;
}) {
    const { t } = useTranslation();
    const totalItems = group.lists.reduce((s, l) => s + Number(l.itemCount), 0);
    const checkedItems = group.lists.reduce((s, l) => s + Number(l.checkedCount), 0);
    const progress = totalItems > 0 ? checkedItems / totalItems : 0;
    const isCompleted = group.lists.length > 0 && group.lists.every(l => l.status === 'completed');
    const receipts = groupReceiptProgress(group.lists);
    const awaitingReceipt = isCompleted && receipts.have < receipts.total;
    const streets = group.lists.map(l => formatStoreStreet(l.address)).filter(Boolean).join(' · ');
    const date = group.lists[0]?.createdAt;

    return (
        <TouchableOpacity
            style={[
                styles.card,
                !isCompleted ? styles.cardActive : awaitingReceipt ? styles.cardAwaiting : styles.cardCompleted,
            ]}
            onPress={onPress}
            onLongPress={onLongPress}
            delayLongPress={350}
            activeOpacity={0.75}
        >
            {selectionMode && (
                <View style={[styles.selectCircle, selected && styles.selectCircleChecked]}>
                    {selected && <Ionicons name="checkmark" size={iconSize.xs} color={colors.onPrimary} />}
                </View>
            )}
            <View style={styles.cardLeft}>
                <View style={styles.splitLogos}>
                    {group.entries.slice(0, 3).map((entry, idx) => (
                        <ChainLogoChip
                            key={entry.storeId}
                            chainId={chainIdByName(entry.chainName) ?? 0}
                            name={entry.chainName}
                            size={avatarSize.sm}
                            style={idx > 0 ? styles.splitLogoOverlap : null}
                        />
                    ))}
                </View>
            </View>
            <View style={styles.cardContent}>
                <View style={styles.splitLabelRow}>
                    <Text style={styles.storeName} numberOfLines={1}>{streets}</Text>
                </View>
                {date ? <Text style={styles.date}>{formatDate(date)}</Text> : null}
                {!isCompleted && totalItems > 0 && (
                    <View style={styles.progressRow}>
                        <View style={styles.progressBar}>
                            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                        </View>
                        <Text style={styles.progressText}>{checkedItems}/{totalItems}</Text>
                    </View>
                )}
                {isCompleted && (
                    <ReceiptPill
                        awaiting={awaitingReceipt}
                        label={t('shoppingListTab.receiptProgress', { have: receipts.have, total: receipts.total })}
                        styles={styles}
                        colors={colors}
                    />
                )}
            </View>
            <View style={styles.badgeContainer}>
                {awaitingReceipt ? (
                    <View style={styles.uploadCue}>
                        <Ionicons name="camera" size={iconSize.sm} color={colors.onPrimary} />
                    </View>
                ) : (
                    <View style={[styles.badge, isCompleted && styles.badgeCompleted]}>
                        <Text style={[styles.badgeText, isCompleted && styles.badgeTextCompleted]}>{totalItems}</Text>
                    </View>
                )}
            </View>
        </TouchableOpacity>
    );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function ShoppingListScreen() {
    const colors = useTheme();
    const header = useCollapsingHeader();
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    // Pushed route (Souply 2.0): no tab bar below — clear only the system inset.
    const tabBarHeight = insets.bottom;
    const [lists, setLists] = useState<ShoppingList[]>([]);
    const [splitGroups, setSplitGroups] = useState<SplitGroup[]>([]);
    const [chainFilter, setChainFilter] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedListIds, setSelectedListIds] = useState<Set<number>>(new Set());
    // Receipt-upload sheet target: chainId→listId for the awaiting store(s)
    // of the tapped card (single = 1 entry, split group = N).
    const [uploadTarget, setUploadTarget] = useState<Record<number, number> | null>(null);
    // Route of the card that opened the upload sheet — powers the "view list"
    // option so an awaiting-receipt list is still openable (checked items
    // remain reviewable; the tap is not upload-only).
    const [uploadViewRoute, setUploadViewRoute] = useState<string | null>(null);
    // The user's receipts (for the "select from already uploaded" option).
    const [receipts, setReceipts] = useState<UserReceipt[]>([]);
    // The fully-receipted "Completed" archive is collapsed by default.
    const [completedCollapsed, setCompletedCollapsed] = useState(true);

    const exitSelection = useCallback(() => {
        setSelectionMode(false);
        setSelectedListIds(new Set());
    }, []);

    const toggleSelectList = useCallback((listId: number) => {
        setSelectedListIds(prev => {
            const next = new Set(prev);
            if (next.has(listId)) next.delete(listId); else next.add(listId);
            return next;
        });
    }, []);

    const toggleSelectGroup = useCallback((groupListIds: number[]) => {
        setSelectedListIds(prev => {
            const next = new Set(prev);
            const allSelected = groupListIds.every(id => next.has(id));
            if (allSelected) groupListIds.forEach(id => next.delete(id));
            else groupListIds.forEach(id => next.add(id));
            return next;
        });
    }, []);

    useEffect(() => {
        if (selectionMode && selectedListIds.size === 0) setSelectionMode(false);
    }, [selectionMode, selectedListIds]);

    // Android back (button or swipe gesture) during selection = CANCEL the
    // selection, never leave the screen/app.
    useEffect(() => {
        if (!selectionMode) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            exitSelection();
            return true;
        });
        return () => sub.remove();
    }, [selectionMode, exitSelection]);
    const router = useRouter();

    const loadSplitGroups = useCallback(async (currentLists: ShoppingList[]) => {
        try {
            const allKeys = await AsyncStorage.getAllKeys();
            const splitKeys = allKeys.filter(k => k.startsWith('split_lists_'));
            if (splitKeys.length === 0) { setSplitGroups([]); return; }
            const pairs = await AsyncStorage.multiGet(splitKeys);
            const groups: SplitGroup[] = [];
            for (const [key, value] of pairs) {
                if (!value) continue;
                const basketId = key.replace('split_lists_', '');
                const entries: SplitGroupEntry[] = JSON.parse(value);
                const matchedLists = entries
                    .map(e => currentLists.find(l => l.id === e.listId))
                    .filter((l): l is ShoppingList => l !== undefined);
                if (matchedLists.length > 0) {
                    groups.push({ basketId, entries, lists: matchedLists });
                }
            }
            setSplitGroups(groups);
        } catch {
            setSplitGroups([]);
        }
    }, []);

    const fetchLists = useCallback(async () => {
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/shopping-lists/user/${userId}`);
            const data = await res.json();
            const listData: ShoppingList[] = Array.isArray(data) ? data : [];
            setLists(listData);
            await loadSplitGroups(listData);
        } catch (error) {
            console.error('Failed to fetch lists:', error);
        } finally {
            setLoading(false);
        }
    }, [loadSplitGroups]);

    const fetchReceipts = useCallback(async () => {
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/users/${userId}/receipts`);
            const data = await res.json();
            setReceipts(Array.isArray(data) ? data : []);
        } catch { /* advisory — only powers the "already uploaded" option */ }
    }, []);

    useFocusEffect(useCallback(() => {
        fetchLists();
        fetchReceipts();
    }, [fetchLists, fetchReceipts]));

    // Unlinked receipts whose chain matches one of the target's awaiting
    // stores — the candidates for "select from already uploaded". Chain-
    // filtered so a Lidl receipt can't be attached to a Maxima list.
    const unlinkedReceiptsForMap = useCallback((map: Record<number, number> | null) => {
        if (!map) return [] as UserReceipt[];
        const chains = Object.keys(map).map(Number);
        return receipts.filter(r =>
            r.shoppingListId == null &&
            r.processingStatus !== 'failed' &&
            chains.includes(chainIdByName(r.chainName) ?? -1),
        );
    }, [receipts]);

    // ── Delete / complete list ────────────────────────────────────────────────

    const deleteList = useCallback(async (listId: number) => {
        setLists(prev => prev.filter(l => l.id !== listId));
        try {
            await fetch(`${API_BASE_URL}/api/shopping-lists/${listId}`, { method: 'DELETE' });
        } catch {
            fetchLists();
        }
    }, [fetchLists]);

    const completeList = useCallback(async (listId: number) => {
        setLists(prev => prev.map(l => l.id === listId ? { ...l, status: 'completed' } : l));
        try {
            await fetch(`${API_BASE_URL}/api/shopping-lists/${listId}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'completed' }),
            });
        } catch {
            fetchLists();
        }
    }, [fetchLists]);


    // Multi-select actions (shared by the Android tab-bar morph and the iOS
    // inline bar): complete every selected ACTIVE list, delete the selection.
    const selectionActions = useMemo<CardAction[]>(() => {
        const ids = Array.from(selectedListIds);
        const hasActiveStatus = lists.some(l => ids.includes(l.id) && l.status === 'active');
        const actions: CardAction[] = [];
        if (hasActiveStatus) {
            actions.push({
                icon: 'checkmark-circle-outline',
                label: t('shoppingListTab.complete'),
                onPress: () => {
                    lists.forEach(l => { if (ids.includes(l.id) && l.status === 'active') completeList(l.id); });
                    exitSelection();
                },
            });
        }
        actions.push({
            icon: 'trash-outline',
            label: t('shoppingListTab.delete'),
            destructive: true,
            onPress: () => {
                ids.forEach(id => deleteList(id));
                exitSelection();
            },
        });
        return actions;
         
    }, [selectedListIds, lists, completeList, deleteList, exitSelection, t]);

    // ANDROID: morph the floating pill tab bar into the selection action bar
    // (the old inline bar rendered BEHIND the floating pill). Cancel is the
    // trailing item; cleared on exit/unmount so the tabs are never stranded.
    const setTabBarOverride = useTabBarOverride(s => s.setOverride);
    const clearTabBarOverride = useTabBarOverride(s => s.clearOverride);
    useEffect(() => {
        if (Platform.OS === 'ios') return;
        if (!(selectionMode && selectedListIds.size > 0)) {
            clearTabBarOverride();
            return;
        }
        setTabBarOverride([
            ...selectionActions,
            { icon: 'close-circle-outline', label: t('common.cancel'), onPress: exitSelection },
        ]);
        return () => clearTabBarOverride();
    }, [selectionMode, selectedListIds.size, selectionActions, setTabBarOverride, clearTabBarOverride, exitSelection, t]);

    // "Nepirkau čia" (2.0 mini-cycles): close the slot without a receipt;
    // reversible via unskip. Refreshes the list so the pill flips.
    const skipReceipt = useCallback(async (listIds: number[]) => {
        setUploadTarget(null);
        try {
            for (const id of listIds) {
                await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/skip-receipt`, { method: 'POST' });
            }
        } catch {}
        fetchLists();
    }, [fetchLists]);
    const unskipReceipt = useCallback(async (listIds: number[]) => {
        setUploadTarget(null);
        try {
            for (const id of listIds) {
                await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/unskip-receipt`, { method: 'POST' });
            }
        } catch {}
        fetchLists();
    }, [fetchLists]);

    // ── Receipt upload (post-completion "needs receipt" flow) ──────────────────
    // The target is a chainId→listId map; receipt-process auto-selects the
    // store row by the receipt's detected chain (no store-selection prompt).
    // Default: OS document scanner (native edge-detect + auto-capture + de-skew).
    const takeReceiptPhoto = useCallback((map: Record<number, number>) => {
        setUploadTarget(null);
        launchDocumentScanner(router, { listMap: mapToParam(map) });
    }, [router]);

    // Upload a single receipt file — image OR PDF, same as the Analyze tab.
    // PDFs are converted to PNG pages server-side, then handed to
    // receipt-process as a comma-separated `uris` list (multi-page).
    // iOS: presenting the document picker while the upload sheet is still
    // animating out fails SILENTLY (present-during-dismiss) — defer to the
    // Modal's onDismiss there; Android gets a short delay (no onDismiss).
    const pendingSheetActionRef = useRef<(() => void) | null>(null);
    const closeUploadSheetThen = useCallback((action: () => void) => {
        if (Platform.OS === 'ios') {
            pendingSheetActionRef.current = action;
            setUploadTarget(null);
        } else {
            setUploadTarget(null);
            setTimeout(action, 300);
        }
    }, []);

    const pickReceiptFile = useCallback((map: Record<number, number>) => {
        closeUploadSheetThen(() => void pickReceiptFileNow(map));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [closeUploadSheetThen]);

    const pickReceiptFileNow = async (map: Record<number, number>) => {
        const listMapStr = encodeURIComponent(mapToParam(map));
        const picked = await DocumentPicker.getDocumentAsync({
            type: ['image/*', 'application/pdf'],
            copyToCacheDirectory: true,
            multiple: false,
        });
        if (picked.canceled || !picked.assets?.length) return;
        const asset = picked.assets[0];
        const isPdf =
            asset.mimeType === 'application/pdf' ||
            (asset.name?.toLowerCase().endsWith('.pdf') ?? false);

        if (!isPdf) {
            router.push(`/receipt-process?uri=${encodeURIComponent(asset.uri)}&listMap=${listMapStr}` as any);
            return;
        }

        // PDF: hand the raw file to the scan session — page conversion runs as
        // its first background stage (loader shows "Converting PDF…"), no
        // blocking modal here.
        router.push(`/receipt-process?pdfUri=${encodeURIComponent(asset.uri)}&listMap=${listMapStr}` as any);
    };

    // ── FAB / chain picker ────────────────────────────────────────────────────
    const [fabMenuOpen, setFabMenuOpen] = useState(false);
    const [chainPickerOpen, setChainPickerOpen] = useState(false);
    const [chains, setChains] = useState<StoreChain[] | null>(null);
    const [chainsLoading, setChainsLoading] = useState(false);
    const [creatingChainId, setCreatingChainId] = useState<number | null>(null);

    const openChainPicker = async () => {
        setFabMenuOpen(false);
        setChainPickerOpen(true);
        if (chains) return;
        setChainsLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/chains`);
            const data = await res.json();
            setChains(Array.isArray(data) ? data : []);
        } catch {
            setChains([]);
        } finally {
            setChainsLoading(false);
        }
    };

    const createStandaloneList = async (chainId: number) => {
        if (creatingChainId) return;
        setCreatingChainId(chainId);
        try {
            const storesRes = await fetch(`${API_BASE_URL}/api/stores/chain/${chainId}`);
            const stores: Store[] = await storesRes.json();
            if (!Array.isArray(stores) || stores.length === 0) {
                Alert.alert(t('shoppingListTab.errors.generic'), t('shoppingListTab.errors.noStoreChoices'));
                return;
            }
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/shopping-lists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, storeId: stores[0].id }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (typeof data?.id !== 'number') throw new Error('Response missing id');
            setChainPickerOpen(false);
            router.push(`/shopping-list/${data.id}` as any);
        } catch {
            Alert.alert(t('shoppingListTab.errors.generic'), t('shoppingListTab.errors.createList'));
        } finally {
            setCreatingChainId(null);
        }
    };

    const openScanner = () => {
        setFabMenuOpen(false);
        router.push('/shopping-list/scan' as any);
    };

    // ── Derived data ──────────────────────────────────────────────────────────

    // Re-derive each group's lists from the LIVE `lists` state on every render.
    // loadSplitGroups captures list-object SNAPSHOTS at fetch time, so an
    // optimistic status change (long-press → Complete, delete) never reached
    // the group cards until the next refetch — the reported "marked completed,
    // nothing changed" bug.
    const liveGroups = useMemo<SplitGroup[]>(
        () => splitGroups
            .map(g => ({
                ...g,
                lists: g.entries
                    .map(e => lists.find(l => l.id === e.listId))
                    .filter((l): l is ShoppingList => l !== undefined),
            }))
            .filter(g => g.lists.length > 0),
        [splitGroups, lists],
    );

    const splitListIds = useMemo(
        () => new Set(liveGroups.flatMap(g => g.entries.map(e => e.listId))),
        [liveGroups],
    );
    const singleLists = useMemo(
        () => lists.filter(l => !splitListIds.has(l.id)),
        [lists, splitListIds],
    );

    const allChains = useMemo(() => {
        const map = new Map<string, string | null>();
        singleLists.forEach(l => { if (!map.has(l.chainName)) map.set(l.chainName, l.logoUrl); });
        liveGroups.forEach(g => g.entries.forEach(e => { if (!map.has(e.chainName)) map.set(e.chainName, e.chainLogoUrl); }));
        return Array.from(map.entries()).map(([name, logoUrl]) => ({
            id: name,
            label: chainBrandName(name),
            logoUrl: logoUrl ? getMiniLogoUrl(name, logoUrl) : null,
        }));
    }, [singleLists, liveGroups]);

    const filteredSingle = singleLists.filter(l => {
        if (chainFilter && l.chainName !== chainFilter) return false;
        return true;
    });
    const filteredGroups = liveGroups.filter(g => {
        if (chainFilter && !g.entries.some(e => e.chainName === chainFilter)) return false;
        return true;
    });

    const activeSingle = filteredSingle.filter(l => l.status === 'active');
    const completedSingle = filteredSingle.filter(l => l.status === 'completed');
    const activeGroups = filteredGroups.filter(g => g.lists.some(l => l.status === 'active') || g.lists.length === 0);
    const completedGroups = filteredGroups.filter(g => g.lists.length > 0 && g.lists.every(l => l.status === 'completed'));

    // Within completed, split by receipt state: lists still missing a receipt
    // stay visible (their own "Missing receipt" section); fully-receipted lists
    // drop into the collapsed "Completed" archive below.
    const missingSingle = completedSingle.filter(isAwaitingReceipt);
    const doneSingle = completedSingle.filter(l => !isAwaitingReceipt(l));
    const missingGroups = completedGroups.filter(g => g.lists.some(isAwaitingReceipt));
    const doneGroups = completedGroups.filter(g => !g.lists.some(isAwaitingReceipt));

    const hasAny = lists.length > 0 || liveGroups.length > 0;
    const hasActive = activeSingle.length > 0 || activeGroups.length > 0;
    const hasMissing = missingSingle.length > 0 || missingGroups.length > 0;
    const hasDone = doneSingle.length > 0 || doneGroups.length > 0;

    if (loading) return (
        <View style={styles.container}>
            <Stack.Screen options={glassHeaderOptions({ back: true })} />
            <ScreenHeading title={t('tabs.shoppingList')} />
            <View style={{ padding: spacing.lg }}>
                <SkeletonBox width={70} height={13} borderRadius={radius.sm} style={{ marginBottom: spacing.md }} />
                {Array.from({ length: 5 }).map((_, i) => (
                    <View key={i} style={{ backgroundColor: colors.cardBackground, borderRadius: radius.md, padding: spacing.lg, marginBottom: spacing.sm, gap: spacing.sm, borderWidth: 3, borderColor: 'transparent', borderLeftColor: colors.borderSubtle }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                            <SkeletonBox width={32} height={32} borderRadius={6} />
                            <View style={{ gap: 6, flex: 1 }}>
                                <SkeletonBox width={140} height={13} borderRadius={6} />
                                <SkeletonBox width={200} height={11} borderRadius={5} />
                            </View>
                        </View>
                        <SkeletonBox height={6} borderRadius={3} />
                    </View>
                ))}
            </View>
        </View>
    );

    return (
        <View style={styles.container}>
            <CollapsingHeader
                controller={header}
                back
                background={colors.cardBackground}
                collapsing={<ScreenHeading title={t('tabs.shoppingList')} />}
                pinned={allChains.length >= 2 ? (
                    <StoreChipBar
                        chips={allChains}
                        selectedId={chainFilter}
                        onSelect={id => setChainFilter(id as string | null)}
                        allLabel={t('shoppingListTab.filterAll')}
                    />
                ) : undefined}
            />

            <Animated.FlatList
                {...header.scroll}
                data={[]}
                keyExtractor={() => ''}
                renderItem={null}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={async () => { setRefreshing(true); await fetchLists(); setRefreshing(false); }}
                        colors={[colors.primary]}
                        tintColor={colors.primary}
                    />
                }
                ListHeaderComponent={
                    <>
                        {hasActive && (
                            <>
                                <Text style={styles.sectionTitle}>{t('shoppingListTab.sectionActive')}</Text>
                                {activeGroups.map(group => {
                                    const groupIds = group.lists.map(l => l.id);
                                    const groupSelected = groupIds.length > 0 && groupIds.every(id => selectedListIds.has(id));
                                    return (
                                        <SplitGroupCard
                                            key={group.basketId}
                                            group={group}
                                            onPress={() => {
                                                if (selectionMode) { toggleSelectGroup(groupIds); return; }
                                                const awaiting = group.lists.filter(isAwaitingReceipt);
                                                const firstId = group.entries[0]?.listId;
                                                if (awaiting.length > 0) {
                                                    setUploadViewRoute(firstId ? `/shopping-list/${firstId}?basketId=${group.basketId}` : null);
                                                    setUploadTarget(buildChainListMap(awaiting));
                                                    return;
                                                }
                                                if (firstId) router.push(`/shopping-list/${firstId}?basketId=${group.basketId}` as any);
                                            }}
                                            onLongPress={() => { setSelectionMode(true); toggleSelectGroup(groupIds); }}
                                            selectionMode={selectionMode}
                                            selected={groupSelected}
                                            styles={styles}
                                            colors={colors}
                                        />
                                    );
                                })}
                                {activeSingle.map(item => (
                                    <ShoppingListCard
                                        key={item.id}
                                        item={item}
                                        onPress={id => {
                                            if (selectionMode) { toggleSelectList(item.id); return; }
                                            if (isAwaitingReceipt(item)) {
                                                setUploadViewRoute(`/shopping-list/${item.id}`);
                                                setUploadTarget(buildChainListMap([item]));
                                                return;
                                            }
                                            router.push(`/shopping-list/${id}` as any);
                                        }}
                                        onLongPress={() => { setSelectionMode(true); toggleSelectList(item.id); }}
                                        selectionMode={selectionMode}
                                        selected={selectedListIds.has(item.id)}
                                        styles={styles}
                                        colors={colors}
                                    />
                                ))}
                            </>
                        )}
                        {hasMissing && (
                            <>
                                <Text style={styles.sectionTitle}>{t('shoppingListTab.sectionMissingReceipt')}</Text>
                                {missingGroups.map(group => {
                                    const groupIds = group.lists.map(l => l.id);
                                    const groupSelected = groupIds.length > 0 && groupIds.every(id => selectedListIds.has(id));
                                    return (
                                        <SplitGroupCard
                                            key={group.basketId}
                                            group={group}
                                            onPress={() => {
                                                if (selectionMode) { toggleSelectGroup(groupIds); return; }
                                                const awaiting = group.lists.filter(isAwaitingReceipt);
                                                const firstId = group.entries[0]?.listId;
                                                if (awaiting.length > 0) {
                                                    setUploadViewRoute(firstId ? `/shopping-list/${firstId}?basketId=${group.basketId}` : null);
                                                    setUploadTarget(buildChainListMap(awaiting));
                                                    return;
                                                }
                                                if (firstId) router.push(`/shopping-list/${firstId}?basketId=${group.basketId}` as any);
                                            }}
                                            onLongPress={() => { setSelectionMode(true); toggleSelectGroup(groupIds); }}
                                            selectionMode={selectionMode}
                                            selected={groupSelected}
                                            styles={styles}
                                            colors={colors}
                                        />
                                    );
                                })}
                                {missingSingle.map(item => (
                                    <ShoppingListCard
                                        key={item.id}
                                        item={item}
                                        onPress={id => {
                                            if (selectionMode) { toggleSelectList(item.id); return; }
                                            if (isAwaitingReceipt(item)) {
                                                setUploadViewRoute(`/shopping-list/${item.id}`);
                                                setUploadTarget(buildChainListMap([item]));
                                                return;
                                            }
                                            router.push(`/shopping-list/${id}` as any);
                                        }}
                                        onLongPress={() => { setSelectionMode(true); toggleSelectList(item.id); }}
                                        selectionMode={selectionMode}
                                        selected={selectedListIds.has(item.id)}
                                        styles={styles}
                                        colors={colors}
                                    />
                                ))}
                            </>
                        )}
                        {hasDone && (
                            <>
                                <TouchableOpacity
                                    style={styles.collapsibleHeader}
                                    activeOpacity={0.6}
                                    onPress={() => setCompletedCollapsed(c => !c)}
                                >
                                    <Text style={styles.sectionTitle}>{t('shoppingListTab.sectionCompleted')}</Text>
                                    <Ionicons
                                        name={completedCollapsed ? 'chevron-down' : 'chevron-up'}
                                        size={18}
                                        color={colors.textSecondary}
                                    />
                                </TouchableOpacity>
                                {!completedCollapsed && doneGroups.map(group => {
                                    const groupIds = group.lists.map(l => l.id);
                                    const groupSelected = groupIds.length > 0 && groupIds.every(id => selectedListIds.has(id));
                                    return (
                                        <SplitGroupCard
                                            key={group.basketId}
                                            group={group}
                                            onPress={() => {
                                                if (selectionMode) { toggleSelectGroup(groupIds); return; }
                                                const firstId = group.entries[0]?.listId;
                                                if (firstId) router.push(`/shopping-list/${firstId}?basketId=${group.basketId}` as any);
                                            }}
                                            onLongPress={() => { setSelectionMode(true); toggleSelectGroup(groupIds); }}
                                            selectionMode={selectionMode}
                                            selected={groupSelected}
                                            styles={styles}
                                            colors={colors}
                                        />
                                    );
                                })}
                                {!completedCollapsed && doneSingle.map(item => (
                                    <ShoppingListCard
                                        key={item.id}
                                        item={item}
                                        onPress={id => {
                                            if (selectionMode) { toggleSelectList(item.id); return; }
                                            router.push(`/shopping-list/${id}` as any);
                                        }}
                                        onLongPress={() => { setSelectionMode(true); toggleSelectList(item.id); }}
                                        selectionMode={selectionMode}
                                        selected={selectedListIds.has(item.id)}
                                        styles={styles}
                                        colors={colors}
                                    />
                                ))}
                            </>
                        )}
                        {!hasAny && (
                            <View style={styles.centered}>
                                <Ionicons name="list-outline" size={56} color={colors.textMuted} />
                                <Text style={styles.emptyText}>{t('shoppingListTab.empty')}</Text>
                                <Text style={styles.emptySubText}>{t('shoppingListTab.emptyBody')}</Text>
                                <TouchableOpacity style={styles.emptyButton} onPress={() => router.navigate('/(tabs)/basket' as any)}>
                                    <Text style={styles.emptyButtonText}>{t('shoppingListTab.emptyCta')}</Text>
                                </TouchableOpacity>
                            </View>
                        )}
                    </>
                }
                contentInsetAdjustmentBehavior="never"
                contentContainerStyle={[styles.list, { paddingTop: header.paddingTop + 12, paddingBottom: tabBarHeight + 24 }]}
            />

            {!selectionMode && (
                <TouchableOpacity
                    style={[styles.fab, { bottom: tabBarHeight + 16 }]}
                    onPress={() => setFabMenuOpen(true)}
                    activeOpacity={0.85}
                >
                    <Ionicons name="add" size={iconSize.xl} color={colors.onPrimary} />
                </TouchableOpacity>
            )}

            <Modal visible={fabMenuOpen} transparent animationType="fade" onRequestClose={() => setFabMenuOpen(false)}>
                <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setFabMenuOpen(false)}>
                    <View style={styles.fabMenu}>
                        <TouchableOpacity style={styles.fabMenuItem} onPress={openScanner}>
                            <Ionicons name="qr-code-outline" size={iconSize.lg} color={colors.textPrimary} />
                            <Text style={styles.fabMenuItemText}>{t('shoppingListTab.fabScanQr')}</Text>
                        </TouchableOpacity>
                        <View style={styles.fabMenuDivider} />
                        <TouchableOpacity style={styles.fabMenuItem} onPress={openChainPicker}>
                            <Ionicons name="add-circle-outline" size={iconSize.lg} color={colors.textPrimary} />
                            <Text style={styles.fabMenuItemText}>{t('shoppingListTab.fabCreate')}</Text>
                        </TouchableOpacity>
                    </View>
                </TouchableOpacity>
            </Modal>

            {/* iOS keeps the inline overlay bar (native tabs can't morph); on
                Android the floating pill tab bar itself becomes the action bar —
                see the tab-bar override effect above the return. */}
            {Platform.OS === 'ios' && selectionMode && selectedListIds.size > 0 && (
                <CardActionBar mode="inline" actions={selectionActions} onDismiss={exitSelection} />
            )}

            <Modal visible={chainPickerOpen} transparent animationType="slide" onRequestClose={() => setChainPickerOpen(false)}>
                <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => !creatingChainId && setChainPickerOpen(false)}>
                    <View style={styles.chainPickerSheet}>
                        <Text style={styles.sheetTitle}>{t('shoppingListTab.pickStoreTitle')}</Text>
                        {chainsLoading ? (
                            <MaterialProgress color={colors.primary} style={{ marginVertical: spacing.lg }} />
                        ) : (chains ?? []).length === 0 ? (
                            <Text style={styles.sheetEmpty}>{t('shoppingListTab.noStoresFound')}</Text>
                        ) : (
                            (chains ?? []).map(chain => (
                                <TouchableOpacity
                                    key={chain.id}
                                    style={styles.chainRow}
                                    onPress={() => createStandaloneList(chain.id)}
                                    disabled={creatingChainId !== null}
                                >
                                    <ChainLogoChip chainId={chain.id} name={chain.name} size={avatarSize.md} />
                                    <Text style={styles.chainName}>{chain.name}</Text>
                                    {creatingChainId === chain.id && <MaterialProgress size="small" color={colors.primary} />}
                                </TouchableOpacity>
                            ))
                        )}
                    </View>
                </TouchableOpacity>
            </Modal>

            {/* Receipt-upload chooser (completed list → "needs receipt"). */}
            <Modal
                visible={uploadTarget !== null}
                transparent
                animationType="slide"
                onRequestClose={() => setUploadTarget(null)}
                onDismiss={() => {
                    const action = pendingSheetActionRef.current;
                    pendingSheetActionRef.current = null;
                    action?.();
                }}
            >
                <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setUploadTarget(null)}>
                    <View style={styles.uploadSheet}>
                        <Text style={styles.sheetTitle}>{t('shoppingListTab.uploadReceiptTitle')}</Text>
                        <Text style={styles.uploadSheetSub}>{t('shoppingListTab.uploadReceiptBody')}</Text>
                        {uploadViewRoute && (
                            <>
                                <TouchableOpacity
                                    style={styles.uploadOption}
                                    onPress={() => {
                                        const route = uploadViewRoute;
                                        setUploadTarget(null);
                                        router.push(route as any);
                                    }}
                                >
                                    <Ionicons name="list-outline" size={iconSize.lg} color={colors.primary} />
                                    <Text style={styles.uploadOptionText}>{t('shoppingListTab.uploadViewList')}</Text>
                                </TouchableOpacity>
                                <View style={styles.fabMenuDivider} />
                            </>
                        )}
                        <TouchableOpacity
                            style={styles.uploadOption}
                            onPress={() => { if (uploadTarget) takeReceiptPhoto(uploadTarget); }}
                        >
                            <Ionicons name="camera-outline" size={iconSize.lg} color={colors.primary} />
                            <Text style={styles.uploadOptionText}>{t('shoppingListTab.uploadTakePhoto')}</Text>
                        </TouchableOpacity>
                        <View style={styles.fabMenuDivider} />
                        <TouchableOpacity
                            style={styles.uploadOption}
                            onPress={() => { if (uploadTarget) pickReceiptFile(uploadTarget); }}
                        >
                            <Ionicons name="cloud-upload-outline" size={iconSize.lg} color={colors.primary} />
                            <Text style={styles.uploadOptionText}>{t('receipts.menu.uploadAction')}</Text>
                        </TouchableOpacity>
                        {(() => {
                            // "Nepirkau čia": one row per still-awaiting slot in the
                            // sheet's target (chain-labelled when a split has several);
                            // skipped slots get the inverse ("vis dėlto turiu kvitą").
                            const targetIds = uploadTarget ? Object.values(uploadTarget).map(Number) : [];
                            const targetLists = lists.filter(l => targetIds.includes(l.id));
                            const awaiting = targetLists.filter(l => (Number(l.receiptCount) || 0) === 0 && (l as any).receiptSkippedAt == null);
                            const skipped = targetLists.filter(l => (l as any).receiptSkippedAt != null);
                            return (
                                <>
                                    {awaiting.map(l => (
                                        <View key={`skip-${l.id}`}>
                                            <View style={styles.fabMenuDivider} />
                                            <TouchableOpacity style={styles.uploadOption} onPress={() => skipReceipt([l.id])}>
                                                <Ionicons name="close-circle-outline" size={iconSize.lg} color={colors.textSecondary} />
                                                <Text style={[styles.uploadOptionText, { color: colors.textSecondary }]}>
                                                    {awaiting.length + skipped.length > 1
                                                        ? t('shoppingListTab.skipReceiptAt', { chain: l.chainName })
                                                        : t('shoppingListTab.skipReceipt')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                    ))}
                                    {skipped.map(l => (
                                        <View key={`unskip-${l.id}`}>
                                            <View style={styles.fabMenuDivider} />
                                            <TouchableOpacity style={styles.uploadOption} onPress={() => unskipReceipt([l.id])}>
                                                <Ionicons name="arrow-undo-outline" size={iconSize.lg} color={colors.primary} />
                                                <Text style={styles.uploadOptionText}>
                                                    {awaiting.length + skipped.length > 1
                                                        ? t('shoppingListTab.unskipReceiptAt', { chain: l.chainName })
                                                        : t('shoppingListTab.unskipReceipt')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                    ))}
                                </>
                            );
                        })()}
                        {unlinkedReceiptsForMap(uploadTarget).length > 0 && (
                            <>
                                <View style={styles.fabMenuDivider} />
                                <TouchableOpacity
                                    style={styles.uploadOption}
                                    onPress={() => {
                                        const m = uploadTarget;
                                        setUploadTarget(null);
                                        if (m) router.push(`/receipt-picker?map=${encodeURIComponent(mapToParam(m))}` as any);
                                    }}
                                >
                                    <Ionicons name="albums-outline" size={iconSize.lg} color={colors.primary} />
                                    <Text style={styles.uploadOptionText}>{t('shoppingListTab.uploadSelectExisting')}</Text>
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                </TouchableOpacity>
            </Modal>


            {/* PDF→image conversion in progress (matches the Analyze tab). */}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
    list: { padding: spacing.lg },
    sectionTitle: {
        ...typography.label, fontWeight: '700', color: c.textMuted,
        marginBottom: spacing.sm, marginTop: spacing.sm, textTransform: 'uppercase',
    },
    // Tappable section header for the collapsible "Completed" archive.
    collapsibleHeader: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    },

    // ── Multi-select circle (shown next to the logo in selection mode) ───────
    selectCircle: {
        width: 22, height: 22, borderRadius: radius.pill,
        borderWidth: 2, borderColor: c.border,
        alignItems: 'center', justifyContent: 'center',
        marginRight: spacing.sm, flexShrink: 0,
    },
    selectCircleChecked: { backgroundColor: c.primary, borderColor: c.primary },

    // ── Single-store card ─────────────────────────────────────────────────────
    card: {
        backgroundColor: c.cardBackground, borderRadius: radius.md, padding: spacing.lg, marginBottom: spacing.sm,
        flexDirection: 'row', alignItems: 'center',
        ...elevation.level1,
        borderWidth: 4, borderColor: 'transparent',
    },
    cardActive: { borderLeftColor: c.primary },
    cardCompleted: { borderLeftColor: c.textMuted },
    cardAwaiting: { borderLeftColor: c.warning },

    // ── Receipt status pill (completed cards) ─────────────────────────────────
    receiptPill: {
        flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
        marginTop: 6, paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill,
    },
    receiptPillNeeded: { backgroundColor: c.warningMuted },
    receiptPillDone: { backgroundColor: c.borderSubtle },
    receiptPillTextNeeded: { ...typography.caption, fontWeight: '700', color: c.warning },
    receiptPillTextDone: { ...typography.caption, fontWeight: '600', color: c.textMuted },
    cardLeft: { marginRight: spacing.md },
    cardContent: { flex: 1 },
    storeName: { ...typography.bodySmallStrong, color: c.textPrimary },
    date: { ...typography.labelSmall, fontWeight: '400', color: c.textMuted, marginTop: 2 },
    progressRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 6 },
    progressBar: { flex: 1, height: 4, backgroundColor: c.border, borderRadius: radius.pill, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: c.primary, borderRadius: radius.pill },
    progressText: { ...typography.caption, fontWeight: '400', color: c.textSecondary },
    badgeContainer: { marginLeft: spacing.sm },
    badge: {
        backgroundColor: c.primaryMuted, width: 28, height: 28, borderRadius: radius.pill,
        alignItems: 'center', justifyContent: 'center',
    },
    badgeCompleted: { backgroundColor: c.border },
    badgeText: { ...typography.labelSmall, fontWeight: '700', color: c.primary },
    badgeTextCompleted: { color: c.textMuted },
    // Tap-to-add-receipt cue (replaces the item count on awaiting cards).
    uploadCue: {
        width: 28, height: 28, borderRadius: radius.pill,
        backgroundColor: c.warning, alignItems: 'center', justifyContent: 'center',
    },

    // ── Multi-store split card ────────────────────────────────────────────────
    splitLogos: { flexDirection: 'row', alignItems: 'center' },
    splitLogoOverlap: { marginLeft: -spacing.sm },
    splitLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
    // ── Empty ─────────────────────────────────────────────────────────────────
    emptyText: { ...typography.bodyStrong, color: c.textSecondary, marginTop: spacing.lg, textAlign: 'center' },
    emptySubText: { ...typography.label, fontWeight: '400', color: c.textMuted, marginTop: 6, textAlign: 'center' },
    emptyButton: { marginTop: spacing.xl, backgroundColor: c.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.pill },
    emptyButtonText: { ...typography.bodySmallStrong, fontWeight: '700', color: c.onPrimary },

    // ── FAB ───────────────────────────────────────────────────────────────────
    fab: {
        position: 'absolute', right: spacing.xl, width: 56, height: 56, borderRadius: radius.pill,
        backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
        ...elevation.level3,
    },

    // ── Modals ────────────────────────────────────────────────────────────────
    modalBackdrop: { flex: 1, backgroundColor: c.overlayBackdrop, justifyContent: 'flex-end' },
    fabMenu: {
        backgroundColor: c.cardBackground, marginHorizontal: spacing.lg, marginBottom: 92,
        borderRadius: radius.md, paddingVertical: spacing.xs,
        ...elevation.level3,
    },
    fabMenuItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg, paddingHorizontal: spacing.lg },
    fabMenuItemText: { ...typography.bodyStrong, fontWeight: '500', color: c.textPrimary },
    fabMenuDivider: { height: 1, backgroundColor: c.borderSubtle, marginHorizontal: spacing.md },
    chainPickerSheet: {
        backgroundColor: c.cardBackground, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
        paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.xxl,
    },
    sheetTitle: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary, marginBottom: spacing.md },
    sheetEmpty: { ...typography.bodySmall, color: c.textMuted, textAlign: 'center', marginVertical: spacing.lg },
    chainRow: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingVertical: spacing.lg, borderBottomWidth: 1, borderBottomColor: c.borderSubtle,
    },
    chainName: { flex: 1, ...typography.bodyStrong, fontWeight: '500', color: c.textPrimary },

    // ── Receipt upload sheet ──────────────────────────────────────────────────
    uploadSheet: {
        backgroundColor: c.cardBackground, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
        paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.xxl,
    },
    uploadSheetSub: { ...typography.bodySmall, color: c.textMuted, marginBottom: spacing.md },
    uploadOption: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg,
    },
    uploadOptionText: { ...typography.bodyStrong, fontWeight: '500', color: c.textPrimary },
    existingRow: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: c.borderSubtle,
    },
    existingChain: { ...typography.bodySmallStrong, color: c.textPrimary },
    existingDate: { ...typography.labelSmall, fontWeight: '400', color: c.textMuted, marginTop: 2 },
    convertingBackdrop: { flex: 1, backgroundColor: c.overlayBackdrop, alignItems: 'center', justifyContent: 'center' },
    convertingCard: {
        backgroundColor: c.cardBackground, borderRadius: radius.md, padding: spacing.xl,
        alignItems: 'center', gap: spacing.md, ...elevation.level3,
    },
    convertingText: { ...typography.bodySmall, color: c.textSecondary },
});
