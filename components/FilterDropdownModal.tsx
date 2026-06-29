import React, { type ReactNode } from 'react';
import {
    Modal, Pressable, Text, ScrollView, TouchableOpacity,
    StyleSheet, useWindowDimensions,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useResolvedScheme, radius, elevation, type AppTheme } from '../constants/theme';

export interface FilterOption {
    id: number;
    label: string;
    /** Optional leading node, e.g. a chain logo chip. */
    leading?: ReactNode;
}

type SingleConfig = {
    mode: 'single';
    selectedId: number | null;
    /** Label for the leading "all" row (selects id = null). */
    allLabel: string;
    onSelect: (id: number | null) => void;
};

type MultiConfig = {
    mode: 'multi';
    isChecked: (id: number) => boolean;
    /** Whether every option is checked (drives the "all" row checkbox). */
    allChecked: boolean;
    allLabel: string;
    onToggle: (id: number) => void;
    /** Reset the selection back to "all selected". */
    onAll: () => void;
};

interface Props {
    visible: boolean;
    title: string;
    /** Window Y (px) of the bottom of the trigger row — the panel drops below it. */
    anchorY: number;
    options: FilterOption[];
    onClose: () => void;
    config: SingleConfig | MultiConfig;
}

/**
 * A dropdown that drops a titled option panel just below a filter chip row.
 * Single mode = radio list with an "all" row that closes on pick; multi mode =
 * checkbox list with an "all" reset row that stays open while toggling.
 */
export function FilterDropdownModal({ visible, title, anchorY, options, onClose, config }: Props) {
    const colors = useTheme();
    const styles = makeStyles(colors);
    const { height: screenH } = useWindowDimensions();
    const isDark = useResolvedScheme() === 'dark';
    const maxPanelH = Math.max(160, screenH - anchorY - 24);

    return (
        <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
            <Pressable style={styles.backdrop} onPress={onClose}>
                <BlurView
                    intensity={isDark ? 32 : 42}
                    tint={isDark ? 'dark' : 'light'}
                    experimentalBlurMethod="dimezisBlurView"
                    pointerEvents="none"
                    style={StyleSheet.absoluteFill}
                />
                <Pressable style={[styles.panel, { top: anchorY + 4, maxHeight: maxPanelH }]} onPress={() => {}}>
                    <Text style={styles.title}>{title}</Text>
                    <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
                        {config.mode === 'single' ? (
                            <Row
                                styles={styles} colors={colors}
                                label={config.allLabel}
                                selected={config.selectedId == null}
                                onPress={() => { config.onSelect(null); onClose(); }}
                            />
                        ) : (
                            <Row
                                styles={styles} colors={colors}
                                label={config.allLabel}
                                checked={config.allChecked}
                                onPress={config.onAll}
                            />
                        )}
                        {options.map(opt => (
                            <Row
                                key={opt.id}
                                styles={styles} colors={colors}
                                label={opt.label}
                                leading={opt.leading}
                                selected={config.mode === 'single' && config.selectedId === opt.id}
                                checked={config.mode === 'multi' ? config.isChecked(opt.id) : undefined}
                                onPress={() => {
                                    if (config.mode === 'single') { config.onSelect(opt.id); onClose(); }
                                    else config.onToggle(opt.id);
                                }}
                            />
                        ))}
                    </ScrollView>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

function Row({
    styles, colors, label, leading, selected, checked, onPress,
}: {
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
    label: string;
    leading?: ReactNode;
    selected?: boolean;
    /** undefined => single-select row (no checkbox); boolean => multi-select. */
    checked?: boolean;
    onPress: () => void;
}) {
    const isMulti = checked !== undefined;
    return (
        <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6}>
            {isMulti && (
                <Ionicons
                    name={checked ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={checked ? colors.primary : colors.textMuted}
                />
            )}
            {leading}
            <Text
                style={[styles.rowLabel, (selected || (isMulti && checked)) && styles.rowLabelActive]}
                numberOfLines={1}
            >
                {label}
            </Text>
            {!isMulti && selected && <Ionicons name="checkmark" size={20} color={colors.primary} />}
        </TouchableOpacity>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    // Faint dim as a fallback for platforms where the BlurView doesn't render.
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.12)' },
    panel: {
        position: 'absolute',
        left: 12, right: 12,
        backgroundColor: c.cardBackground,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: c.border,
        paddingVertical: 6,
        overflow: 'hidden',
        ...elevation.level3,
    },
    title: {
        paddingHorizontal: 16, paddingTop: 6, paddingBottom: 8,
        fontSize: 11, fontWeight: '700', letterSpacing: 0.6,
        color: c.textMuted, textTransform: 'uppercase',
    },
    row: {
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingHorizontal: 16, paddingVertical: 12,
    },
    rowLabel: { flex: 1, fontSize: 15, color: c.textPrimary },
    rowLabelActive: { color: c.primary, fontWeight: '600' },
});
