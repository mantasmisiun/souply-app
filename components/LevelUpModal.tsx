import { View, Text, StyleSheet, Modal, TouchableOpacity, Pressable } from 'react-native';
import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../constants/theme';
import { getLevelData } from '../constants/levels';
import { useLevelStore } from '../state/levelStore';

export function LevelUpModal() {
    const colors = useTheme();
    const { pendingLevel, acknowledge } = useLevelStore();
    const [neverShow, setNeverShow] = useState(false);

    if (!pendingLevel) return null;

    const { emoji, name } = getLevelData(pendingLevel);
    const nextName = getLevelData(pendingLevel + 1).name;

    const dismiss = () => acknowledge(neverShow, pendingLevel);

    return (
        <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
            <Pressable style={s(colors).backdrop} onPress={dismiss}>
                <Pressable style={s(colors).sheet} onPress={e => e.stopPropagation()}>
                    <Text style={s(colors).emoji}>{emoji}</Text>
                    <Text style={s(colors).title}>Naujas lygis!</Text>
                    <Text style={s(colors).levelName}>{name}</Text>
                    <Text style={s(colors).body}>
                        Sveikiname — pasiekei {pendingLevel} lygį! 🎉{'\n\n'}
                        Tęsk įkeldamas kvitus ir lygindamas produktus, kad greičiau pasiektum kitą lygį — <Text style={{ fontWeight: '700' }}>{nextName}</Text>.
                    </Text>

                    <TouchableOpacity
                        style={s(colors).checkbox}
                        onPress={() => setNeverShow(v => !v)}
                        activeOpacity={0.7}
                    >
                        <View style={[s(colors).box, neverShow && s(colors).boxChecked]}>
                            {neverShow && <Ionicons name="checkmark" size={14} color="#fff" />}
                        </View>
                        <Text style={s(colors).checkboxLabel}>Daugiau nerodyti</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={s(colors).btn} onPress={dismiss}>
                        <Text style={s(colors).btnText}>Puiku!</Text>
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
