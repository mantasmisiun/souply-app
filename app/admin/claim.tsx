import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../constants/theme';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';

type State = 'loading' | 'email_sent' | 'invalid' | 'error';

export default function AdminClaimScreen() {
    const colors = useTheme();
    const router = useRouter();
    const { t: token } = useLocalSearchParams<{ t: string }>();
    const [state, setState] = useState<State>('loading');
    const [email, setEmail] = useState('');

    useEffect(() => {
        if (!token) { setState('invalid'); return; }
        let cancelled = false;

        (async () => {
            try {
                const userId = await getUserId();
                const res = await fetch(`${API_BASE_URL}/api/admin-invite/claim`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, userId }),
                });
                if (cancelled) return;
                if (res.status === 410) { setState('invalid'); return; }
                if (!res.ok) { setState('error'); return; }
                const body = await res.json();
                setEmail(body.email ?? '');
                setState('email_sent');
            } catch {
                if (!cancelled) setState('error');
            }
        })();

        return () => { cancelled = true; };
    }, [token]);

    const icon = state === 'email_sent' ? 'mail-outline'
               : state === 'invalid'    ? 'close-circle-outline'
               : state === 'error'      ? 'alert-circle-outline'
               : null;

    const iconColor = state === 'email_sent' ? colors.primary
                    : colors.textMuted;

    return (
        <View style={[styles.container, { backgroundColor: colors.pageBackground }]}>
            <Stack.Screen options={{ title: 'Admin access', headerBackTitle: 'Back' }} />

            {state === 'loading' && (
                <>
                    <MaterialProgress size="large" color={colors.primary} />
                    <Text style={[styles.body, { color: colors.textSecondary }]}>
                        Verifying invite…
                    </Text>
                </>
            )}

            {state === 'email_sent' && (
                <>
                    <Ionicons name="mail-outline" size={64} color={colors.primary} />
                    <Text style={[styles.title, { color: colors.textPrimary }]}>Check your email</Text>
                    <Text style={[styles.body, { color: colors.textSecondary }]}>
                        A verification link has been sent to{'\n'}
                        <Text style={{ fontWeight: '600', color: colors.textPrimary }}>{email}</Text>
                        {'\n\n'}Tap the link in that email to activate your admin account.
                    </Text>
                </>
            )}

            {state === 'invalid' && (
                <>
                    <Ionicons name="close-circle-outline" size={64} color={colors.textMuted} />
                    <Text style={[styles.title, { color: colors.textPrimary }]}>Link expired or invalid</Text>
                    <Text style={[styles.body, { color: colors.textSecondary }]}>
                        This invite has expired or was already used.{'\n'}Ask the operator to generate a new QR code.
                    </Text>
                </>
            )}

            {state === 'error' && (
                <>
                    <Ionicons name="alert-circle-outline" size={64} color={colors.textMuted} />
                    <Text style={[styles.title, { color: colors.textPrimary }]}>Something went wrong</Text>
                    <Text style={[styles.body, { color: colors.textSecondary }]}>
                        Could not reach the server. Check your connection and try scanning again.
                    </Text>
                </>
            )}

            {(state === 'invalid' || state === 'error') && (
                <TouchableOpacity
                    style={[styles.button, { backgroundColor: colors.primary }]}
                    onPress={() => router.replace('/(tabs)' as any)}
                >
                    <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Go home</Text>
                </TouchableOpacity>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        gap: 16,
    },
    title: {
        fontSize: 20,
        fontWeight: '700',
        textAlign: 'center',
    },
    body: {
        fontSize: 15,
        lineHeight: 22,
        textAlign: 'center',
    },
    button: {
        marginTop: 8,
        paddingHorizontal: 32,
        paddingVertical: 13,
        borderRadius: 12,
    },
    buttonText: {
        fontSize: 15,
        fontWeight: '600',
    },
});
