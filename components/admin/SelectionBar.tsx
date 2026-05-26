import { memo, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';

interface Props {
    count: number;
    isSuperAdmin: boolean;
    onMove: () => void;
    onMerge: () => void;
    onRename: () => void;
}

function SelectionBar({ count, isSuperAdmin, onMove, onMerge, onRename }: Props) {
    const { t } = useTranslation();
    const colors = useTheme();
    const { bottom } = useSafeAreaInsets();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const mergeDisabled = count < 2;
    const renameDisabled = count !== 1;

    return (
        <View style={[styles.bar, { paddingBottom: Math.max(16, bottom) }]}>
            <Text style={styles.countText}>{t('admin.catalog.selectionCount', { count })}</Text>
            <View style={styles.actions}>
                <Action
                    icon="folder-open-outline"
                    label={t('admin.catalog.move')}
                    onPress={onMove}
                    colors={colors}
                    styles={styles}
                />
                <View style={styles.separator} />
                <Action
                    icon="git-merge-outline"
                    label={t('admin.catalog.merge')}
                    onPress={onMerge}
                    disabled={mergeDisabled}
                    colors={colors}
                    styles={styles}
                />
                <View style={styles.separator} />
                <Action
                    icon="pencil-outline"
                    label={t('admin.catalog.rename')}
                    onPress={onRename}
                    disabled={renameDisabled}
                    colors={colors}
                    styles={styles}
                />
            </View>
        </View>
    );
}

function Action({
    icon, label, onPress, disabled, destructive, colors, styles,
}: {
    icon: string;
    label: string;
    onPress: () => void;
    disabled?: boolean;
    destructive?: boolean;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}) {
    const iconColor = disabled
        ? colors.textMuted
        : destructive
            ? '#e53e3e'
            : colors.primary;

    return (
        <TouchableOpacity
            style={[styles.action, disabled && styles.actionDisabled]}
            onPress={disabled ? undefined : onPress}
            activeOpacity={disabled ? 1 : 0.7}
        >
            <Ionicons name={icon as any} size={18} color={iconColor} />
            <Text style={[
                styles.actionText,
                disabled && styles.actionTextDisabled,
                destructive && !disabled && styles.actionTextDestructive,
            ]}>
                {label}
            </Text>
        </TouchableOpacity>
    );
}

export default memo(SelectionBar);

const makeStyles = (c: AppTheme) => StyleSheet.create({
    bar: {
        backgroundColor: c.cardBackground,
        borderTopWidth: 1,
        borderTopColor: c.border,
        paddingTop: 12,
        paddingHorizontal: 16,
        gap: 12,
    },
    countText: {
        fontSize: 13,
        fontWeight: '600',
        color: c.textSecondary,
        textAlign: 'center',
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
    },
    separator: {
        width: 1,
        height: 24,
        backgroundColor: c.border,
        marginHorizontal: 4,
    },
    action: {
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 10,
        backgroundColor: c.surfaceMuted,
        minWidth: 68,
    },
    actionDisabled: { opacity: 0.35 },
    actionText: {
        fontSize: 12,
        fontWeight: '600',
        color: c.primary,
    },
    actionTextDisabled: { color: c.textMuted },
    actionTextDestructive: { color: '#e53e3e' },
});
