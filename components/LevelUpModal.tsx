import { View, Text, StyleSheet, Modal, TouchableOpacity, Pressable } from 'react-native';
import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../constants/theme';
import { getLevelData, getLevelName } from '../constants/levels';
import { useLevelStore } from '../state/levelStore';
import { useSettingsStore } from '../state/settingsStore';

export function LevelUpModal() {
    const colors = useTheme();
    const { t } = useTranslation();
    const { pendingLevel, acknowledge } = useLevelStore();
    const showLevelUpModal = useSettingsStore((s) => s.showLevelUpModal);
    const [neverShow, setNeverShow] = useState(false);

    // User has globally disabled level-up celebrations from Settings →
    // Pranešimai. Quietly drop the pending candidate so the modal doesn't
    // sit waiting for input that never comes. Done in an effect (not during
    // render) so the state change is not committed mid-render.
    useEffect(() => {
        if (pendingLevel && !showLevelUpModal) {
            acknowledge(false, pendingLevel);
        }
    }, [pendingLevel, showLevelUpModal, acknowledge]);

    if (!pendingLevel || !showLevelUpModal) return null;

    const { emoji } = getLevelData(pendingLevel);
    const name = getLevelName(pendingLevel, t);
    const nextName = getLevelName(pendingLevel + 1, t);

    const dismiss = () => acknowledge(neverShow, pendingLevel);

    return (
        <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
            <Pressable style={s(colors).backdrop} onPress={dismiss}>
                <Pressable style={s(colors).sheet} onPress={e => e.stopPropagation()}>
                    <Text style={s(colors).emoji}>{emoji}</Text>
                    <Text style={s(colors).title}>{t('levelUp.title')}</Text>
                    <Text style={s(colors).levelName}>{name}</Text>
                    <Text style={s(colors).body}>
                        {t('levelUp.body', { level: pendingLevel, nextName })}
                    </Text>

                    <TouchableOpacity
                        style={s(colors).checkbox}
                        onPress={() => setNeverShow(v => !v)}
                        activeOpacity={0.7}
                    >
                        <View style={[s(colors).box, neverShow && s(colors).boxChecked]}>
                            {neverShow && <Ionicons name="checkmark" size={14} color="#fff" />}
                        </View>
                        <Text style={s(colors).checkboxLabel}>{t('levelUp.neverShow')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={s(colors).btn} onPress={dismiss}>
                        <Text style={s(colors).btnText}>{t('levelUp.cta')}</Text>
                    </TouchableOpacity>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

const s = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 32,
    },
    sheet: {
        backgroundColor: c.cardBackground,
        borderRadius: 20,
        padding: 28,
        alignItems: 'center',
        width: '100%',
    },
    emoji:     { fontSize: 64, marginBottom: 8 },
    title:     { fontSize: 13, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
    levelName: { fontSize: 24, fontWeight: '800', color: c.textPrimary, marginBottom: 16 },
    body:      { fontSize: 14, color: c.textSecondary, lineHeight: 22, textAlign: 'center', marginBottom: 24 },

    checkbox: { flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start', marginBottom: 20 },
    box: {
        width: 20, height: 20, borderRadius: 5,
        borderWidth: 1.5, borderColor: c.border,
        alignItems: 'center', justifyContent: 'center',
    },
    boxChecked:    { backgroundColor: c.primary, borderColor: c.primary },
    checkboxLabel: { fontSize: 14, color: c.textSecondary },

    btn:     { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', width: '100%' },
    btnText: { fontSize: 16, fontWeight: '700', color: c.onPrimary },
});
