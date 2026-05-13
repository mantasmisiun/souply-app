import React, { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme, type AppTheme } from '../../constants/theme';
import { formatEuro } from '../../utils/formatCurrency';

/**
 * Spec C3 — per-category spending breakdown.
 *
 * Renders a stacked horizontal bar over a ranked list of categories so
 * the user sees BOTH "how my money split across food groups" (the bar)
 * and the actual euro amounts per category (the list). Unmatched
 * products live in a separate `Neatpažinta` row — informative quality
 * signal, not folded into "Kita".
 *
 * Data wiring: prefers `altMatches[0].categoryL2Name` (mid-level,
 * matches Profilis statsService.categoryBreakdown labels) and falls
 * back to the leaf `categoryName` for receipts the server hasn't yet
 * rehydrated. The server's match endpoint joins L1/L2/L3 via CASE
 * (storeProductModel), and `hydrateReceiptCategoriesIfNeeded`
 * backfills both fields onto pre-redesign receipts on first re-open,
 * so legacy data converges to L2 as the user revisits old receipts.
 */

export interface BreakdownProduct {
    /** Whether the product was confidently matched to a StoreProduct. */
    matchConfirmed: boolean;
    /** Server returns categoryName (leaf) and categoryL2Name (the L2
     *  ancestor) on altMatches[0] when matched. L2 is the display
     *  source of truth; leaf is the fallback for not-yet-rehydrated
     *  legacy receipts. */
    altMatches: Array<{
        categoryName?: string | null;
        categoryL2Name?: string | null;
    }>;
    price: number;
    promoPrice: number | null;
    quantity: number;
}

interface Props {
    products: BreakdownProduct[];
    /** Current receipt id — used by the Nepriskirta explainer's
     *  "Pagerinti atpažinimą" pink button to open the voluntary
     *  swipe queue scoped to this receipt's own orphans. When the
     *  receipt isn't persisted yet (mid-upload), the prop is null
     *  and the button falls back to the global queue. */
    receiptId?: number | null;
}

interface Bucket {
    key: string;          // categoryName or sentinel "__UNRECOGNISED__" / "__OTHER__"
    label: string;        // display name (e.g. "Pieno produktai", "Kita", "Neatpažinta")
    total: number;
    isUnrecognised?: boolean;
    isOther?: boolean;
}

const UNRECOGNISED_KEY = '__UNRECOGNISED__';
const OTHER_KEY = '__OTHER__';
const TOP_N = 4;

// Deterministic per-category palette: hash the name into a small set of
// well-spaced hues so the same category always renders in the same
// colour across receipts (familiarity beats novelty for at-a-glance
// recognition).
const BUCKET_COLOURS = [
    '#5EA29A', // teal
    '#EB6784', // beet
    '#F7B86E', // amber
    '#7A9CC6', // soft blue
    '#B585C9', // lilac
    '#E07A7A', // coral
    '#6CB57F', // sage
    '#D4A55C', // honey
];

function bucketColour(key: string, theme: AppTheme): string {
    if (key === UNRECOGNISED_KEY) return theme.warning;
    if (key === OTHER_KEY) return theme.textMuted;
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return BUCKET_COLOURS[h % BUCKET_COLOURS.length];
}

/**
 * Bucket the receipt's products by category, lump anything beyond the
 * top N into "Kita", and surface unmatched products as their own
 * "Neatpažinta" entry (separate so it reads as a quality signal, not
 * mixed into the long-tail "Kita" lump).
 */
