import React, { useMemo } from 'react';
import { View, ScrollView, TouchableOpacity, Text, Image, StyleSheet } from 'react-native';
import { useTheme, type AppTheme } from '../constants/theme';
import { PinnedChipsBar } from './PinnedChipsBar';
import { chainBrandName, chainBrandColorById, getChainMiniLogoUrl } from '../utils/chainBrandName';

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
        <PinnedChipsBar>
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
                                <View style={[styles.chipLogoTile, { backgroundColor: chainBrandColorById(chain.id) }]}>
                                    <Image
                                        source={{ uri: getChainMiniLogoUrl(chain.id, chain.logoUrl) }}
                                        style={styles.chipLogo}
                                        resizeMode="contain"
                                    />
                                </View>
                            ) : null}
                            <Text style={[styles.chipText, active && styles.chipTextActive]}>
                                {chainBrandName(chain.name)}
                            </Text>
                        </TouchableOpacity>
                    );
                })}
            </ScrollView>
        </PinnedChipsBar>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
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
    chipLogoTile: {
        width: 20,
        height: 20,
        borderRadius: 4,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    chipLogo: {
        width: 14,
        height: 14,
    },
});
