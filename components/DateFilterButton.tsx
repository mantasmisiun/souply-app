import { useState } from 'react';
import { View, Text, Modal, Pressable, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, spacing, radius, typography, type AppTheme } from '../constants/theme';
import { concentricRadius } from '../utils/displayCorners';
import { FilterPill } from './FilterPill';
import { DotCalendar } from './DotCalendar';
import { LiquidGlass } from './LiquidGlass';

const IS_IOS = Platform.OS === 'ios';
// Horizontal float inset for the iOS centred card — its corner radius is drawn
// concentric with the display's own corners at this inset (Find-My style).
const IOS_INSET = spacing.lg;

const defaultFmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * A pill that opens a custom day-grid calendar to filter by a single day. Only
 * days with receipts are selectable, each showing chain-coloured dots. Styled
 * per platform: an iOS 26 Liquid Glass card centred on screen (corners
 * concentric with the display), vs an Android Material bottom sheet.
 * `value === null` = no filter; the active pill shows the date + a ✕ to clear.
 */
export function DateFilterButton({
    value,
    onChange,
    label,
    markedDates,
    formatLabel = defaultFmt,
}: {
    value: Date | null;
    onChange: (d: Date | null) => void;
    /** Pill label while inactive (e.g. "Date"). */
    label: string;
    /** "YYYY-MM-DD" → chain dot colours; only these days are selectable. */
    markedDates: Map<string, string[]>;
    formatLabel?: (d: Date) => string;
}) {
    const colors = useTheme();
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const styles = makeStyles(colors);
    const [open, setOpen] = useState(false);
    const active = value != null;

    const body = (
        <>
            <View style={styles.headerRow}>
                {!IS_IOS && <View style={styles.grabber} />}
                <View style={styles.headerBar}>
                    <TouchableOpacity onPress={() => { onChange(null); setOpen(false); }} hitSlop={10}>
                        <Text style={styles.clear}>{t('common.clear')}</Text>
                    </TouchableOpacity>
                    <Text style={styles.title}>{label}</Text>
                    <TouchableOpacity onPress={() => setOpen(false)} hitSlop={10}>
                        <Text style={styles.done}>{t('common.close')}</Text>
                    </TouchableOpacity>
                </View>
            </View>
            <DotCalendar
                value={value}
                markedDates={markedDates}
                onSelect={(d) => { onChange(d); setOpen(false); }}
            />
        </>
    );

    return (
        <>
            <FilterPill
                active={active}
                onPress={() => setOpen(true)}
                label={active ? formatLabel(value!) : label}
                leading={
                    <Ionicons name="calendar-outline" size={14} color={active ? colors.onPrimary : colors.textSecondary} />
                }
                trailing={
                    active ? (
                        <TouchableOpacity onPress={() => onChange(null)} hitSlop={8}>
                            <Ionicons name="close" size={14} color={colors.onPrimary} />
                        </TouchableOpacity>
                    ) : (
                        <Ionicons name="chevron-down" size={14} color={colors.textSecondary} />
                    )
                }
            />

            <Modal
                visible={open}
                transparent
                animationType={IS_IOS ? 'fade' : 'slide'}
                onRequestClose={() => setOpen(false)}
                statusBarTranslucent
            >
                {IS_IOS ? (
                    // Centred glass card; corners concentric with the display.
                    <View style={styles.iosRoot}>
                        <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
                        <LiquidGlass
                            style={[styles.iosCard, { borderRadius: concentricRadius(insets.bottom, IOS_INSET) }]}
                            interactive={false}
                            fallback="blur"
                            intensity={30}
                        >
                            {body}
                        </LiquidGlass>
                    </View>
                ) : (
                    <>
                        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
                        <View style={[styles.sheet, styles.sheetMaterial]}>{body}</View>
                    </>
                )}
            </Modal>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: c.overlayBackdrop },
    // iOS: full-screen dim with the card centred, floated IOS_INSET from the edges.
    iosRoot: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: IOS_INSET,
        backgroundColor: c.overlayBackdrop,
    },
    iosCard: {
        width: '100%',
        maxWidth: 400,
        overflow: 'hidden',
        paddingHorizontal: spacing.md,
        paddingTop: spacing.xs,
        paddingBottom: spacing.lg,
    },
    // Android: a solid Material bottom sheet.
    sheet: {
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        paddingHorizontal: spacing.md,
        paddingBottom: spacing.xxl,
        overflow: 'hidden',
    },
    sheetMaterial: { backgroundColor: c.cardBackground },
    headerRow: { alignItems: 'center' },
    grabber: {
        width: 36, height: 5, borderRadius: radius.pill,
        backgroundColor: c.borderSubtle, marginTop: spacing.sm, marginBottom: spacing.xs,
    },
    headerBar: {
        alignSelf: 'stretch',
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingVertical: spacing.sm, paddingHorizontal: spacing.xs,
    },
    title: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary },
    clear: { ...typography.body, color: c.textSecondary },
    done: { ...typography.body, color: c.primary, fontWeight: '600' },
});
