import { useEffect, useMemo, useState } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    ScrollView,
    SectionList,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, spacing, radius, iconSize, avatarSize, typography, type AppTheme } from '../constants/theme';
import { useCollapsingHeader, CollapsingHeader } from '../components/CollapsingHeader';
import { ScreenHeading } from '../components/ScreenHeading';
import { DateFilterButton } from '../components/DateFilterButton';
import { ChainLogoChip } from '../components/ChainLogoChip';
import { chainBrandName, chainIdByName } from '../utils/chainBrandName';
import { formatDate } from '../utils/formatCurrency';
import { buildReceiptDotMap, parseLooseDate, sameDay } from '../utils/receiptDots';
import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';

interface PickableReceipt {
    id: number;
    chainName: string;
    receiptDate?: string | null;
    receiptNo?: string | null;
    shoppingListId?: number | null;
    processingStatus?: string | null;
}

/**
 * "Pick an uploaded receipt" for a completed shopping list — a real ROUTE so
 * the header is the SAME stack as the Analyze tab: titleless glass bar (with
 * the native back chevron), ScreenHeading title on its own line, and the
 * pinned filter row directly beneath (no separator) with the shared
 * DateFilterButton. No store filter — `map` ("chainId:listId,…") already
 * chain-scopes the candidates; picking links the receipt to the matching
 * store row and pops back (the list tab refetches on focus).
 */
const AnimatedSectionList = Animated.createAnimatedComponent(SectionList as typeof SectionList<PickableReceipt>);

export default function ReceiptPickerScreen() {
    const colors = useTheme();
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const header = useCollapsingHeader();
    const { map: mapParam } = useLocalSearchParams<{ map?: string }>();

    // chainId → listId of the target list/group's awaiting store rows.
    const linkMap = useMemo<Record<number, number>>(() => {
        const m: Record<number, number> = {};
        for (const pair of (mapParam ?? '').split(',')) {
            const [c, l] = pair.split(':').map(Number);
            if (Number.isFinite(c) && Number.isFinite(l)) m[c] = l;
        }
        return m;
    }, [mapParam]);

    const [receipts, setReceipts] = useState<PickableReceipt[]>([]);
    const [selectedDate, setSelectedDate] = useState<Date | null>(null);
    const [linking, setLinking] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const userId = await getUserId();
                const res = await fetch(`${API_BASE_URL}/api/users/${userId}/receipts`);
                const data = await res.json();
                const rows: PickableReceipt[] = Array.isArray(data) ? data : [];
                const chains = Object.keys(linkMap).map(Number);
                // Unlinked, non-failed, chain matching one of the awaiting stores —
                // a Lidl receipt can't attach to a Maxima list.
                setReceipts(rows.filter(r =>
                    r.shoppingListId == null &&
                    r.processingStatus !== 'failed' &&
                    chains.includes(chainIdByName(r.chainName) ?? -1),
                ));
            } catch { /* keep empty list */ }
        })();
    }, [linkMap]);

    const receiptDots = useMemo(
        () => buildReceiptDotMap(receipts.map(r => ({ date: parseLooseDate(r.receiptDate), chainName: r.chainName }))),
        [receipts],
    );

    const filtered = useMemo(() => {
        if (!selectedDate) return receipts;
        return receipts.filter(r => {
            const d = parseLooseDate(r.receiptDate);
            return d ? sameDay(d, selectedDate) : false;
        });
    }, [receipts, selectedDate]);

    const pick = async (r: PickableReceipt) => {
        if (linking) return;
        const listId = linkMap[chainIdByName(r.chainName) ?? -1];
        if (!listId) return;
        setLinking(true);
        try {
            await fetch(`${API_BASE_URL}/api/shopping-lists/${listId}/link-receipt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ receiptId: r.id }),
            });
        } catch { /* best-effort — the list tab refetches on focus either way */ }
        router.back();
    };

    return (
        <View style={styles.container}>
            <CollapsingHeader controller={header} back smallTitle={t('shoppingListTab.selectExistingTitle')} />
            <AnimatedSectionList
                {...header.scroll}
                ListHeaderComponent={<ScreenHeading title={t('shoppingListTab.selectExistingTitle')} onLayout={header.onTitleLayout} />}
                sections={[{ data: filtered }]}
                keyExtractor={(r: PickableReceipt) => `pick-${r.id}`}
                stickySectionHeadersEnabled
                renderSectionHeader={() => (
                    <View style={{ backgroundColor: colors.pageBackground, marginHorizontal: -spacing.lg }}>
                        <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            keyboardShouldPersistTaps="handled"
                            contentContainerStyle={styles.filterRow}
                        >
                            <DateFilterButton
                                value={selectedDate}
                                onChange={setSelectedDate}
                                label={t('receipts.filterDate')}
                                markedDates={receiptDots}
                            />
                        </ScrollView>
                    </View>
                )}
                contentInsetAdjustmentBehavior="never"
                contentContainerStyle={[styles.list, { paddingTop: 0, paddingBottom: insets.bottom + 24 }]}
                ListEmptyComponent={
                    <View style={styles.empty}>
                        <Ionicons name="receipt-outline" size={44} color={colors.textMuted} />
                        <Text style={styles.emptyText}>{t('shoppingListTab.selectExistingEmpty')}</Text>
                    </View>
                }
                renderItem={({ item }: { item: PickableReceipt }) => (
                    <TouchableOpacity style={styles.row} onPress={() => pick(item)} activeOpacity={0.75} disabled={linking}>
                        <ChainLogoChip chainId={chainIdByName(item.chainName) ?? 0} name={item.chainName} size={avatarSize.md} />
                        <View style={{ flex: 1 }}>
                            <Text style={styles.rowChain} numberOfLines={1}>{chainBrandName(item.chainName)}</Text>
                            <Text style={styles.rowSub} numberOfLines={1}>
                                {[item.receiptDate ? formatDate(item.receiptDate) : null, item.receiptNo || null]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={iconSize.sm} color={colors.textMuted} />
                    </TouchableOpacity>
                )}
            />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    // Same geometry as the Analyze tab's filter row — no separator borders;
    // the CollapsingHeader band carries the shared card background.
    filterRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: 10,
    },
    list: { padding: spacing.lg },
    row: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        backgroundColor: c.cardBackground, borderRadius: radius.lg,
        padding: spacing.lg, marginBottom: spacing.md,
    },
    rowChain: { ...typography.bodyStrong, color: c.textPrimary },
    rowSub: { ...typography.caption, color: c.textSecondary, marginTop: 1 },
    empty: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.xxxl },
    emptyText: { ...typography.body, color: c.textMuted, textAlign: 'center' },
});
