import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import Animated from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { CollapsingHeader, useCollapsingHeader } from '../components/CollapsingHeader';
import { ScreenHeading } from '../components/ScreenHeading';
import { GlassSheet } from '../components/GlassSheet';
import { SheetCloseButton } from '../components/SheetCloseButton';
import ProductLineCard from '../components/ProductLineCard';
import { useRecipeImportState } from '../state/recipeImportState';
import { createTemplate } from '../utils/basketTemplatesApi';
import { isWeighableDisplay } from '../utils/weighable';
import { ltPluralSuffix } from '../utils/ltPlural';
import { getUserId } from '../config/user';
import { useTheme, radius, elevation, spacing, typography, type AppTheme } from '../constants/theme';
import type { RecipeImportItem, RecipeImportPreview } from '../utils/recipeImportApi';

/** An editable copy of one matched line. The preview is never mutated: the
 *  shopper's swaps/removals live here until the template is created. */
interface ImportRow {
    /** The preview's own index — stable across removals, so it keys the list. */
    key: number;
    productId: number;
    productName: string;
    imageUrl: string | null;
    isWeighable: boolean;
    quantity: number;
    unit: 'kg' | 'vnt';
    /** What the RECIPE asked for ("≈21 g") — never the buy quantity. */
    amountText: string | null;
    raw: string;
    pantry: boolean;
    needsReview: boolean;
    alternatives: RecipeImportItem['alternatives'];
}

const toRows = (preview: RecipeImportPreview | null): ImportRow[] =>
    (preview?.items ?? [])
        .filter(it => it.productId != null)
        .map(it => ({
            key: it.index,
            productId: it.productId!,
            productName: it.productName ?? it.name,
            imageUrl: it.imageUrl,
            isWeighable: it.isWeighable,
            quantity: it.quantity,
            unit: it.unit,
            amountText: it.amountText,
            raw: it.raw,
            pantry: it.pantry,
            needsReview: it.needsReview,
            alternatives: it.alternatives,
        }));

/**
 * Review an imported recipe before it becomes a template.
 *
 * The server's preview is a PROPOSAL — this is where it becomes a shopping
 * list. Three things the shopper does here and nowhere else: fix a product the
 * matcher wasn't sure about (the pink dot → alternatives sheet), strike the
 * pantry staples they already own in one tap, and see what the page said that
 * we couldn't turn into a product. Only when the CTA is pressed does anything
 * get written — `POST /api/basket-templates` with the surviving rows as items.
 */
