import { View, Text, TouchableOpacity, StyleSheet, Modal, TextInput, ActivityIndicator } from 'react-native';
import { useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../constants/theme';
import { geocodeAddress, type UserCoords, VILNIUS_FALLBACK } from '../utils/location';

interface LocationPromptModalProps {
    visible: boolean;
    onResolved: (coords: UserCoords) => void;
    onCancel: () => void;
}

/**
 * Address fallback shown when GPS permission is denied or fails. User
 * types an address → backend geocodes → we return UserCoords to the
 * caller. On geocode failure, offers a retry or "Use Vilnius centre".
 *
 * Wraps the frustration of a location-dead calc flow into one deterministic
 * prompt: the user always leaves with valid coordinates (typed address,
 * or Vilnius fallback) and the calc never silently uses stale data.
 */
export default function LocationPromptModal({
    visible,
    onResolved,
    onCancel,
}: LocationPromptModalProps) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [address, setAddress] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reset = () => {
        setAddress('');
        setLoading(false);
        setError(null);
    };

    const handleSubmit = async () => {
        const trimmed = address.trim();
        if (trimmed.length < 3) {
            setError('Įveskite bent keletą simbolių');
            return;
        }
        setLoading(true);
        setError(null);
        const result = await geocodeAddress(trimmed);
        setLoading(false);
        if (!result) {
            setError('Nepavyko rasti adreso. Pabandykite patikslinti arba naudokite Vilniaus centrą.');
            return;
        }
        onResolved(result);
        reset();
    };

    const useVilniusFallback = () => {
        onResolved(VILNIUS_FALLBACK);
        reset();
    };

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onCancel}
        >
            <View style={styles.overlay}>
                <View style={styles.card}>
                    <View style={styles.headerRow}>
                        <Ionicons name="location-outline" size={22} color={colors.primary} />
                        <Text style={styles.title}>Įveskite adresą</Text>
                    </View>
                    <Text style={styles.sub}>
                        Be vietos informacijos palyginimas būtų tik apytikslis. Įveskite namo
                        adresą arba tik miestą — naudosime tai, kad rastume artimiausias
                        parduotuves.
                    </Text>

                    <TextInput
                        style={styles.input}
                        value={address}
                        onChangeText={setAddress}
                        placeholder="pvz. Vilniaus g. 10, Kaunas"
                        placeholderTextColor={colors.textMuted}
                        autoFocus
                        onSubmitEditing={handleSubmit}
                        editable={!loading}
                    />

                    {error && <Text style={styles.error}>{error}</Text>}

                    <View style={styles.actionRow}>
                        <TouchableOpacity
                            style={[styles.button, styles.buttonSecondary]}
                            onPress={useVilniusFallback}
                            disabled={loading}
                        >
                            <Text style={styles.buttonSecondaryText}>Naudoti Vilnių</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.button}
                            onPress={handleSubmit}
                            disabled={loading}
                        >
                            {loading ? (
                                <ActivityIndicator size="small" color={colors.onPrimary} />
                            ) : (
                                <Text style={styles.buttonText}>Tęsti</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        overlay: {
            flex: 1,
            backgroundColor: c.overlayBackdrop,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
        },
        card: {
            backgroundColor: c.cardBackground,
            borderRadius: 16,
            padding: 22,
            width: '100%',
            maxWidth: 420,
            gap: 10,
        },
        headerRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
        },
        title: {
            fontSize: 17,
            fontWeight: '700',
            color: c.textPrimary,
        },
        sub: {
            fontSize: 13,
            color: c.textSecondary,
            lineHeight: 18,
        },
        input: {
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontSize: 14,
            color: c.textPrimary,
            marginTop: 6,
        },
        error: {
            fontSize: 12,
            color: c.error,
        },
        actionRow: {
            flexDirection: 'row',
            justifyContent: 'flex-end',
            gap: 10,
            marginTop: 6,
        },
        button: {
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 10,
            backgroundColor: c.primary,
            minWidth: 96,
            alignItems: 'center',
        },
        buttonText: {
            color: c.onPrimary,
            fontWeight: '600',
            fontSize: 14,
        },
        buttonSecondary: {
            backgroundColor: c.cardBackground,
            borderWidth: 1,
            borderColor: c.border,
        },
        buttonSecondaryText: {
            color: c.textSecondary,
            fontWeight: '600',
            fontSize: 14,
        },
    });
