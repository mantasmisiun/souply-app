import React, { type ReactNode } from 'react';
import {
    Modal, Pressable, Text, ScrollView, TouchableOpacity,
    StyleSheet, useWindowDimensions, View, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, spacing, radius, elevation, type AppTheme } from '../constants/theme';
import { concentricRadius } from '../utils/displayCorners';
import { LiquidGlass } from './LiquidGlass';

const IS_IOS = Platform.OS === 'ios';
const INSET = spacing.lg;

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
    /** Whether the "All" STATE is active (drives the radio row; checkboxes render
     *  unchecked while it is — they mean explicit narrowing, not inclusion). */
    allChecked: boolean;
    allLabel: string;
    /** From the All state the first toggle selects ONLY that option (caller-owned). */
    onToggle: (id: number) => void;
    /** Return to the "All" state. */
    onAll: () => void;
};

interface Props {
    visible: boolean;
    title: string;
    options: FilterOption[];
    onClose: () => void;
    config: SingleConfig | MultiConfig;
}

/**
 * A titled option panel centred on screen. Single mode = radio list with an
 * "all" row that closes on pick; multi mode = an "All" radio STATE row above a
 * separator, then a checkbox list that stays open while toggling. Styled per
 * platform: an iOS Liquid Glass card (corners concentric with the display) over
 * a plain dim; Android gets a solid Material card.
 */
export function FilterDropdownModal({ visible, title, options, onClose, config }: Props) {
    const colors = useTheme();
    const styles = makeStyles(colors);
    const insets = useSafeAreaInsets();
    const { height: screenH } = useWindowDimensions();
    const maxListH = Math.round(screenH * 0.6);

    const body = (
        <>
            <Text style={styles.title}>{title}</Text>
            <ScrollView bounces={false} keyboardShouldPersistTaps="handled" style={{ maxHeight: maxListH }}>
                {config.mode === 'single' ? (
                    <Row
                        styles={styles} colors={colors}
                        label={config.allLabel}
                        selected={config.selectedId == null}
                        onPress={() => { config.onSelect(null); onClose(); }}
                    />
                ) : (
                    <>
                        <Row
                            styles={styles} colors={colors}
                            label={config.allLabel}
                            radio={config.allChecked}
                            onPress={config.onAll}
                        />
                        <View style={styles.separator} />
                    </>
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
        </>
    );

    return (
        <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
            <View style={styles.root}>
                <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
                {IS_IOS ? (
                    <LiquidGlass
                        style={[styles.card, { borderRadius: concentricRadius(insets.bottom, INSET) }]}
                        interactive={false}
                        fallback="blur"
                        intensity={30}
                    >
                        {body}
                    </LiquidGlass>
                ) : (
                    <View style={[styles.card, styles.cardMaterial]}>{body}</View>
                )}
            </View>
        </Modal>
    );
}

function Row({
    styles, colors, label, leading, selected, checked, radio, onPress,
}: {
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
    label: string;
    leading?: ReactNode;
    selected?: boolean;
    /** undefined => single-select row (no checkbox); boolean => multi-select. */
    checked?: boolean;
    /** Radio-style leading icon (the multi list's "All" STATE row). */
    radio?: boolean;
    onPress: () => void;
}) {
    const isMulti = checked !== undefined;
    return (
        <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6}>
            {radio !== undefined && (
                <Ionicons
                    name={radio ? 'radio-button-on' : 'radio-button-off'}
                    size={22}
                    color={radio ? colors.primary : colors.textMuted}
                />
            )}
            {isMulti && (
                <Ionicons
                    name={checked ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={checked ? colors.primary : colors.textMuted}
                />
            )}
            {leading}
            <Text
                style={[styles.rowLabel, (selected || (isMulti && checked) || radio === true) && styles.rowLabelActive]}
                numberOfLines={1}
            >
                {label}
            </Text>
            {!isMulti && selected && <Ionicons name="checkmark" size={20} color={colors.primary} />}
        </TouchableOpacity>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    // Centred card over a plain dim (no full-screen blur).
    root: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: INSET,
        backgroundColor: c.overlayBackdrop,
    },
    card: {
        width: '100%',
        maxWidth: 420,
        paddingVertical: 6,
        overflow: 'hidden',
    },
    cardMaterial: {
        backgroundColor: c.cardBackground,
        borderRadius: radius.xl,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: c.border,
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
    // Thin rule under the multi list's "All" radio row, separating the STATE row
    // from the narrowing checkboxes below it.
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: c.border,
        marginHorizontal: 12,
        marginVertical: 4,
    },
});
