import {
    View,
    Text,
    StyleSheet,
    SectionList,
    ScrollView,
    TouchableOpacity,
    TextInput,
    Keyboard,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import Animated from 'react-native-reanimated';
import { useCollapsingHeader, CollapsingHeader } from '../../components/CollapsingHeader';
import { ScreenHeading } from '../../components/ScreenHeading';
import { GlassIconButton } from '../../components/GlassIconButton';
import { GlassSheet } from '../../components/GlassSheet';
import { SheetCloseButton } from '../../components/SheetCloseButton';
import { SwipeCompareCard } from '../../components/swipe/SwipeCompareCard';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, spacing, radius, elevation, type AppTheme } from '../../constants/theme';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { formatDate as formatLocalisedDate } from '../../utils/formatCurrency';

const BURST_DWELL_MS = 1000;
const PAGE_SIZE = 15;
const SEARCH_DEBOUNCE_MS = 300;

type VoteValue = 'identical' | 'similar' | 'different';
type Filter = 'all' | VoteValue;

const buildFilters = (t: TFunction): { key: Filter; label: string }[] => [
    { key: 'all',       label: t('voteHistory.filterAll') },
    { key: 'identical', label: t('voteHistory.filterIdentical') },
    { key: 'similar',   label: t('voteHistory.filterSimilar') },
    { key: 'different', label: t('voteHistory.filterDifferent') },
];

interface VoteRow {
    spIdA: number;
    spIdB: number;
    vote: VoteValue;
    dwellMs: number | null;
    updatedAt: string;
    nameA: string;
    chainNameA: string;
    nameB: string;
    chainNameB: string;
    // The history endpoint has always returned these (getVoteHistory selects
    // sp.imageUrl + sc.logoUrl for both sides); the screen simply never declared
    // them. They're what lets the sheet render the real swipe card.
    imageUrlA?: string | null;
    chainLogoUrlA?: string | null;
    imageUrlB?: string | null;
    chainLogoUrlB?: string | null;
}

interface VotePage {
    votes: VoteRow[];
    nextCursor: string | null;
}

const voteLabel = (vote: VoteValue, t: TFunction): string => {
    if (vote === 'identical') return t('voteHistory.voteIdentical');
    if (vote === 'similar') return t('voteHistory.voteSimilar');
    return t('voteHistory.voteDifferent');
};

const VOTE_ICONS: Record<VoteValue, keyof typeof Ionicons.glyphMap> = {
    identical: 'checkmark-circle',
    similar: 'git-compare-outline',
    different: 'close-circle',
};

function voteColor(vote: VoteValue, colors: AppTheme): string {
    if (vote === 'identical') return colors.success;
    if (vote === 'similar') return colors.info;
    return colors.error;
}

function formatDate(iso: string): string {
    return formatLocalisedDate(iso, { year: 'numeric', month: 'short', day: 'numeric' });
}

const AnimatedSectionList = Animated.createAnimatedComponent(SectionList as typeof SectionList<VoteRow>);

