import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { withTiming, Easing } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import CalendarBadge from './CalendarBadge';
import { ChainLogoChip } from './ChainLogoChip';
import { UserAvatar } from './UserAvatar';
import { formatWeekday } from '../utils/formatDayDate';
import { useTheme, radius, type AppTheme } from '../constants/theme';
import type { TripSummary } from '../utils/tripsApi';

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

/** Card removal: a clean, quick fade + slight shrink — no overshoot. */
export function tripCardExit() {
    'worklet';
    return {
        initialValues: { opacity: 1, transform: [{ scale: 1 }] },
        animations: {
            opacity: withTiming(0, { duration: 200, easing: Easing.in(Easing.quad) }),
            transform: [{ scale: withTiming(0.94, { duration: 200, easing: Easing.in(Easing.quad) }) }],
        },
    };
}

/** Overlapping member-avatar circles for a shared card (up to 3 + "+N"). */
function MemberStack({ members, total, styles }: {
    members: { initial: string; color: string | null }[];
    total: number;
    styles: ReturnType<typeof makeStyles>;
}) {
    const shown = members.slice(0, 3);
    const extra = total - shown.length;
    return (
        <View style={styles.memberStack}>
            {shown.map((m, i) => (
                <View key={i} style={i > 0 ? styles.memberOverlap : undefined}>
                    <UserAvatar name={m.initial} color={m.color} size={22} style={styles.memberRing} />
                </View>
            ))}
            {extra > 0 && (
                <View style={[styles.memberOverlap, styles.memberMore]}>
                    <Text style={styles.memberMoreText}>+{extra}</Text>
                </View>
            )}
        </View>
    );
}

/**
 * THE trip card — extracted from the Shopping screen's `case 'trip'` renderer
 * so the family History tab renders the SAME component instead of a clone
 * (that duplication has bitten this codebase repeatedly). The host keeps what
 * is host state: section outlines, "new" detection, the CTA label and where a
 * tap goes. The card keeps what is trip-derived: calendar column, count chip,
 * chain logos, member stack, title and item preview.
 */
