import React, { useMemo } from 'react';
import { View, ScrollView, TouchableOpacity, Text, Image, StyleSheet } from 'react-native';
import { useTheme, type AppTheme } from '../constants/theme';
import { chainBrandName, getChainMiniLogoUrl } from '../utils/chainBrandName';

export interface ChainFilterItem {
    id: number;
    name: string;
    logoUrl: string;
}

interface Props {
    chains: ChainFilterItem[];
    selectedId: number | null;
    onSelect: (id: number | null) => void;
    allLabel: string;
}

export function ChainFilterBar({ chains, selectedId, onSelect, allLabel }: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    return (
        <View style={styles.filterBar}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.filterScroll}
            >
                <TouchableOpacity
                    style={[styles.chip, selectedId === null && styles.chipActive]}
                    onPress={() => onSelect(null)}
                >
                    <Text style={[styles.chipText, selectedId === null && styles.chipTextActive]}>
                        {allLabel}
                    </Text>
                </TouchableOpacity>
                {chains.map(chain => {
                    const active = selectedId === chain.id;
                    return (
                        <TouchableOpacity
                            key={chain.id}
                            style={[styles.chip, active && styles.chipActive]}
                            onPress={() => onSelect(chain.id)}
                        >
                            {chain.logoUrl ? (
                                <Image
                                    source={{ uri: getChainMiniLogoUrl(chain.id, chain.logoUrl) }}
                                    style={styles.chipLogo}
                                    resizeMode="contain"
                                />
                            ) : null}
                            <Text style={[styles.chipText, active && styles.chipTextActive]}>
                                {chainBrandName(chain.name)}
                            </Text>
                        </TouchableOpacity>
                    );
                })}
            </ScrollView>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    filterBar: {
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
        flexGrow: 0,
        flexShrink: 0,
    },
    filterScroll: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 8,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.cardBackground,
    },
    chipActive: {
        backgroundColor: c.primary,
        borderColor: c.primary,
    },
    chipText: {
        fontSize: 13,
        color: c.textPrimary,
    },
    chipTextActive: {
        color: c.onPrimary,
        fontWeight: '600',
    },
    chipLogo: {
        width: 16,
        height: 16,
    },
});