function buildBuckets(products: BreakdownProduct[]): {
    buckets: Bucket[];
    grandTotal: number;
} {
    const byCategory = new Map<string, Bucket>();
    let unrecognisedTotal = 0;

    for (const p of products) {
        if (!Number.isFinite(p.price) || p.price <= 0) continue;
        if (!Number.isFinite(p.quantity) || p.quantity <= 0) continue;
        // What the user paid: promo wins over base when present.
        const lineTotal =
            p.promoPrice != null && p.promoPrice < p.price
                ? p.promoPrice * p.quantity
                : p.price * p.quantity;

        if (!p.matchConfirmed) {
            unrecognisedTotal += lineTotal;
            continue;
        }
        // Prefer L2 (matches Profilis statsService). Falls back to the
        // leaf categoryName so receipts that haven't been rehydrated
        // server-side still produce a usable breakdown (just at finer
        // granularity until the next hydration pass writes L2 back).
        const top = p.altMatches?.[0];
        const name = top?.categoryL2Name?.trim() || top?.categoryName?.trim();
        // Three signals collapse into the unrecognised bucket so it
        // surfaces as one row at the end of the list, never as a
        // ranked top category:
        //   1. No category resolved at all (legacy receipts, server missed the join).
        //   2. Product filed at L1 → L2 is null → leaf is L1 → reads as
        //      a mega-bucket label which we deliberately exclude.
        //   3. The literal server-side `Nepriskirta` category (Product.categoryId=688
        //      = the hidden catch-all the cross-chain bootstrap dumps products
        //      into when no real category fits). Same semantic as #1 — "we
        //      don't actually know what this is".
        if (!name || name.toLowerCase() === 'nepriskirta') {
            unrecognisedTotal += lineTotal;
            continue;
        }
        const existing = byCategory.get(name);
        if (existing) {
            existing.total += lineTotal;
        } else {
            byCategory.set(name, {
                key: name,
                label: name,
                total: lineTotal,
            });
        }
    }

    // Rank real categories by total. Top N stay individual; the rest
    // collapse into "Kita". The terminal-position invariant — Kita
    // always after the ranked top, Neatpažinta always last — is
    // intentional and independent of size: even if Neatpažinta dwarfs
    // every real bucket, it stays at the bottom of the list as a
    // quality signal rather than a headline category.
    const ranked = Array.from(byCategory.values()).sort((a, b) => b.total - a.total);
    const top = ranked.slice(0, TOP_N);
    const tail = ranked.slice(TOP_N);
    const buckets: Bucket[] = [...top];

    if (tail.length > 0) {
        const otherTotal = tail.reduce((s, b) => s + b.total, 0);
        buckets.push({
            key: OTHER_KEY,
            label: 'Kita',
            total: otherTotal,
            isOther: true,
        });
    }

    if (unrecognisedTotal > 0) {
        buckets.push({
            key: UNRECOGNISED_KEY,
            label: 'Neatpažinta',
            total: unrecognisedTotal,
            isUnrecognised: true,
        });
    }

    const grandTotal = buckets.reduce((s, b) => s + b.total, 0);
    return { buckets, grandTotal };
}