export default function RecipeImportScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();
    const router = useRouter();
    const header = useCollapsingHeader();

    // Snapshot the staged import ONCE. The screen owns the editable copy from
    // here on, so clearing the store (on unmount / after create) can't blank the
    // screen mid-transition.
    const staged = useRef(useRecipeImportState.getState()).current;
    const preview = staged.preview;
    const draft = staged.draft;

    const [rows, setRows] = useState<ImportRow[]>(() => toRows(preview));
    // Per-row input buffer so typing "0" or "1" isn't clobbered mid-keystroke.
    const [qtyInputs, setQtyInputs] = useState<Record<number, string>>({});
    const [altKey, setAltKey] = useState<number | null>(null);
    const [skippedOpen, setSkippedOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    // Nothing staged (a reload, or the route reached directly) — there is no
    // import to review, so leave rather than show an empty shell.
    useEffect(() => { if (!preview || !draft) router.back(); }, [preview, draft, router]);
    useEffect(() => () => { useRecipeImportState.getState().clear(); }, []);

    const mainRows = useMemo(() => rows.filter(r => !r.pantry), [rows]);
    const pantryRows = useMemo(() => rows.filter(r => r.pantry), [rows]);

    const removeRow = useCallback((key: number) => {
        setRows(prev => prev.filter(r => r.key !== key));
        setQtyInputs(prev => { const next = { ...prev }; delete next[key]; return next; });
    }, []);

    const setQty = useCallback((key: number, raw: number) => {
        setRows(prev => prev.map(r => {
            if (r.key !== key) return r;
            const weighable = isWeighableDisplay(r.isWeighable, r.quantity);
            const rounded = weighable ? Math.round(raw * 10) / 10 : Math.round(raw);
            return { ...r, quantity: Math.max(0, Math.min(9999, rounded)) };
        }).filter(r => r.quantity > 0));
    }, []);

    /** An alternative the shopper picked is a confirmation — the doubt is gone,
     *  so the review marker goes with it. Unit + buy quantity stay: they come
     *  from the recipe's amount, not from which product matched it. */
    const swapProduct = useCallback((key: number, alt: RecipeImportItem['alternatives'][number]) => {
        setRows(prev => prev.map(r => r.key === key
            ? { ...r, productId: alt.productId, productName: alt.name, imageUrl: alt.imageUrl, needsReview: false }
            : r));
        setAltKey(null);
    }, []);

    const handleCreate = useCallback(async () => {
        if (creating || rows.length === 0 || !draft || !preview) return;
        setCreating(true);
        setCreateError(null);
        // Display order = list order: the shopping rows first, the pantry
        // leftovers the shopper chose to keep after them.
        const ordered = [...mainRows, ...pantryRows];
        try {
            const userId = await getUserId();
            const created = await createTemplate({
                userId,
                name: draft.name,
                coverColor: draft.coverColor,
                coverImage: draft.coverImage,
                // Provenance: the recipe screen's "Open recipe" is the only route
                // back to the method, which we never store.
                sourceUrl: preview.sourceUrl,
                sourceSite: preview.site,
                items: ordered.map((r, i) => ({
                    productId: r.productId,
                    quantity: r.quantity,
                    unit: r.unit,
                    sortOrder: i,
                    // The recipe REMEMBERS which items are cupboard staples. The
                    // keep-or-drop decision belongs to basket creation, not here:
                    // a recipe is a lasting thing, and whether you happen to have
                    // salt this week says nothing about it.
                    isPantry: r.pantry,
                })),
            });
            useRecipeImportState.getState().clear();
            router.replace(`/template/${created.id}` as any);
        } catch {
            setCreating(false);
            setCreateError(t('basketTab.templates.importCreateFailed'));
        }
    }, [creating, rows.length, draft, preview, mainRows, pantryRows, router, t]);

    if (!preview || !draft) return <View style={styles.container} />;

    // Source line under the title: which site it came from, and the yield the
    // page printed (the quantities below are scaled to it).
    const servings = preview.servings;
    const metaLine = [
        preview.site,
        servings ? t(`basketTab.templates.importServings_${ltPluralSuffix(servings)}`, { count: servings }) : null,
    ].filter(Boolean).join(' · ');

    const altRow = altKey == null ? null : rows.find(r => r.key === altKey) ?? null;

    const renderRow = (row: ImportRow) => {
        const weighable = isWeighableDisplay(row.isWeighable, row.quantity);
        const fallbackQty = weighable
            ? row.quantity.toFixed(1).replace('.', ',')
            : String(Math.round(row.quantity));
        const qty = qtyInputs[row.key] ?? fallbackQty;
        const step = weighable ? 0.1 : 1;
        return (
            <TouchableOpacity
                key={`r-${row.key}`}
                activeOpacity={row.needsReview ? 0.8 : 1}
                disabled={!row.needsReview}
                onPress={() => setAltKey(row.key)}
            >
                <ProductLineCard
                    name={row.productName}
                    imageUrls={row.imageUrl ? [row.imageUrl] : null}
                    quantityText={qty}
                    unit={weighable ? 'kg' : 'vnt.'}
                    weighable={weighable}
                    onChangeQuantity={(v) => {
                        if (weighable) { if (!/^[0-9]*[.,]?[0-9]?$/.test(v)) return; }
                        else if (/[^0-9]/.test(v)) return;
                        setQtyInputs(p => ({ ...p, [row.key]: v }));
                    }}
                    onCommitQuantity={(text) => {
                        const txt = text.replace(',', '.');
                        const val = weighable ? parseFloat(txt) : parseInt(txt, 10);
                        if (!val || val <= 0) removeRow(row.key);
                        else setQty(row.key, val);
                        setQtyInputs(p => { const c = { ...p }; delete c[row.key]; return c; });
                    }}
                    onDecrement={() => setQty(row.key, row.quantity - step)}
                    onIncrement={() => setQty(row.key, row.quantity + step)}
                    onRemove={() => removeRow(row.key)}
                />
                {/* The recipe's OWN amount, kept visually apart from the buy
                    quantity above it — one says "the dish needs this much", the
                    other "put this in the basket". */}
                {(row.amountText || row.needsReview) && (
                    <View style={styles.metaStrip}>
                        {row.amountText != null && (
                            <Text style={styles.metaText} numberOfLines={1}>
                                {t('basketTab.templates.importRecipeAmount', { amount: row.amountText })}
                            </Text>
                        )}
                        {row.needsReview && (
                            <View style={styles.reviewChip}>
                                <View style={styles.reviewDot} />
                                <Text style={styles.reviewChipText}>{t('basketTab.templates.importReviewChip')}</Text>
                            </View>
                        )}
                    </View>
                )}
            </TouchableOpacity>
        );
    };

    return (
        <>
            <CollapsingHeader controller={header} back smallTitle={draft.name} />
            <View style={styles.container}>
                <Animated.FlatList
                    {...header.scroll}
                    style={{ flex: 1 }}
                    data={mainRows}
                    keyExtractor={(item: any) => `m-${item.key}`}
                    contentContainerStyle={[styles.list, { paddingTop: 0 }]}
                    ListHeaderComponent={
                        <ScreenHeading
                            title={draft.name}
                            subtitle={metaLine || undefined}
                            bleedX={12}
                            onLayout={header.onTitleLayout}
                        />
                    }
                    renderItem={({ item }: { item: ImportRow }) => renderRow(item)}
                    ListEmptyComponent={
                        pantryRows.length === 0 ? (
                            <View style={styles.centered}>
                                <Ionicons name="basket-outline" size={56} color={colors.textMuted} />
                                <Text style={styles.emptyText}>{t('basketTab.templates.importEmptyTitle')}</Text>
                                <Text style={styles.emptySubText}>{t('basketTab.templates.importEmptyBody')}</Text>
                            </View>
                        ) : null
                    }
                    ListFooterComponent={
                        <>
                            {/* Pantry — below the shop list, because the point is to
                                strike salt/pepper/oil at a glance rather than shop for
                                them. Its SECTION HEADER carries that meaning; the rows
                                themselves are ordinary product cards. Dimming the group
                                (opacity 0.78) was tried and read as a grey wash — a card
                                with a shadow under reduced opacity looks damaged, not
                                secondary. */}
                            {pantryRows.length > 0 && (
                                <View style={styles.section}>
                                    <View style={styles.sectionHeader}>
                                        <Text style={styles.sectionTitle}>
                                            {t('basketTab.templates.importPantryTitle')}
                                        </Text>
                                    </View>
                                    {pantryRows.map(renderRow)}
                                </View>
                            )}

                            {/* Skipped — collapsed, but present. A line the importer
                                dropped silently is a line the shopper forgets to buy. */}
                            {preview.skipped.length > 0 && (
                                <View style={styles.section}>
                                    <TouchableOpacity
                                        style={styles.sectionHeader}
                                        onPress={() => setSkippedOpen(o => !o)}
                                        activeOpacity={0.7}
                                    >
                                        <Text style={styles.sectionTitle}>
                                            {`${t('basketTab.templates.importSkippedTitle')} · ${preview.skipped.length}`}
                                        </Text>
                                        <Ionicons
                                            name={skippedOpen ? 'chevron-up' : 'chevron-down'}
                                            size={18}
                                            color={colors.textMuted}
                                        />
                                    </TouchableOpacity>
                                    {skippedOpen && preview.skipped.map((s, i) => (
                                        <View key={`s-${i}`} style={styles.skippedRow}>
                                            <Text style={styles.skippedRaw} numberOfLines={2}>{s.raw}</Text>
                                            <Text style={styles.skippedReason}>
                                                {t(s.reason === 'unmatched'
                                                    ? 'basketTab.templates.importSkippedUnmatched'
                                                    : 'basketTab.templates.importSkippedNotIngredient')}
                                            </Text>
                                        </View>
                                    ))}
                                </View>
                            )}
                        </>
                    }
                />

                <View style={styles.footer}>
                    {createError != null && <Text style={styles.footerError}>{createError}</Text>}
                    <TouchableOpacity
                        style={[styles.cta, (creating || rows.length === 0) && styles.ctaDisabled]}
                        onPress={handleCreate}
                        disabled={creating || rows.length === 0}
                    >
                        {creating
                            ? <MaterialProgress color={colors.onPrimary} />
                            : <Text style={styles.ctaText}>{t('basketTab.templates.importCta')}</Text>}
                    </TouchableOpacity>
                </View>
            </View>

            {/* Alternatives — what else the matcher considered for this line, with
                the published text so the shopper can judge for themselves. */}
            {altRow != null && (
                <GlassSheet autoHeight onClose={() => setAltKey(null)}>
                    <View style={styles.sheetBody}>
                        <View style={styles.sheetTitleRow}>
                            <Text style={styles.sheetTitle}>{t('basketTab.templates.importAltTitle')}</Text>
                            <SheetCloseButton />
                        </View>
                        <Text style={styles.sheetRawLabel}>{t('basketTab.templates.importAltRawLabel')}</Text>
                        <Text style={styles.sheetRaw}>{altRow.raw}</Text>
                        {altRow.alternatives.length === 0 ? (
                            <Text style={styles.sheetEmpty}>{t('basketTab.templates.importAltEmpty')}</Text>
                        ) : altRow.alternatives.map(alt => (
                            <TouchableOpacity
                                key={`a-${alt.productId}`}
                                style={styles.altRow}
                                onPress={() => swapProduct(altRow.key, alt)}
                                activeOpacity={0.7}
                            >
                                {alt.imageUrl
                                    ? <Image source={{ uri: alt.imageUrl }} style={styles.altImage} />
                                    : <View style={[styles.altImage, styles.altImageEmpty]} />}
                                <View style={{ flex: 1, minWidth: 0 }}>
                                    <Text style={styles.altName} numberOfLines={2}>{alt.name}</Text>
                                    <Text style={styles.altConfidence}>{`${Math.round(alt.confidence * 100)}%`}</Text>
                                </View>
                                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                            </TouchableOpacity>
                        ))}
                    </View>
                </GlassSheet>
            )}
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    list: { padding: 12, paddingBottom: 24 },
    centered: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 18 },

    // Recipe-amount line + review marker, hung under each card.
    metaStrip: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
        marginTop: -4, marginBottom: 10, paddingHorizontal: 12,
    },
    metaText: { flex: 1, ...typography.labelSmall, fontWeight: '500', color: c.textMuted },
    reviewChip: {
        flexDirection: 'row', alignItems: 'center', gap: 5,
        backgroundColor: c.primaryMuted, borderRadius: radius.pill,
        paddingHorizontal: 8, paddingVertical: 3,
    },
    reviewDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.primary },
    reviewChipText: { fontSize: 10, fontWeight: '700', color: c.primary },

    section: { marginTop: 20 },
    sectionHeader: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: 4, marginBottom: 8,
    },
    sectionTitle: {
        fontSize: 12, fontWeight: '700', textTransform: 'uppercase',
        letterSpacing: 1, color: c.textSecondary,
    },
    sectionAction: { fontSize: 13, fontWeight: '600', color: c.primary },
    // Secondary by treatment, not by hiding: the rows stay fully usable.

    skippedRow: {
        backgroundColor: c.surfaceMuted, borderRadius: radius.md,
        padding: 10, marginBottom: 6,
    },
    skippedRaw: { fontSize: 13, color: c.textPrimary },
    skippedReason: { fontSize: 11, color: c.textMuted, marginTop: 2 },

    footer: {
        padding: 12, gap: 8,
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        ...elevation.level3,
    },
    footerError: { fontSize: 12, color: c.error, textAlign: 'center' },
    cta: {
        paddingVertical: 14, borderRadius: radius.pill,
        backgroundColor: c.primary, alignItems: 'center',
    },
    ctaDisabled: { backgroundColor: c.border },
    ctaText: { fontSize: 15, fontWeight: '700', color: c.onPrimary },

    // Inset comes from GlassSheet's SheetContent wrapper — gap only here.
    sheetBody: { gap: spacing.sm },
    sheetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    sheetTitle: { flex: 1, ...typography.subheading, color: c.textPrimary },
    sheetRawLabel: {
        fontSize: 11, fontWeight: '700', textTransform: 'uppercase',
        letterSpacing: 0.8, color: c.textMuted,
    },
    sheetRaw: { ...typography.bodySmall, color: c.textSecondary, marginTop: -4 },
    sheetEmpty: { ...typography.bodySmall, color: c.textMuted, paddingVertical: spacing.sm },
    altRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
    altImage: { width: 40, height: 40, borderRadius: 10 },
    altImageEmpty: { backgroundColor: c.surfaceMuted },
    altName: { ...typography.bodySmall, fontWeight: '600', color: c.textPrimary },
    altConfidence: { ...typography.labelSmall, color: c.textMuted, marginTop: 1 },
});
