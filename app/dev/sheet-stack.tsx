/**
 * DEV harness for the GlassStageSheet in-sheet page stack (2.0 Find-My:
 * stores → store → plan, X-to-pop). Exercises on-device:
 *   · push/pop slide animation + snap-height morph between pages
 *   · per-page scroll ↔ sheet-pan interplay at the expanded stage
 *   · Android hardware-back popping one page before leaving the screen
 * Reached from Profilis → Developer tools. No production surface.
 */
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useMemo, useRef, useState, useCallback } from 'react';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassStageSheet, SHEET_HANDLE_H, type GlassStageSheetRef, type SheetPage } from '../../components/GlassStageSheet';
import { glassHeaderOptions } from '../../constants/navHeader';
import { ScreenHeading } from '../../components/ScreenHeading';
import { useTheme, spacing, radius, type AppTheme } from '../../constants/theme';

const STORES = ['Maxima Aido g.', 'Rimi Gegužių g.', 'Lidl Tilžės g.', 'Iki Vytauto g.', 'Norfa Dubijos g.'];
const PLANS = ['Vien tik čia', 'Su Rimi (2 parduotuvės)', 'Su Lidl ir Iki (3 parduotuvės)'];

export default function SheetStackDemo() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();
    const sheetRef = useRef<GlassStageSheetRef>(null);

    // The caller owns the stack — path entries beyond the first are pushed.
    type PathEntry = { kind: 'stores' } | { kind: 'store'; name: string } | { kind: 'plan'; name: string };
    const [path, setPath] = useState<PathEntry[]>([{ kind: 'stores' }]);
    const [contentH, setContentH] = useState(300);

    const push = useCallback((entry: PathEntry) => setPath(p => [...p, entry]), []);
    const pop = useCallback(() => setPath(p => (p.length > 1 ? p.slice(0, -1) : p)), []);

    const pageHeader = (title: string, showX: boolean) => (
        <View style={styles.pageHeader}>
            <Text style={styles.pageTitle}>{title}</Text>
            {showX && (
                <TouchableOpacity style={styles.xBtn} onPress={pop} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close" size={18} color={colors.textSecondary} />
                </TouchableOpacity>
            )}
        </View>
    );

    const pages: SheetPage[] = path.map((entry, i) => {
        if (entry.kind === 'stores') {
            return {
                key: 'stores',
                content: (
                    <View style={styles.page}>
                        {pageHeader('Parduotuvės', false)}
                        {STORES.map(name => (
                            <TouchableOpacity key={name} style={styles.row} onPress={() => push({ kind: 'store', name })}>
                                <Ionicons name="storefront-outline" size={20} color={colors.primary} />
                                <Text style={styles.rowText}>{name}</Text>
                                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                            </TouchableOpacity>
                        ))}
                    </View>
                ),
            };
        }
        if (entry.kind === 'store') {
            return {
                key: `store-${i}`,
                content: (
                    <View style={styles.page}>
                        {pageHeader(entry.name, true)}
                        <Text style={styles.meta}>Aido g. 8-1, Šiauliai · 1,2 km</Text>
                        <Text style={styles.section}>Pirkimo planai su šia parduotuve</Text>
                        {PLANS.map(name => (
                            <TouchableOpacity key={name} style={styles.row} onPress={() => push({ kind: 'plan', name })}>
                                <Ionicons name="map-outline" size={20} color={colors.primary} />
                                <Text style={styles.rowText}>{name}</Text>
                                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                            </TouchableOpacity>
                        ))}
                    </View>
                ),
            };
        }
        return {
            key: `plan-${i}`,
            content: (
                <View style={styles.page}>
                    {pageHeader(entry.name, true)}
                    {Array.from({ length: 14 }).map((_, k) => (
                        <View key={k} style={styles.row}>
                            <Ionicons name="cart-outline" size={20} color={colors.textSecondary} />
                            <Text style={styles.rowText}>Prekė #{k + 1}</Text>
                            <Text style={styles.price}>€{(1.2 + k * 0.35).toFixed(2)}</Text>
                        </View>
                    ))}
                    <TouchableOpacity style={styles.cta}>
                        <Text style={styles.ctaText}>Sukurti sąrašą</Text>
                    </TouchableOpacity>
                </View>
            ),
        };
    });

    // Snaps: bar-only / half / content-capped full — recomputed as the active
    // page's content height changes (push/pop animates the difference).
    const barH = 64;
    const snaps = useMemo(() => {
        const full = Math.min(640, SHEET_HANDLE_H + barH + contentH + 16);
        return [barH + SHEET_HANDLE_H, Math.min(360, full), full];
    }, [contentH]);

    return (
        <View style={styles.container}>
            <Stack.Screen options={glassHeaderOptions({ back: true })} />
            <ScreenHeading title="Sheet stack demo" />
            <Text style={styles.hint}>
                Išskleisk apačios juostą; spausk eilutes gilyn (parduotuvė → planas), X arba Android „atgal“ grįžta lygiu aukščiau.
            </Text>

            <GlassStageSheet
                ref={sheetRef}
                snaps={snaps}
                initialStage={1}
                bar={(
                    <View style={[styles.bar, { height: barH }]}>
                        <Text style={styles.barText}>Gylis: {path.length}/3</Text>
                        <TouchableOpacity onPress={() => sheetRef.current?.snapTo(2)}>
                            <Text style={styles.barAction}>Išskleisti</Text>
                        </TouchableOpacity>
                    </View>
                )}
                pages={pages}
                onPopPage={pop}
                onContentHeight={setContentH}
                colors={colors}
                bottomInset={bottomInset}
            />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    hint: { color: c.textSecondary, fontSize: 13, lineHeight: 18, paddingHorizontal: 16, marginTop: 8 },
    bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg },
    barText: { color: c.textPrimary, fontWeight: '700', fontSize: 15 },
    barAction: { color: c.primary, fontWeight: '700', fontSize: 14 },
    page: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
    pageHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm },
    pageTitle: { color: c.textPrimary, fontWeight: '800', fontSize: 17, flex: 1 },
    xBtn: {
        width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.surfaceMuted,
    },
    meta: { color: c.textSecondary, fontSize: 13, marginBottom: spacing.sm },
    section: { color: c.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: spacing.sm, marginBottom: spacing.xs },
    row: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle,
    },
    rowText: { color: c.textPrimary, fontSize: 15, fontWeight: '600', flex: 1 },
    price: { color: c.textSecondary, fontSize: 14, fontWeight: '700' },
    cta: {
        marginTop: spacing.lg, backgroundColor: c.primary, borderRadius: radius.pill,
        paddingVertical: 14, alignItems: 'center',
    },
    ctaText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },
});
