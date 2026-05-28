import React, { useMemo } from 'react';
import { ScrollView, TouchableOpacity, Text, Image, StyleSheet, View } from 'react-native';
import { useTheme, type AppTheme } from '../constants/theme';
import { chainBrandColor } from '../utils/chainBrandName';

export interface StoreChip {
    id: string | number;
    label: string;
    logoUrl?: string | null;
    /** Remaining/total item count shown as a small badge on the chip */
    count?: number;
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
        <View style={styles.bar}>
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
                            style={[styles.chip, active && styles.chipActive]}
                            onPress={() => onSelect(active && hasAll ? null : chip.id)}
                        >
                            {chip.logoUrl ? (
                                <View style={[styles.chipLogoTile, { backgroundColor: chainBrandColor(chip.label) }]}>
                                    <Image
                                        source={{ uri: chip.logoUrl }}
                                        style={styles.chipLogo}
                                        resizeMode="contain"
                                    />
                                </View>
                            ) : null}
                            <Text style={[styles.chipText, active && styles.chipTextActive]}>
                                {chip.label}
                            </Text>
                            {chip.count != null && (
                                <View style={[styles.countBadge, active && styles.countBadgeActive]}>
                                    <Text style={[styles.countBadgeText, active && styles.countBadgeTextActive]}>
                                        {chip.count}
                                    </Text>
                                </View>
                            )}
                        </TouchableOpacity>
                    );
                })}
            </ScrollView>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    bar: {
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
        flexGrow: 0,
        flexShrink: 0,
    },
    scroll: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
    chip: {
        flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingHorizontal: 14, paddingVertical: 7,
        borderRadius: 20, borderWidth: 1,
        borderColor: c.border, backgroundColor: c.cardBackground,
    },
    chipActive: { backgroundColor: c.primary, borderColor: c.primary },
    chipLogoTile: {
        width: 20, height: 20, borderRadius: 4,
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    },
    chipLogo: { width: 14, height: 14 },
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