export default function VoteHistoryScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const FILTERS = useMemo(() => buildFilters(t), [t]);
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const header = useCollapsingHeader();

    const [showHelp, setShowHelp] = useState(false);
    const [votes, setVotes] = useState<VoteRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [cursor, setCursor] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [filter, setFilter] = useState<Filter>('all');
    const [search, setSearch] = useState('');
    const [editing, setEditing] = useState<VoteRow | null>(null);
    const [saving, setSaving] = useState(false);


    // Uncontrolled (defaultValue + ref) like the discounts search: the input
    // lives in the list header, and a controlled value would re-render it on
    // every keystroke.
    const searchInputRef = useRef<TextInput>(null);
    const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [debouncedSearch, setDebouncedSearch] = useState('');

    useEffect(() => {
        if (searchDebounce.current) clearTimeout(searchDebounce.current);
        searchDebounce.current = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
        return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
    }, [search]);

    const buildUrl = useCallback(async (cursorParam: string | null) => {
        const userId = await getUserId();
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (cursorParam) params.set('cursor', cursorParam);
        if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
        if (filter !== 'all') params.set('vote', filter);
        return `${API_BASE_URL}/api/users/${userId}/votes?${params}`;
    }, [debouncedSearch, filter]);

    const loadFirst = useCallback(async () => {
        setLoading(true);
        try {
            const url = await buildUrl(null);
            const res = await fetch(url);
            if (res.ok) {
                const page: VotePage = await res.json();
                setVotes(page.votes);
                setCursor(page.nextCursor);
                setHasMore(page.nextCursor !== null);
            }
        } catch {
            // keep previous data on network error
        } finally {
            setLoading(false);
        }
    }, [buildUrl]);

    const loadMore = useCallback(async () => {
        if (!hasMore || loadingMore || !cursor) return;
        setLoadingMore(true);
        try {
            const url = await buildUrl(cursor);
            const res = await fetch(url);
            if (res.ok) {
                const page: VotePage = await res.json();
                setVotes(prev => [...prev, ...page.votes]);
                setCursor(page.nextCursor);
                setHasMore(page.nextCursor !== null);
            }
        } catch {
            // silently keep what we have
        } finally {
            setLoadingMore(false);
        }
    }, [hasMore, loadingMore, cursor, buildUrl]);

    // Reset + reload whenever search or filter changes
    useEffect(() => {
        loadFirst();
    }, [loadFirst]);

    // Reload on tab focus (catches edits made elsewhere)
    useFocusEffect(useCallback(() => {
        loadFirst();
    }, [loadFirst]));

    const submitEdit = async (newVote: VoteValue) => {
        if (!editing || saving) return;
        setSaving(true);
        try {
            const userId = await getUserId();
            await fetch(`${API_BASE_URL}/api/users/${userId}/votes/pair`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ spIdA: editing.spIdA, spIdB: editing.spIdB, vote: newVote }),
            });
            setVotes(prev => prev.map(v =>
                v.spIdA === editing.spIdA && v.spIdB === editing.spIdB
                    ? { ...v, vote: newVote }
                    : v
            ));
            setEditing(null);
        } catch {
            // leave modal open so user can retry
        } finally {
            setSaving(false);
        }
    };

    const renderItem = ({ item }: { item: VoteRow }) => {
        const isBurst = item.dwellMs !== null && item.dwellMs < BURST_DWELL_MS;
        const color = voteColor(item.vote, colors);
        return (
            <TouchableOpacity style={styles.card} onPress={() => setEditing(item)} activeOpacity={0.7}>
                <View style={styles.cardBody}>
                    <View style={styles.pairRow}>
                        <Text style={styles.spName} numberOfLines={1}>{item.nameA}</Text>
                        <Text style={styles.chainTag}>{item.chainNameA}</Text>
                    </View>
                    <View style={styles.dividerRow}>
                        <Ionicons name={VOTE_ICONS[item.vote]} size={16} color={color} />
                        <Text style={[styles.voteLabel, { color }]}>{voteLabel(item.vote, t)}</Text>
                        {isBurst && (
                            <Ionicons name="warning-outline" size={14} color={colors.warning} style={{ marginLeft: 4 }} />
                        )}
                    </View>
                    <View style={styles.pairRow}>
                        <Text style={styles.spName} numberOfLines={1}>{item.nameB}</Text>
                        <Text style={styles.chainTag}>{item.chainNameB}</Text>
                    </View>
                </View>

                <View style={styles.cardMeta}>
                    <Text style={styles.dateText}>{formatDate(item.updatedAt)}</Text>
                    <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                </View>
            </TouchableOpacity>
        );
    };

    const clearSearch = useCallback(() => {
        setSearch('');
        searchInputRef.current?.clear();
    }, []);

    // Title + search pill + filter chips — the same search pill the discounts /
    // catalog lists use, so every searchable list looks like one family.
    const listHeader = (
        <>
            <ScreenHeading title={t('screens.voteHistory')} onLayout={header.onTitleLayout} />
            <View style={styles.searchFieldWrap}>
                <View style={styles.searchPill}>
                    <Ionicons name="search" size={18} color={colors.textMuted} />
                    <TextInput
                        ref={searchInputRef}
                        defaultValue={search}
                        onChangeText={setSearch}
                        placeholder={t('voteHistory.searchPlaceholder')}
                        placeholderTextColor={colors.textMuted}
                        returnKeyType="search"
                        onSubmitEditing={() => Keyboard.dismiss()}
                        style={styles.searchField}
                    />
                    {search.length > 0 ? (
                        <TouchableOpacity onPress={clearSearch} hitSlop={10}>
                            <Ionicons name="close" size={18} color={colors.textMuted} />
                        </TouchableOpacity>
                    ) : null}
                </View>
            </View>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.bubblesRow}
                contentContainerStyle={styles.bubblesContainer}
                keyboardShouldPersistTaps="handled"
            >
                {FILTERS.map(f => (
                    <TouchableOpacity
                        key={f.key}
                        style={[styles.bubble, filter === f.key && styles.bubbleActive]}
                        onPress={() => setFilter(f.key)}
                    >
                        <Text style={[styles.bubbleText, filter === f.key && styles.bubbleTextActive]}>
                            {f.label}
                        </Text>
                    </TouchableOpacity>
                ))}
            </ScrollView>
        </>
    );

    const listFooter = loadingMore ? (
        <MaterialProgress color={colors.primary} style={{ marginVertical: 16 }} />
    ) : null;

    return (
        <View style={styles.container}>
            <CollapsingHeader
                controller={header}
                back
                smallTitle={t('screens.voteHistory')}
                right={
                    <GlassIconButton
                        icon="help-circle-outline"
                        size={24}
                        color={colors.textSecondary}
                        onPress={() => setShowHelp(true)}
                    />
                }
            />

            {loading ? (
                <MaterialProgress color={colors.primary} style={{ marginTop: 48 }} />
            ) : (
                <AnimatedSectionList
                    {...header.scroll}
                    // Screen order, top to bottom: big title (scrolls away under
                    // the bar) → search → filter chips → rows. All of it rides in
                    // the list header, so the chips can never sit ABOVE the title
                    // the way they did when they were pinned outside the list.
                    // ELEMENT, not a function component: a new component type each
                    // render would remount the search input and drop its focus.
                    ListHeaderComponent={listHeader}
                    sections={[{ data: votes }]}
                    keyExtractor={(v: any) => `${v.spIdA}-${v.spIdB}`}
                    renderItem={renderItem}
                    contentContainerStyle={[styles.list, { paddingTop: 0 }]}
                    keyboardDismissMode="on-drag"
                    keyboardShouldPersistTaps="handled"
                    onEndReached={loadMore}
                    onEndReachedThreshold={0.3}
                    ListEmptyComponent={
                        <View style={styles.empty}>
                            <Ionicons name="layers-outline" size={48} color={colors.textMuted} />
                            <Text style={styles.emptyText}>
                                {debouncedSearch || filter !== 'all' ? t('voteHistory.emptyFiltered') : t('voteHistory.emptyNone')}
                            </Text>
                        </View>
                    }
                    ListFooterComponent={listFooter}
                />
            )}

            {/* Help — the app's glass sheet (blur, grabber, drag/backdrop/back
                dismiss), with the X in the title row instead of a full-width
                close button. */}
            {showHelp && (
                <GlassSheet autoHeight onClose={() => setShowHelp(false)}>
                    {/* GlassSheet's scroll is edge-to-edge — content owns its padding. */}
                    <View style={styles.sheetBody}>
                    <View style={styles.sheetTitleRow}>
                        <View style={styles.helpIconBadge}>
                            <Ionicons name="layers-outline" size={22} color={colors.primary} />
                        </View>
                        <Text style={styles.sheetTitle}>{t('voteHistory.helpTitle')}</Text>
                        <SheetCloseButton />
                    </View>
                    <Text style={styles.helpText}>{t('voteHistory.helpBody1')}</Text>
                    <Text style={styles.helpText}>{t('voteHistory.helpBody2')}</Text>
                    <Text style={styles.helpText}>{t('voteHistory.helpBody3')}</Text>
                    </View>
                </GlassSheet>
            )}

            {/* Re-vote — same glass sheet, so the screen doesn't mix two sheet
                looks. Picking an option saves and closes; X / backdrop cancels. */}
            {editing !== null && (
                // Opens tall (not autoHeight): the pair card is the point of this
                // sheet, so it gets the room the swipe queue gives it.
                <GlassSheet mediumFraction={0.88} onClose={() => { if (!saving) setEditing(null); }}>
                    <View style={styles.sheetBody}>
                    <View style={styles.sheetTitleRow}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.sheetTitle}>{t('voteHistory.editTitle')}</Text>
                        </View>
                        <SheetCloseButton />
                    </View>
                    {/* THE swipe-queue card, same component — minus the swipe
                        gestures and the action bar. The current vote is shown as
                        the selected option below and can be changed there. */}
                    {editing && (
                        <SwipeCompareCard
                            style={styles.pairCard}
                            left={{
                                name: editing.nameA,
                                chainName: editing.chainNameA,
                                chainLogoUrl: editing.chainLogoUrlA,
                                imageUrl: editing.imageUrlA,
                            }}
                            right={{
                                name: editing.nameB,
                                chainName: editing.chainNameB,
                                chainLogoUrl: editing.chainLogoUrlB,
                                imageUrl: editing.imageUrlB,
                            }}
                        />
                    )}
                    {saving ? (
                        <MaterialProgress color={colors.primary} style={{ marginVertical: 24 }} />
                    ) : (
                        <View style={styles.optionList}>
                            {(['identical', 'similar', 'different'] as VoteValue[]).map(v => {
                                const active = editing?.vote === v;
                                const color = voteColor(v, colors);
                                return (
                                    <TouchableOpacity
                                        key={v}
                                        style={[styles.option, active && { borderColor: color, backgroundColor: color + '18' }]}
                                        onPress={() => submitEdit(v)}
                                    >
                                        <Ionicons name={VOTE_ICONS[v]} size={20} color={color} />
                                        <Text style={[styles.optionLabel, active && { color }]}>
                                            {voteLabel(v, t)}
                                        </Text>
                                        {active && <Ionicons name="checkmark" size={18} color={color} />}
                                    </TouchableOpacity>
                                );
                            })}
                        </View>
                    )}
                    </View>
                </GlassSheet>
            )}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    list: { padding: 16, gap: 10 },

    // Same search pill as the discounts / catalog lists.
    searchFieldWrap: { paddingTop: 2, paddingBottom: 8 },
    searchPill: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        backgroundColor: c.cardBackground,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
        borderRadius: radius.pill,
        paddingHorizontal: 14, height: 44,
        elevation: 2,
    },
    searchField: { flex: 1, fontSize: 15, color: c.textPrimary, paddingVertical: 0 },

    card: {
        backgroundColor: c.cardBackground,
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderWidth: 1,
        borderColor: c.borderSubtle,
    },
    cardBody: { flex: 1, gap: 4 },
    pairRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    spName: { flex: 1, fontSize: 14, fontWeight: '500', color: c.textPrimary },
    chainTag: { fontSize: 11, color: c.textMuted, backgroundColor: c.surfaceMuted, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
    dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginVertical: 2 },
    voteLabel: { fontSize: 12, fontWeight: '600' },

    cardMeta: { alignItems: 'flex-end', gap: 4 },
    dateText: { fontSize: 12, color: c.textMuted },

    bubblesRow: { flexGrow: 0, flexShrink: 0, marginHorizontal: -16 },
    bubblesContainer: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
    bubble: {
        paddingHorizontal: 16, paddingVertical: 8,
        borderRadius: radius.pill, borderWidth: 1,
        borderColor: c.border, backgroundColor: c.cardBackground,
    },
    bubbleActive: { backgroundColor: c.primary, borderColor: c.primary, ...elevation.level1 },
    bubbleText: { fontSize: 13, color: c.textPrimary },
    bubbleTextActive: { color: c.onPrimary, fontWeight: '600' },

    empty: { alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 48 },
    emptyText: { fontSize: 15, color: c.textMuted },

    // Sheet chrome (backdrop, panel, corners) belongs to GlassSheet now — what
    // remains here is only the CONTENT of those sheets.
    sheetBody: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
    sheetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
    sheetTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: c.textPrimary },
    pairCard: { alignSelf: 'center', marginBottom: spacing.lg },
    optionList: { gap: 10 },
    option: {
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingVertical: 14, paddingHorizontal: 16,
        borderRadius: 10, borderWidth: 1.5, borderColor: c.borderSubtle,
    },
    optionLabel: { flex: 1, fontSize: 15, fontWeight: '500', color: c.textPrimary },
    helpIconBadge: {
        width: 40, height: 40, borderRadius: radius.pill,
        backgroundColor: c.primaryMuted, alignItems: 'center', justifyContent: 'center',
    },
    helpText: { fontSize: 14, color: c.textSecondary, lineHeight: 21, marginBottom: 10 },
});
