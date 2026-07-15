import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    Modal,
    Platform,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import MapView, { Marker, MapPressEvent } from 'react-native-maps';
import { useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../constants/theme';
import { tryGpsCoords } from '../utils/location';
import { geocodeAddress, reverseGeocode } from '../utils/nominatim';
import { setPreset, type PresetKey, type LocationPreset } from '../utils/locationStorage';

interface Props {
    visible: boolean;
    presetKey: PresetKey;
    presetLabel: string;        // e.g. "Namai", "Darbas", "Kita"
    existing: LocationPreset | null;
    onSaved: () => void;
    onCancel: () => void;
}

type Phase = 'entry' | 'confirm';

const DELTA = 0.012; // ~1km radius zoom

export default function AddLocationPresetModal({
    visible,
    presetKey,
    presetLabel,
    existing,
    onSaved,
    onCancel,
}: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [phase, setPhase] = useState<Phase>(existing ? 'confirm' : 'entry');
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
        existing ? { lat: existing.lat, lng: existing.lng } : null,
    );
    const [name, setName] = useState(existing?.label ?? presetLabel);
    const [addressInput, setAddressInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reset = () => {
        setPhase(existing ? 'confirm' : 'entry');
        setCoords(existing ? { lat: existing.lat, lng: existing.lng } : null);
        setName(existing?.label ?? presetLabel);
        setAddressInput('');
        setLoading(false);
        setError(null);
    };

    const handleClose = () => {
        reset();
        onCancel();
    };

    // ---- GPS path ----
    const handleGps = async () => {
        setLoading(true);
        setError(null);
        const gps = await tryGpsCoords();
        if (!gps) {
            setLoading(false);
            setError('Nepavyko gauti vietos. Patikrinkite leidimus.');
            return;
        }
        const label = await reverseGeocode(gps.lat, gps.lng);
        setCoords({ lat: gps.lat, lng: gps.lng });
        if (label) setName(label.split(',')[0].trim());
        setLoading(false);
        setPhase('confirm');
    };

    // ---- Address path ----
    const handleAddressSearch = async () => {
        const trimmed = addressInput.trim();
        if (trimmed.length < 3) {
            setError('Įveskite bent 3 simbolius.');
            return;
        }
        setLoading(true);
        setError(null);
        const result = await geocodeAddress(trimmed);
        setLoading(false);
        if (!result) {
            setError('Adresas nerastas. Patikrinkite ir bandykite dar kartą.');
            return;
        }
        setCoords({ lat: result.lat, lng: result.lng });
        setName(result.displayName.split(',')[0].trim() || presetLabel);
        setPhase('confirm');
    };

    // ---- Map drag / tap (iOS only) ----
    const handleMapPress = async (e: MapPressEvent) => {
        const { latitude, longitude } = e.nativeEvent.coordinate;
        setCoords({ lat: latitude, lng: longitude });
        const label = await reverseGeocode(latitude, longitude);
        if (label) setName(label.split(',')[0].trim());
    };

    // ---- Save ----
    const handleSave = async () => {
        if (!coords) return;
        setLoading(true);
        await setPreset(presetKey, { label: name.trim() || presetLabel, lat: coords.lat, lng: coords.lng });
        setLoading(false);
        reset();
        onSaved();
    };

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
            <View style={[styles.root, { backgroundColor: colors.pageBackground }]}>
                {/* Header */}
                <View style={styles.header}>
                    <TouchableOpacity onPress={phase === 'confirm' && !existing ? () => setPhase('entry') : handleClose} style={styles.backBtn}>
                        <Ionicons name={phase === 'confirm' && !existing ? 'arrow-back' : 'close'} size={22} color={colors.textPrimary} />
                    </TouchableOpacity>
                    <Text style={styles.headerTitle}>{existing ? 'Redaguoti vietą' : `Pridėti: ${presetLabel}`}</Text>
                    <View style={{ width: 36 }} />
                </View>

                {phase === 'entry' ? (
                    <KeyboardAwareScrollView contentContainerStyle={styles.entryContent} keyboardShouldPersistTaps="handled" bottomOffset={16}>
                        {/* GPS button */}
                        <TouchableOpacity style={styles.gpsButton} onPress={handleGps} disabled={loading}>
                            {loading ? (
                                <MaterialProgress color={colors.onPrimary} />
                            ) : (
                                <>
                                    <Ionicons name="locate" size={20} color={colors.onPrimary} />
                                    <Text style={styles.gpsButtonText}>Naudoti dabartinę vietą</Text>
                                </>
                            )}
                        </TouchableOpacity>

                        <View style={styles.dividerRow}>
                            <View style={styles.dividerLine} />
                            <Text style={styles.dividerText}>arba</Text>
                            <View style={styles.dividerLine} />
                        </View>

                        {/* Address search */}
                        <Text style={styles.label}>Įvesti adresą</Text>
                        <TextInput
                            style={styles.input}
                            value={addressInput}
                            onChangeText={v => { setAddressInput(v); setError(null); }}
                            placeholder="Pvz. Gedimino pr. 9, Vilnius"
                            placeholderTextColor={colors.textMuted}
                            returnKeyType="search"
                            onSubmitEditing={handleAddressSearch}
                            editable={!loading}
                        />
                        {error && <Text style={styles.errorText}>{error}</Text>}
                        <TouchableOpacity
                            style={[styles.searchButton, loading && styles.buttonDisabled]}
                            onPress={handleAddressSearch}
                            disabled={loading}
                        >
                            <Text style={styles.searchButtonText}>Ieškoti</Text>
                        </TouchableOpacity>
                    </KeyboardAwareScrollView>
                ) : (
                    <View style={styles.confirmContent}>
                        {/* Map — iOS only. Android MapView inside Modal crashes with
                            IllegalStateException (failed to insert native view into parent).
                            On Android we show the resolved address as text instead. */}
                        {Platform.OS === 'ios' && coords ? (
                            <MapView
                                style={styles.map}
                                initialRegion={{
                                    latitude: coords.lat,
                                    longitude: coords.lng,
                                    latitudeDelta: DELTA,
                                    longitudeDelta: DELTA,
                                }}
                                onPress={handleMapPress}
                            >
                                <Marker
                                    coordinate={{ latitude: coords.lat, longitude: coords.lng }}
                                    draggable
                                    onDragEnd={e => handleMapPress(e as any)}
                                    pinColor={colors.primary}
                                />
                            </MapView>
                        ) : (
                            <View style={styles.coordsPlaceholder}>
                                <Ionicons name="location" size={40} color={colors.primary} />
                                <Text style={styles.coordsText}>
                                    {coords
                                        ? `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`
                                        : '—'}
                                </Text>
                                <Text style={styles.coordsHint}>Vieta nustatyta. Patikrinkite pavadinimą ir išsaugokite.</Text>
                            </View>
                        )}

                        {Platform.OS === 'ios' && (
                            <Text style={styles.mapHint}>Palieskite žemėlapį arba vilkite žymeklį, kad patikslintumėte vietą</Text>
                        )}

                        {/* Name field */}
                        <View style={styles.confirmForm}>
                            <Text style={styles.label}>Pavadinimas</Text>
                            <TextInput
                                style={styles.input}
                                value={name}
                                onChangeText={setName}
                                placeholder={presetLabel}
                                placeholderTextColor={colors.textMuted}
                                maxLength={40}
                            />
                            {error && <Text style={styles.errorText}>{error}</Text>}
                            <TouchableOpacity
                                style={[styles.saveButton, loading && styles.buttonDisabled]}
                                onPress={handleSave}
                                disabled={loading || !coords}
                            >
                                {loading ? (
                                    <MaterialProgress color={colors.onPrimary} />
                                ) : (
                                    <Text style={styles.saveButtonText}>Išsaugoti</Text>
                                )}
                            </TouchableOpacity>
                        </View>
                    </View>
                )}
            </View>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        root: { flex: 1 },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingTop: Platform.OS === 'ios' ? 56 : 16,
            paddingBottom: 12,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: c.border,
        },
        backBtn: { width: 36, alignItems: 'flex-start' },
        headerTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
        entryContent: { padding: 24, gap: 14 },
        gpsButton: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            backgroundColor: c.primary,
            borderRadius: 14,
            paddingVertical: 16,
        },
        gpsButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },
        dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
        dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: c.border },
        dividerText: { fontSize: 13, color: c.textMuted },
        label: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
        input: {
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 11,
            fontSize: 15,
            color: c.textPrimary,
            backgroundColor: c.cardBackground,
        },
        errorText: { fontSize: 12, color: c.error },
        searchButton: {
            backgroundColor: c.surfaceMuted,
            borderRadius: 10,
            paddingVertical: 13,
            alignItems: 'center',
        },
        searchButtonText: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
        buttonDisabled: { opacity: 0.5 },
        confirmContent: { flex: 1 },
        map: { flex: 1 },
        coordsPlaceholder: {
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            paddingHorizontal: 32,
        },
        coordsText: {
            fontSize: 14,
            color: c.textSecondary,
            fontVariant: ['tabular-nums'],
        },
        coordsHint: {
            fontSize: 13,
            color: c.textMuted,
            textAlign: 'center',
            lineHeight: 20,
        },
        mapHint: {
            fontSize: 12,
            color: c.textMuted,
            textAlign: 'center',
            paddingHorizontal: 20,
            paddingVertical: 8,
            backgroundColor: c.pageBackground,
        },
        confirmForm: {
            padding: 20,
            gap: 10,
            backgroundColor: c.pageBackground,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: c.border,
        },
        saveButton: {
            backgroundColor: c.primary,
            borderRadius: 14,
            paddingVertical: 15,
            alignItems: 'center',
            marginTop: 4,
        },
        saveButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },
    });
