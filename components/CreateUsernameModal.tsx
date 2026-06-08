import {
    View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, ActivityIndicator, Alert,
} from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../constants/theme';
import {
    checkUsernameAvailability, setUsername as apiSetUsername, type UsernameRejectReason,
} from '../utils/authApi';
import { useAuthState } from '../state/authState';

/**
 * Required first-sign-in username picker. Shown after a new creator signs in
 * (Google/Apple) when the account has no username yet. Not dismissible — a
 * creator needs a @handle for their public profile + share links. Same logic
 * as the publish wall's username stage, extracted so the sign-in flow and the
 * publish wall share one component.
 */
export function CreateUsernameModal({ visible, onDone, onDismiss }: { visible: boolean; onDone: () => void; onDismiss?: () => void }) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();

    const [candidate, setCandidate] = useState('');
    const [busy, setBusy] = useState(false);
    const [checkState, setCheckState] = useState<{ available?: boolean; reason?: UsernameRejectReason; checking?: boolean }>({});
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (!visible) return;
        const trimmed = candidate.trim();
        if (trimmed.length < 3) { setCheckState({}); return; }
        if (debounceRef.current) clearTimeout(debounceRef.current);
        setCheckState((prev) => ({ ...prev, checking: true }));
        debounceRef.current = setTimeout(async () => {
            try {
                const out = await checkUsernameAvailability(trimmed);
                setCheckState({ available: out.available, reason: out.reason, checking: false });
            } catch {
                setCheckState({ available: false, reason: 'bad-format', checking: false });
            }
        }, 300);
        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [candidate, visible]);

    const submit = useCallback(async () => {
        const trimmed = candidate.trim();
        if (trimmed.length === 0 || busy) return;
        try {
            setBusy(true);
            const out = await apiSetUsername(trimmed);
            if (!out.ok) { setCheckState({ available: false, reason: out.reason }); return; }
            await useAuthState.getState().updateUser({ username: out.username });
            onDone();
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        } finally {
            setBusy(false);
        }
    }, [candidate, busy, onDone, t]);

    const reasonText = (r: UsernameRejectReason | undefined): string => {
        switch (r) {
            case 'taken': return t('basketTab.templates.usernameTaken');
            case 'reserved': return t('basketTab.templates.usernameReserved');
            case 'too-short': return t('basketTab.templates.usernameTooShort');
            case 'too-long': return t('basketTab.templates.usernameTooLong');
            case 'rate-limited': return t('basketTab.templates.usernameRateLimited');
            case 'bad-format': return t('basketTab.templates.usernameInvalid');
            default: return '';
        }
    };

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={() => {}} onDismiss={onDismiss}>
            <View style={styles.backdrop}>
                <View style={styles.sheet}>
                    <Text style={styles.title}>{t('basketTab.templates.usernamePromptTitle')}</Text>
                    <Text style={styles.body}>{t('basketTab.templates.usernamePromptBody')}</Text>

                    <View style={styles.inputRow}>
                        <Text style={styles.inputPrefix}>@</Text>
                        <TextInput
                            style={styles.input}
                            value={candidate}
                            onChangeText={setCandidate}
                            autoCapitalize="none"
                            autoCorrect={false}
                            placeholder={t('basketTab.templates.usernamePlaceholder')}
                            placeholderTextColor={colors.textMuted}
                            editable={!busy}
                        />
                        {checkState.checking && <ActivityIndicator size="small" color={colors.primary} />}
                        {!checkState.checking && checkState.available === true && (
                            <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                        )}
                        {!checkState.checking && checkState.available === false && (
                            <Ionicons name="close-circle" size={20} color={colors.error} />
                        )}
                    </View>
                    {checkState.reason && <Text style={styles.errorHint}>{reasonText(checkState.reason)}</Text>}

                    <TouchableOpacity
                        style={[styles.cta, (!checkState.available || busy) && styles.disabledBtn]}
                        onPress={submit}
                        disabled={!checkState.available || busy}
                        activeOpacity={0.85}
                    >
                        {busy
                            ? <ActivityIndicator color="#fff" />
                            : <Text style={styles.ctaText}>{t('basketTab.templates.usernameConfirm')}</Text>}
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 },
    sheet: { backgroundColor: c.cardBackground, borderRadius: 20, padding: 22 },
    title: { fontSize: 19, fontWeight: '800', color: c.textPrimary },
    body: { fontSize: 14, color: c.textSecondary, marginTop: 6, marginBottom: 18, lineHeight: 19 },
    inputRow: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 4,
    },
    inputPrefix: { fontSize: 16, color: c.textSecondary, fontWeight: '700' },
    input: { flex: 1, fontSize: 16, color: c.textPrimary, paddingVertical: 10 },
    errorHint: { fontSize: 12, color: c.error, marginTop: 6 },
    cta: { marginTop: 18, backgroundColor: c.primary, borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
    ctaText: { color: '#fff', fontSize: 16, fontWeight: '700' },
    disabledBtn: { opacity: 0.5 },
});
