import React, { useMemo } from 'react';
import { ScrollView, TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { useTheme, type AppTheme } from '../constants/theme';
import { PinnedChipsBar } from './PinnedChipsBar';
import { chainIdByName } from '../utils/chainBrandName';
import { ChainLogoChip } from './ChainLogoChip';

export interface StoreChip {
    id: string | number;
    label: string;
    logoUrl?: string | null;
    /** A single count shown as a small badge on the chip. */
    count?: number;
    /** A pre-formatted badge string (e.g. "1/2" checked/total) — wins over count. */
    countLabel?: string;
}

interface Props {
    chips: StoreChip[];
    selectedId: string | number | null;
    onSelect: (id: string | number | null) => void;
    /** If provided, an "All" chip is prepended and tapping the active chip deselects. */
    allLabel?: string;
}

export function StoreChipBar({ chips, selectedId, onSelect, allLabel }: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const hasAll = allLabel !== undefined;

    return (
        <PinnedChipsBar>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.scroll}
            >
                {hasAll && (
                    <TouchableOpacity
                        style={[styles.chip, selectedId === null && styles.chipActive]}
                        onPress={() => onSelect(null)}
                    >
                        <Text style={[styles.chipText, selectedId === null && styles.chipTextActive]}>
                            {allLabel}
                        </Text>
                    </TouchableOpacity>
                )}
                {chips.map(chip => {
                    const active = selectedId === chip.id;
                    return (
                        <TouchableOpacity
                            key={String(chip.id)}
                            style={[styles.chip, chip.logoUrl ? styles.chipWithLogo : null, active && styles.chipActive]}
                            onPress={() => onSelect(active && hasAll ? null : chip.id)}
                        >
                            {chip.logoUrl ? (
                                <ChainLogoChip chainId={chainIdByName(chip.label) ?? 0} name={chip.label} logoUrl={chip.logoUrl} size={20} />
                            ) : null}
                            <Text style={[styles.chipText, active && styles.chipTextActive]}>
                                {chip.label}
                            </Text>
                            {(chip.countLabel != null || chip.count != null) && (
                                <View style={[styles.countBadge, active && styles.countBadgeActive]}>
                                    <Text style={[styles.countBadgeText, active && styles.countBadgeTextActive]}>
                                        {chip.countLabel ?? chip.count}
                                    </Text>
                                </View>
                            )}
                        </TouchableOpacity>
                    );
                })}
            </ScrollView>
        </PinnedChipsBar>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    scroll: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
    chip: {
        flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingHorizontal: 14, paddingVertical: 7,
        borderRadius: 20, borderWidth: 1,
        borderColor: c.border, backgroundColor: c.cardBackground,
    },
    // With a leading logo, the horizontal inset matches the vertical inset (7)
    // so the round badge sits equidistant from the left, top and bottom borders
    // and the right padding mirrors the left.
    chipWithLogo: { paddingHorizontal: 7 },
    chipActive: { backgroundColor: c.primary, borderColor: c.primary },
    chipText: { fontSize: 13, color: c.textPrimary },
    chipTextActive: { color: c.onPrimary, fontWeight: '600' },
    countBadge: {
        backgroundColor: c.border, borderRadius: 10,
        paddingHorizontal: 5, paddingVertical: 1,
        minWidth: 18, alignItems: 'center',
    },
    countBadgeActive: { backgroundColor: 'rgba(255,255,255,0.28)' },
    countBadgeText: { fontSize: 11, fontWeight: '700', color: c.textSecondary },
    countBadgeTextActive: { color: c.onPrimary },
});
