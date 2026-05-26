import { useEffect, useMemo, useState } from 'react';
import {
    Modal, View, Text, TextInput, TouchableOpacity,
    StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import type { AdminProduct } from './AdminProductCard';

interface Props {
    visible: boolean;
    product: AdminProduct | null;
    onSave: (name: string) => void;
    onCancel: () => void;
}

export default function ProductEditModal({ visible, product, onSave, onCancel }: Props) {
    const { t } = useTranslation();
    const colors = useTheme();
    const { top, bottom } = useSafeAreaInsets();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [name, setName] = useState('');

    useEffect(() => {
        if (product) setName(product.name);
    }, [product?.id]);

    const canSave = name.trim().length > 0 && name.trim() !== product?.name;

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onCancel} transparent>
            <KeyboardAvoidingView
                style={styles.overlay}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onCancel} />
                <View style={[styles.sheet, { paddingBottom: Math.max(24, bottom) }]}>
                    <View style={styles.handle} />
                    <Text style={styles.title}>{t('admin.catalog.renameTitle')}</Text>
                    {product && (
                        <Text style={styles.currentName} numberOfLines={1}>
                            {product.name}
                        </Text>
                    )}
                    <TextInput
                        style={styles.input}
                        value={name}
                        onChangeText={setName}
                        placeholder={t('admin.catalog.renamePlaceholder')}
                        placeholderTextColor={colors.textMuted}
                        autoFocus
                        returnKeyType="done"
                        onSubmitEditing={() => canSave && onSave(name.trim())}
                        selectTextOnFocus
                    />
                    <View style={styles.btnRow}>
                        <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
                            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
                            onPress={() => canSave && onSave(name.trim())}
                            disabled={!canSave}
                        >
                            <Text style={styles.saveText}>{t('common.save')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    overlay: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
    sheet: {
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        padding: 20,
        gap: 14,
    },
    handle: {
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: c.border,
        alignSelf: 'center',
        marginBottom: 4,
    },
    title: {
        fontSize: 16,
        fontWeight: '700',
        color: c.textPrimary,
    },
    currentName: {
        fontSize: 13,
        color: c.textMuted,
        marginTop: -6,
    },
    input: {
        backgroundColor: c.pageBackground,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        paddingHorizontal: 14,
        paddingVertical: 12,
        fontSize: 15,
        color: c.textPrimary,
    },
    btnRow: {
        flexDirection: 'row',
        gap: 10,
        marginTop: 2,
    },
    cancelBtn: {
        flex: 1,
        borderRadius: 12,
        paddingVertical: 13,
        alignItems: 'center',
        backgroundColor: c.surfaceMuted,
    },
    cancelText: {
        fontSize: 15,
        fontWeight: '600',
        color: c.textSecondary,
    },
    saveBtn: {
        flex: 1,
        borderRadius: 12,
        paddingVertical: 13,
        alignItems: 'center',
        backgroundColor: c.primary,
    },
    saveBtnDisabled: { opacity: 0.4 },
    saveText: {
        fontSize: 15,
        fontWeight: '700',
        color: c.onPrimary,
    },
});