export default function ReceiptCategoryBreakdown({ products, receiptId }: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const [explainerOpen, setExplainerOpen] = useState(false);

    const { buckets, grandTotal } = useMemo(() => buildBuckets(products), [products]);

    // Don't render at all when there's nothing meaningful — keeps the
    // screen quiet for empty/invalid receipts.
    if (buckets.length === 0 || grandTotal <= 0) return null;

    return (
        <View style={styles.card}>
            <View style={styles.headerRow}>
                <Text style={styles.title}>Pirkinių pasiskirstymas</Text>
            </View>

            <View style={styles.stackedBar}>
                {buckets.map((b, i) => {
                    const pct = (b.total / grandTotal) * 100;
                    return (
                        <View
                            key={b.key}
                            style={[
                                styles.stackedBarSegment,
                                {
                                    width: `${pct}%`,
                                    backgroundColor: bucketColour(b.key, colors),
                                    // 1 px gap between segments via white border-right;
                                    // dropped on the last segment so the bar feels
                                    // visually closed on the right edge.
                                    borderRightWidth: i < buckets.length - 1 ? 1 : 0,
                                    borderRightColor: colors.cardBackground,
                                },
                            ]}
                        />
                    );
                })}
            </View>

            <View style={styles.list}>
                {buckets.map((b) => {
                    const pct = Math.round((b.total / grandTotal) * 100);
                    return (
                        <View
                            key={b.key}
                            style={[
                                styles.row,
                                b.isUnrecognised && styles.rowUnrecognised,
                            ]}
                        >
                            {/* Icon column: Nepriskirta uses a tappable
                                help-circle in the same warning colour as
                                its bar segment (the emoji `❓` rendered
                                in its native red tone, which broke the
                                bar/icon colour link). Tap opens the
                                explainer modal below. Every other row
                                gets a colour-matched dot so the eye
                                links the row to its bar segment. */}
                            {b.isUnrecognised ? (
                                <TouchableOpacity
                                    onPress={() => setExplainerOpen(true)}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    style={styles.rowGlyphTouch}
                                >
                                    <Ionicons
                                        name="help-circle"
                                        size={22}
                                        color={colors.warning}
                                    />
                                </TouchableOpacity>
                            ) : (
                                <View
                                    style={[
                                        styles.rowDot,
                                        { backgroundColor: bucketColour(b.key, colors) },
                                    ]}
                                />
                            )}
                            <Text
                                style={[
                                    styles.rowLabel,
                                    b.isUnrecognised && styles.rowLabelMuted,
                                ]}
                                numberOfLines={1}
                            >
                                {b.label}
                            </Text>
                            <Text style={styles.rowTotal}>{formatEuro(b.total)}</Text>
                            <Text style={styles.rowPct}>{pct}%</Text>
                        </View>
                    );
                })}
            </View>

            {/* Explainer modal — opens when the user taps the ❓ icon on
                the Neatpažinta row. Two paths out: dismiss, or jump to
                the swipe queue (same destination as the "Pagerink kainų
                palyginimą" CTA on the Suvestinė tab). */}
            <Modal
                visible={explainerOpen}
                transparent
                animationType="fade"
                onRequestClose={() => setExplainerOpen(false)}
            >
                <Pressable
                    style={styles.modalBackdrop}
                    onPress={() => setExplainerOpen(false)}
                >
                    <Pressable
                        style={styles.modalCard}
                        onPress={(e) => e.stopPropagation()}
                    >
                        <View style={styles.modalIconWrap}>
                            <Ionicons name="help-circle" size={32} color={colors.warning} />
                        </View>
                        <Text style={styles.modalTitle}>Neatpažintos prekės</Text>
                        <View style={styles.modalRows}>
                            <View style={styles.modalRow}>
                                <Ionicons
                                    name="pricetag-outline"
                                    size={18}
                                    color={colors.warning}
                                    style={styles.modalRowIcon}
                                />
                                <Text style={styles.modalRowText}>
                                    Šios prekės dar be kategorijos.
                                </Text>
                            </View>
                            <View style={styles.modalRow}>
                                <Ionicons
                                    name="swap-horizontal-outline"
                                    size={18}
                                    color={colors.primary}
                                    style={styles.modalRowIcon}
                                />
                                <Text style={styles.modalRowText}>
                                    Rūšiuok korteles – padėk joms rasti vietą.
                                </Text>
                            </View>
                            <View style={styles.modalRow}>
                                <Ionicons
                                    name="time-outline"
                                    size={18}
                                    color={colors.textMuted}
                                    style={styles.modalRowIcon}
                                />
                                <Text style={styles.modalRowText}>
                                    Kai kurios susitvarkys pačios, kai bus daugiau panašių prekių.
                                </Text>
                            </View>
                        </View>
                        <View style={styles.modalBtnRow}>
                            <TouchableOpacity
                                style={[styles.modalBtn, styles.modalBtnSecondary]}
                                onPress={() => setExplainerOpen(false)}
                            >
                                <Text style={styles.modalBtnTextSecondary}>Uždaryti</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.modalBtn, styles.modalBtnPrimary]}
                                onPress={() => {
                                    setExplainerOpen(false);
                                    // Voluntary mode anchored to THIS receipt
                                    // so the queue serves cards targeting the
                                    // user's actual Nepriskirta lines. The
                                    // pink button used to drop into the
                                    // global queue (standalone=1), which
                                    // surfaced unrelated cards — defeating
                                    // the modal's "padėk atpažinti" promise.
                                    router.push({
                                        pathname: '/swipe/queue',
                                        params: receiptId
                                            ? { receiptId: String(receiptId), voluntary: '1' }
                                            : { voluntary: '1' },
                                    } as any);
                                }}
                            >
                                <Text style={styles.modalBtnTextPrimary}>
                                    Pagerinti atpažinimą
                                </Text>
                            </TouchableOpacity>
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>
        </View>
    );
}

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        card: {
            backgroundColor: c.cardBackground,
            marginHorizontal: 16,
            marginTop: 16,
            borderRadius: 12,
            paddingHorizontal: 20,
            paddingTop: 18,
            paddingBottom: 20,
            elevation: 1,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.05,
            shadowRadius: 2,
        },
        headerRow: {
            marginBottom: 14,
        },
        title: {
            fontSize: 15,
            fontWeight: '600',
            color: c.textPrimary,
        },
        stackedBar: {
            flexDirection: 'row',
            width: '100%',
            height: 8,
            borderRadius: 6,
            overflow: 'hidden',
            backgroundColor: c.surfaceMuted,
        },
        stackedBarSegment: {
            height: '100%',
        },
        list: {
            marginTop: 16,
            gap: 10,
        },
        row: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
        },
        rowUnrecognised: {
            // No background tint — the muted text colour + ❓ emoji
            // already telegraphs the state without making the row feel
            // alarming.
        },
        // Icon-column width is fixed so the colour-dot and the help-
        // circle icon line up visually — keeps label columns straight
        // regardless of which icon a row uses.
        rowDot: {
            width: 14,
            height: 14,
            borderRadius: 7,
            marginHorizontal: 6,
        },
        rowGlyphTouch: {
            width: 26,
            alignItems: 'center',
            justifyContent: 'center',
        },

        // ── Nepriskirta explainer modal ─────────────────────────────
        modalBackdrop: {
            flex: 1,
            backgroundColor: c.overlayBackdrop,
            justifyContent: 'center',
            paddingHorizontal: 24,
        },
        modalCard: {
            backgroundColor: c.cardBackground,
            borderRadius: 16,
            padding: 20,
            gap: 12,
        },
        modalIconWrap: {
            alignSelf: 'center',
        },
        modalTitle: {
            fontSize: 17,
            fontWeight: '700',
            color: c.textPrimary,
            textAlign: 'center',
        },
        modalBody: {
            fontSize: 13,
            lineHeight: 19,
            color: c.textSecondary,
            textAlign: 'center',
        },
        // Iconified bullet rows replace the centered prose so the three
        // points (state → action → patience) feel like a scannable
        // checklist rather than a wall of text.
        modalRows: {
            gap: 10,
            paddingHorizontal: 4,
            marginTop: 4,
        },
        modalRow: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 10,
        },
        modalRowIcon: {
            marginTop: 1,
        },
        modalRowText: {
            flex: 1,
            fontSize: 13,
            lineHeight: 19,
            color: c.textSecondary,
        },
        modalBtnRow: {
            flexDirection: 'row',
            gap: 10,
            marginTop: 6,
        },
        modalBtn: {
            flex: 1,
            paddingVertical: 12,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
        },
        modalBtnSecondary: {
            backgroundColor: c.surfaceMuted,
        },
        modalBtnPrimary: {
            backgroundColor: c.primary,
        },
        modalBtnTextSecondary: {
            fontSize: 14,
            fontWeight: '600',
            color: c.textPrimary,
        },
        modalBtnTextPrimary: {
            fontSize: 14,
            fontWeight: '700',
            color: c.onPrimary,
        },
        rowLabel: {
            flex: 1,
            fontSize: 14,
            color: c.textPrimary,
        },
        rowLabelMuted: {
            color: c.textSecondary,
        },
        rowTotal: {
            fontSize: 14,
            fontWeight: '600',
            color: c.textPrimary,
            minWidth: 64,
            textAlign: 'right',
        },
        rowPct: {
            fontSize: 12,
            color: c.textMuted,
            minWidth: 32,
            textAlign: 'right',
        },
    });