export function TripCard({ trip, ctaLabel, onPress, isNew = false, statusLine, style }: {
    trip: TripSummary;
    /** CTA text (host-owned: stage CTA on Shopping, "Statistika" in family
     *  history). null hides the CTA entirely (the family PENDING card). */
    ctaLabel: string | null;
    onPress: () => void;
    /** Pink "New" treatment (Shopping's unopened-receipt watermark). */
    isNew?: boolean;
    /** Replaces the preview/slot line ("John apsiperka…" on a pending family
     *  trip) — a status the trip data itself doesn't carry. */
    statusLine?: string | null;
    style?: StyleProp<ViewStyle>;
}) {
    const colors = useTheme();
    const { t, i18n } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const hasReceipt = trip.receiptCount > 0;
    // Once the trip has LISTS, they are the source of truth for the card's
    // count + preview: the basket is consumed into the lists, so its own
    // itemCount/itemPreview go stale.
    const listItems = trip.slots.reduce((n, s) => n + (s.itemCount ?? 0), 0);
    const listPreview = trip.slots.flatMap(s => s.itemPreview ?? []);
    const preview = trip.slots.length > 0 ? listPreview : (trip.basket?.itemPreview ?? []);
    const plannedCount = trip.slots.length > 0 ? listItems : (trip.basket?.itemCount ?? 0);
    const chains = trip.chains ?? [];
    const shownChains = chains.slice(0, 4);
    const chainOverflow = chains.length - shownChains.length;

    // A custom name (trip or basket rename) or the ad-hoc label wins; otherwise
    // the title is AUTO — the full weekday (the calendar badge shows the date).
    const title = trip.name ?? trip.basket?.name ?? (trip.isAdHoc ? t('trips.adHocName') : null)
        ?? formatWeekday(trip.anchorDate, i18n.language);

    const slotLine = (() => {
        if (trip.slots.length === 0) {
            return trip.basket ? t('trips.itemCount', { count: trip.basket.itemCount }) : null;
        }
        return trip.slots.map(s => {
            const name = s.chainName ?? s.storeName ?? '?';
            if (trip.stage === 3) return `${name} ${s.checkedCount}/${s.itemCount}`;
            if (trip.stage >= 4) return s.hasReceipt ? `${name} ✓` : s.receiptSkipped ? `${name} —` : name;
            return name;
        }).join(' · ');
    })();

    return (
        <AnimatedTouchable
            style={[styles.card, isNew && styles.cardNew, style]}
            onPress={onPress}
            activeOpacity={0.8}
            exiting={tripCardExit}
        >
            <View style={styles.cardMain}>
                {/* Date column: every row (count/logos, title, preview) sits to
                    its RIGHT, so the calendar reads as the card's anchor rather
                    than a chip glued to the title. */}
                <View style={styles.calCol}>
                    <CalendarBadge date={trip.anchorDate} size={60} />
                </View>
                <View style={styles.cardBody}>
                    <View style={styles.cardTop}>
                        <View style={styles.cardTopLeft}>
                            {/* Uploaded receipt → receipt icon + recognised line
                                count; otherwise the planned shopping-list count. */}
                            <View style={styles.cartChip}>
                                <Ionicons name={hasReceipt ? 'receipt-outline' : 'cart-outline'} size={14} color={colors.primary} />
                                <Text style={styles.cartChipText}>{hasReceipt ? trip.recognisedItemCount : plannedCount}</Text>
                            </View>
                            {/* Chain logos: receipt chains full colour, planned-only dimmed. */}
                            {shownChains.length > 0 && (
                                <View style={styles.logoStrip}>
                                    {shownChains.map(c => (
                                        <ChainLogoChip key={c.chainId} chainId={c.chainId} name={c.chainName ?? undefined} size={22} dimmed={!c.hasReceipt} style={styles.logoChip} />
                                    ))}
                                    {chainOverflow > 0 && <Text style={styles.logoMore}>+{chainOverflow}</Text>}
                                </View>
                            )}
                        </View>
                        <View style={styles.cardTopRight}>
                            {isNew && (
                                <View style={styles.newBadge}><Text style={styles.newBadgeText}>{t('trips.newBadge')}</Text></View>
                            )}
                            {trip.memberCount > 1 && (
                                <MemberStack members={trip.members ?? []} total={trip.memberCount} styles={styles} />
                            )}
                        </View>
                    </View>
                    <Text style={styles.cardTitle} numberOfLines={1}>{title}</Text>
                    {statusLine ? (
                        <Text style={styles.statusLine} numberOfLines={1}>{statusLine}</Text>
                    ) : preview.length > 0 ? (
                        // Newest items first — each name caps and ellipsises so 3+ fit.
                        <View style={styles.previewRow}>
                            {preview.slice(0, 3).map((name, i) => (
                                <React.Fragment key={i}>
                                    {i > 0 && <Text style={styles.previewDot}>·</Text>}
                                    <Text style={styles.previewName} numberOfLines={1}>{name}</Text>
                                </React.Fragment>
                            ))}
                        </View>
                    ) : slotLine ? (
                        <Text style={styles.cardMeta} numberOfLines={1}>{slotLine}</Text>
                    ) : null}
                </View>
                {ctaLabel != null && (
                    <View style={styles.ctaBtn}>
                        <Text style={styles.ctaText}>{ctaLabel}</Text>
                        <Ionicons name="chevron-forward" size={16} color={colors.primary} />
                    </View>
                )}
            </View>
        </AnimatedTouchable>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    card: {
        backgroundColor: c.cardBackground, borderRadius: radius.lg, padding: 14, marginBottom: 10,
        marginHorizontal: 16,
        borderWidth: 3, borderColor: 'transparent', borderLeftColor: c.primary,
        gap: 6,
    },
    // New (unopened receipt) card: pink-tinted fill + full pink border.
    cardNew: { backgroundColor: c.primaryMuted ?? c.surfaceMuted, borderColor: c.primary },
    // `stretch` gives the date column the full content height to centre within.
    cardMain: { flexDirection: 'row', alignItems: 'stretch', gap: 10 },
    calCol: { justifyContent: 'center' },
    cardBody: { flex: 1, minWidth: 0, gap: 4 },
    cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 },
    cardTopLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0 },
    cardTopRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    cartChip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted, borderRadius: radius.pill,
        paddingHorizontal: 10, paddingVertical: 4,
    },
    cartChipText: { fontSize: 13, fontWeight: '800', color: c.primary },
    logoStrip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    logoChip: {},
    logoMore: { fontSize: 11, fontWeight: '800', color: c.textMuted, marginLeft: 2 },
    newBadge: { backgroundColor: c.primary, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
    newBadgeText: { fontSize: 10, fontWeight: '900', color: c.onPrimary, letterSpacing: 0.3 },
    cardTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary, flexShrink: 1 },
    cardMeta: { fontSize: 13, color: c.textSecondary, marginTop: 3 },
    // Host-provided status ("John apsiperka…") — pink to read as live state.
    statusLine: { fontSize: 13, fontWeight: '600', color: c.primary, marginTop: 3 },
    previewRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    previewName: { flexShrink: 1, fontSize: 12, color: c.textSecondary, maxWidth: '38%' },
    previewDot: { fontSize: 12, color: c.textMuted },
    // alignSelf keeps the CTA vertically centred now that the row stretches.
    ctaBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 2, paddingLeft: 4 },
    ctaText: { fontSize: 13, fontWeight: '700', color: c.primary },
    // Overlapping member avatars — top-right of a shared card.
    memberStack: { flexDirection: 'row', alignItems: 'center' },
    memberOverlap: { marginLeft: -8 },
    memberRing: { borderWidth: 1.5, borderColor: c.cardBackground },
    memberMore: {
        width: 22, height: 22, borderRadius: 11, backgroundColor: c.surfaceMuted,
        borderWidth: 1.5, borderColor: c.cardBackground, alignItems: 'center', justifyContent: 'center',
    },
    memberMoreText: { fontSize: 10, fontWeight: '800', color: c.textSecondary },
});
