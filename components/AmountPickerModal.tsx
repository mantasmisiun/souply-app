import { View, Text, TouchableOpacity, StyleSheet, Modal, TextInput, ScrollView } from 'react-native';
import { useMemo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../config/api';
import { useTheme, radius, elevation, type AppTheme } from '../constants/theme';

interface AmountPickerModalProps {
    visible: boolean;
    productName: string;
    /** Product id — fetches the distinct SP pack sizes for the quick-select
     *  pills. Without it (or while loading / on error) only Custom shows. */
    productId?: number | null;
    /**
     * Canonical display unit decided server-side from the Product's SPs.
     * Always kg / l / vnt / pak / rit — never g / ml. Falls back to `unit`
     * (legacy) when canonicalUnit is null (Product has no SPs / unknown).
     */
    canonicalUnit?: string | null;
    canonicalStep?: number | null;
    canonicalFamily?: 'fluid' | 'count' | null;
    /** Legacy fallback (g/ml aggregates) — pill fallback when the pack-size
     *  fetch fails. */
    minAmount: number;
    maxAmount: number;
    unit: string;
    /** True when the product is sold by weight (bulk fruit/veg/meat). */
    isWeighable?: boolean;
    /** Reopen/edit mode: preselect the matching pill (or prefill Custom). */
    initialAmount?: number | null;
    /** Called with the chosen amount in CANONICAL units (kg / l / count). */
    onConfirm: (amount: number) => void;
    onCancel: () => void;
}

// Easter egg one-shot (per app session): tease 50+ kg/l once, then let it through.
let bigAmountJokeShown = false;

/** One quick-select pill: a distinct pack size in base units (g / ml / count). */
interface PackPill {
    /** Base-unit amount: grams for mass, ml for volume, count otherwise. */
    base: number;
    family: 'mass' | 'volume' | 'count';
    /** Canonical-unit value this pill confirms (kg / l / count). */
    canonical: number;
    label: string;
}

const familyOf = (u: string): 'mass' | 'volume' | 'count' =>
    u === 'g' || u === 'kg' ? 'mass' : u === 'ml' || u === 'l' ? 'volume' : 'count';

const toBase = (amount: number, u: string): number =>
    u === 'kg' || u === 'l' ? amount * 1000 : amount;

/** "200 g" / "1.5 kg" — pills print the natural size unit. */
const pillLabel = (base: number, family: 'mass' | 'volume' | 'count', countUnit: string): string => {
    if (family === 'count') return `${Number(base.toFixed(2))} ${countUnit}`;
    const big = family === 'mass' ? 'kg' : 'l';
    const small = family === 'mass' ? 'g' : 'ml';
    return base >= 1000
        ? `${Number((base / 1000).toFixed(3))} ${big}`
        : `${Number(base.toFixed(1))} ${small}`;
};

export default function AmountPickerModal({
    visible,
    productName,
    productId,
    canonicalUnit,
    canonicalStep,
    canonicalFamily,
    minAmount,
    maxAmount,
    unit,
    isWeighable = false,
    initialAmount = null,
    onConfirm,
    onCancel,
}: AmountPickerModalProps) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const displayUnit = canonicalUnit ?? (unit === 'g' ? 'kg' : unit === 'ml' ? 'l' : unit);
    const countUnitLabel = (['vnt', 'pak', 'rit'] as const).includes(displayUnit as any)
        ? t(`units.${displayUnit}`)
        : displayUnit;

    // ── Quick-select pills: distinct SP pack sizes (fetched on open). ───────
    const [sizes, setSizes] = useState<{ amount: number; unit: string }[] | null>(null);
    useEffect(() => {
        if (!visible) return;
        setSizes(null);
        setSelected(null);
        setCustomText('');
        setUnitMenuOpen(false);
        if (!productId) { setSizes([]); return; }
        let alive = true;
        fetch(`${API_BASE_URL}/api/products/${productId}/pack-sizes`)
            .then(r => (r.ok ? r.json() : []))
            .then(rows => { if (alive) setSizes(Array.isArray(rows) ? rows : []); })
            .catch(() => { if (alive) setSizes([]); });
        return () => { alive = false; };
    }, [visible, productId]);

    const pills: PackPill[] = useMemo(() => {
        const seen = new Map<string, PackPill>();
        for (const sz of sizes ?? []) {
            const fam = familyOf(sz.unit);
            const base = toBase(sz.amount, sz.unit);
            if (!(base > 0)) continue;
            const key = `${fam}:${Math.round(base * 100)}`;
            if (seen.has(key)) continue;
            seen.set(key, {
                base,
                family: fam,
                canonical: fam === 'count' ? base : base / 1000,
                label: pillLabel(base, fam, countUnitLabel),
            });
        }
        const all = [...seen.values()].sort((a, b) => a.base - b.base);
        // Mixed families (e.g. a 1 kg SP next to a 1 vnt SP of the same
        // product): weight/volume is the informative size — drop count pills.
        const measured = all.filter(p => p.family !== 'count');
        return measured.length > 0 ? measured : all;
    }, [sizes, countUnitLabel]);

    // ── Custom input unit: dropdown over the pills' family; the default is
    // the most popular unit as printed on the pills. ─────────────────────────
    const family: 'mass' | 'volume' | 'count' = pills[0]?.family
        ?? (displayUnit === 'kg' ? 'mass' : displayUnit === 'l' ? 'volume' : 'count');
    const unitOptions = family === 'mass' ? ['g', 'kg'] : family === 'volume' ? ['ml', 'l'] : [countUnitLabel];
    const defaultCustomUnit = useMemo(() => {
        if (family === 'count') return countUnitLabel;
        const tally = new Map<string, number>();
        for (const p of pills) {
            const u = p.label.split(' ').pop() as string;
            tally.set(u, (tally.get(u) ?? 0) + 1);
        }
        let best: string | null = null;
        for (const [u, n] of tally) if (best == null || n > (tally.get(best) ?? 0)) best = u;
        // No pills (pure weighable): weigh in kg/l.
        return best ?? (family === 'mass' ? 'kg' : 'l');
    }, [pills, family, countUnitLabel]);

    const [selected, setSelected] = useState<number | 'custom' | null>(null);
    const [customText, setCustomText] = useState('');
    const [customUnit, setCustomUnit] = useState(defaultCustomUnit);
    const [unitMenuOpen, setUnitMenuOpen] = useState(false);
    const [jokeAmount, setJokeAmount] = useState<number | null>(null);
    const JOKE_THRESHOLD = 50;
    const HARD_CAP = 999;

    // Reset per open; reopen-edit preselects the matching pill or prefills
    // Custom. GATED on the pack-size fetch having resolved — deciding while
    // sizes are in flight briefly mounted the Custom input (keyboard up→down
    // flash) before flipping to a pill.
    useEffect(() => {
        if (!visible || sizes == null) return;
        setJokeAmount(null);
        setUnitMenuOpen(false);
        setCustomUnit(defaultCustomUnit);
        if (initialAmount != null && initialAmount > 0) {
            const match = pills.find(p => Math.abs(p.canonical - initialAmount) < 1e-9);
            if (match) { setSelected(match.base); setCustomText(''); return; }
            setSelected('custom');
            const inSmall = family !== 'count' && (defaultCustomUnit === 'g' || defaultCustomUnit === 'ml');
            setCustomText(String(Number((initialAmount * (inSmall ? 1000 : 1)).toFixed(3))));
            return;
        }
        // Nothing preselected; with NO size pills Custom is the only path,
        // so it opens ready for typing.
        setSelected(pills.length === 0 ? 'custom' : null);
        setCustomText('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, productName, sizes == null, pills.length, defaultCustomUnit]);

    /** The chosen amount in canonical units (kg / l / count), or null. */
    const resolveValue = (): number | null => {
        if (selected === 'custom') {
            const parsed = parseFloat(customText.replace(',', '.'));
            if (!Number.isFinite(parsed) || parsed <= 0) return null;
            if (family === 'count') return parsed;
            return customUnit === 'g' || customUnit === 'ml' ? parsed / 1000 : parsed;
        }
        const pill = pills.find(p => p.base === selected);
        return pill ? pill.canonical : null;
    };
    const value = resolveValue();
    const isMassOrVolume = family !== 'count';

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
            {/* ScrollView (not View) so a tap on Confirm while the custom-weight
                keyboard is up registers on the FIRST tap instead of just
                dismissing the keyboard. keyboardShouldPersistTaps="handled". */}
            <ScrollView
                style={styles.overlayBg}
                contentContainerStyle={styles.overlay}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="none"
                showsVerticalScrollIndicator={false}
            >
                {jokeAmount != null ? (
                    <View style={styles.modal}>
                        <Text style={styles.title}>{t('amountPicker.jokeTitle')}</Text>
                        <Text style={[styles.subtitle, { marginBottom: 24 }]}>
                            {t('amountPicker.jokeBody', { value: String(jokeAmount), unit: displayUnit })}
                        </Text>
                        <View style={styles.actions}>
                            <TouchableOpacity style={styles.cancelButton} onPress={() => setJokeAmount(null)}>
                                <Text style={styles.cancelText}>{t('amountPicker.jokeCancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.confirmButton}
                                onPress={() => {
                                    bigAmountJokeShown = true;
                                    const v = jokeAmount;
                                    setJokeAmount(null);
                                    onConfirm(v);
                                }}
                            >
                                <Text style={styles.confirmText}>{t('amountPicker.jokeContinue')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                ) : (
                <View style={styles.modal}>
                    <Text style={styles.title}>{productName}</Text>
                    {isWeighable && <Text style={styles.subtitle}>{t('amountPicker.weighable')}</Text>}

                    {/* Quick-select pills, ONE horizontally-scrollable row —
                        Custom first, then the distinct pack sizes. */}
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={styles.pillsScroll}
                        contentContainerStyle={styles.pillsWrap}
                        keyboardShouldPersistTaps="handled"
                    >
                        <TouchableOpacity
                            style={[styles.pill, selected === 'custom' && styles.pillActive]}
                            onPress={() => setSelected('custom')}
                        >
                            <Text style={[styles.pillText, selected === 'custom' && styles.pillTextActive]}>
                                {t('amountPicker.custom')}
                            </Text>
                        </TouchableOpacity>
                        {pills.map(p => (
                            <TouchableOpacity
                                key={`${p.family}-${p.base}`}
                                style={[styles.pill, selected === p.base && styles.pillActive]}
                                onPress={() => { setSelected(p.base); setUnitMenuOpen(false); }}
                            >
                                <Text style={[styles.pillText, selected === p.base && styles.pillTextActive]}>{p.label}</Text>
                            </TouchableOpacity>
                        ))}
                    </ScrollView>

                    {/* Custom amount: number field + unit dropdown. */}
                    {selected === 'custom' && (
                        <View style={styles.customRow}>
                            <TextInput
                                style={styles.input}
                                value={customText}
                                onChangeText={setCustomText}
                                keyboardType="decimal-pad"
                                autoFocus
                                selectTextOnFocus
                                placeholder="0"
                                placeholderTextColor={colors.textMuted}
                            />
                            <View>
                                <TouchableOpacity
                                    style={styles.unitBtn}
                                    disabled={unitOptions.length < 2}
                                    onPress={() => setUnitMenuOpen(o => !o)}
                                >
                                    <Text style={styles.unitBtnText}>{customUnit}</Text>
                                    {unitOptions.length > 1 && <Text style={styles.unitCaret}>▾</Text>}
                                </TouchableOpacity>
                                {unitMenuOpen && (
                                    <View style={styles.unitMenu}>
                                        {unitOptions.map(u => (
                                            <TouchableOpacity
                                                key={u}
                                                style={styles.unitMenuRow}
                                                onPress={() => { setCustomUnit(u); setUnitMenuOpen(false); }}
                                            >
                                                <Text style={[styles.unitBtnText, u === customUnit && { color: colors.primary }]}>{u}</Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                )}
                            </View>
                        </View>
                    )}

                    <Text style={styles.hint}>
                        {isWeighable ? t('amountPicker.hintWeighable') : t('amountPicker.hintPackages')}
                    </Text>

                    <View style={styles.actions}>
                        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
                            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.confirmButton, value == null && styles.confirmDisabled]}
                            disabled={value == null}
                            onPress={() => {
                                if (value == null) return;
                                const v = Math.min(Math.round(value * 1000) / 1000, HARD_CAP);
                                if (isMassOrVolume && v >= JOKE_THRESHOLD && !bigAmountJokeShown) {
                                    setJokeAmount(v);
                                    return;
                                }
                                onConfirm(v);
                            }}
                        >
                            <Text style={styles.confirmText}>{t('amountPicker.add')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
                )}
            </ScrollView>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    overlayBg: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
    },
    overlay: {
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    modal: {
        backgroundColor: c.cardBackground,
        borderRadius: radius.xl,
        padding: 24,
        width: '100%',
        maxWidth: 340,
        ...elevation.level3,
    },
    title: {
        fontSize: 17,
        fontWeight: '700',
        color: c.textPrimary,
        textAlign: 'center',
        marginBottom: 4,
    },
    subtitle: {
        fontSize: 13,
        color: c.textSecondary,
        textAlign: 'center',
        marginBottom: 8,
    },
    pillsScroll: {
        marginTop: 12,
        marginBottom: 8,
        marginHorizontal: -24,
    },
    pillsWrap: {
        flexDirection: 'row',
        gap: 8,
        paddingHorizontal: 24,
    },
    pill: {
        borderRadius: radius.pill,
        borderWidth: 1.5,
        borderColor: c.primary,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    pillActive: { backgroundColor: c.primary },
    pillText: { fontSize: 14, fontWeight: '700', color: c.primary },
    pillTextActive: { color: c.onPrimary },
    customRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        marginTop: 8,
        marginBottom: 4,
    },
    input: {
        fontSize: 28,
        fontWeight: '700',
        color: c.primary,
        textAlign: 'center',
        minWidth: 90,
        paddingVertical: 4,
        borderBottomWidth: 2,
        borderBottomColor: c.primary,
    },
    unitBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: c.border,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    unitBtnText: { fontSize: 16, fontWeight: '600', color: c.textPrimary },
    unitCaret: { fontSize: 12, color: c.textSecondary },
    unitMenu: {
        position: 'absolute',
        top: '100%',
        right: 0,
        minWidth: 76,
        marginTop: 4,
        backgroundColor: c.cardBackground,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: c.border,
        ...elevation.level2,
        zIndex: 30,
    },
    unitMenuRow: { paddingHorizontal: 12, paddingVertical: 10 },
    hint: {
        fontSize: 11,
        color: c.textMuted,
        textAlign: 'center',
        marginTop: 8,
        marginBottom: 20,
    },
    actions: {
        flexDirection: 'row',
        gap: 12,
    },
    cancelButton: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: c.border,
        alignItems: 'center',
    },
    cancelText: {
        fontSize: 14,
        color: c.textSecondary,
        fontWeight: '600',
    },
    confirmButton: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: radius.pill,
        backgroundColor: c.primary,
        alignItems: 'center',
    },
    confirmDisabled: { opacity: 0.4 },
    confirmText: {
        fontSize: 14,
        color: c.onPrimary,
        fontWeight: '600',
    },
});
