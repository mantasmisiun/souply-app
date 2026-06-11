import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import MapView from 'react-native-maps';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useRef, useState, useMemo, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { MapPickerScaffold } from '../../../components/map/MapPickerScaffold';
import { setPreset, type PresetKey } from '../../../utils/locationStorage';
import { geocodeAddress, reverseGeocode } from '../../../utils/nominatim';
import { tryGpsCoords, VILNIUS_FALLBACK } from '../../../utils/location';

const DELTA = 0.012;

export default function PresetMapScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();

    const { key: presetKey, label: presetLabel, lat: latParam, lng: lngParam } = useLocalSearchParams<{
        key: string;
        label: string;
        lat?: string;
        lng?: string;
    }>();

    const initialLat = latParam ? parseFloat(latParam) : null;
    const initialLng = lngParam ? parseFloat(lngParam) : null;
    const hasInitial = initialLat !== null && initialLng !== null && !isNaN(initialLat) && !isNaN(initialLng);

    const mapRef = useRef<MapView>(null);
    const nameInputRef = useRef<TextInput>(null);

    const [centerCoords, setCenterCoords] = useState<{ lat: number; lng: number } | null>(
        hasInitial ? { lat: initialLat!, lng: initialLng! } : null,
    );
    const [name, setName] = useState(presetLabel ?? '');
    const [editingName, setEditingName] = useState(false);
    const [searchText, setSearchText] = useState('');
    const [searching, setSearching] = useState(false);
    const [saving, setSaving] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);

    const animateTo = (lat: number, lng: number) =>
        mapRef.current?.animateToRegion(
            { latitude: lat, longitude: lng, latitudeDelta: DELTA, longitudeDelta: DELTA },
            600,
        );

    const handleMapReady = useCallback(async () => {
        if (hasInitial) return;
        const gps = await tryGpsCoords();
        const target = gps ?? VILNIUS_FALLBACK;
        setCenterCoords({ lat: target.lat, lng: target.lng });
        animateTo(target.lat, target.lng);
    }, [hasInitial]);

    const handleSearch = async () => {
        const trimmed = searchText.trim();
        if (trimmed.length < 3) { setSearchError('Įveskite bent 3 simbolius'); return; }
        setSearching(true);
        setSearchError(null);
        const result = await geocodeAddress(trimmed);
        setSearching(false);
        if (!result) { setSearchError('Adresas nerastas'); return; }
        setCenterCoords({ lat: result.lat, lng: result.lng });
        animateTo(result.lat, result.lng);
    };

    const handleConfirm = async () => {
        if (!centerCoords) return;
        setSaving(true);
        // If the user dragged the map after the last search/GPS, reverse geocode once more
        let address = searchText.trim() || undefined;
        if (!address) {
            const label = await reverseGeocode(centerCoords.lat, centerCoords.lng);
            address = label?.split(',')[0].trim() || undefined;
        }
        await setPreset(presetKey as PresetKey, {
            label: name.trim() || (presetLabel ?? ''),
            address,
            lat: centerCoords.lat,
            lng: centerCoords.lng,
        });
        setSaving(false);
        router.back();
    };

    const initialRegion = {
        latitude: hasInitial ? initialLat! : VILNIUS_FALLBACK.lat,
        longitude: hasInitial ? initialLng! : VILNIUS_FALLBACK.lng,
        latitudeDelta: DELTA,
        longitudeDelta: DELTA,
    };

    // Editable title — same tap-to-edit pattern as basket [id].tsx.
    const headerTitle = editingName
        ? () => (
            <TextInput
                ref={nameInputRef}
                defaultValue={name}
                onChangeText={setName}
                onEndEditing={e => { setName(e.nativeEvent.text || presetLabel || ''); setEditingName(false); }}
                onBlur={() => setEditingName(false)}
                placeholder={presetLabel}
                placeholderTextColor={colors.textMuted}
                autoFocus
                style={{
                    fontSize: 17, fontWeight: '600', color: colors.textPrimary,
                    minWidth: 160, paddingVertical: 2,
                    borderBottomWidth: 1, borderBottomColor: colors.primary,
                }}
            />
        )
        : () => (
            <TouchableOpacity onPress={() => setEditingName(true)} activeOpacity={0.6}>
                <Text style={{ fontSize: 17, fontWeight: '600', color: colors.textPrimary }} numberOfLines={1}>
                    {name || presetLabel}
                </Text>
            </TouchableOpacity>
        );

    return (
        <>
            <Stack.Screen options={{
                headerTitle,
                headerBackTitle: '',
                headerTintColor: colors.primary,
                headerStyle: { backgroundColor: colors.cardBackground },
                headerShadowVisible: false,
            }} />
            <MapPickerScaffold
                mapRef={mapRef}
                initialRegion={initialRegion}
                onMapReady={handleMapReady}
                onRegionChangeComplete={r => setCenterCoords({ lat: r.latitude, lng: r.longitude })}
                searchText={searchText}
                onSearchTextChange={v => { setSearchText(v); setSearchError(null); }}
                onSearch={handleSearch}
                searching={searching}
                searchError={searchError}
                searchPlaceholder="Ieškoti adreso..."
                confirmLabel="Patvirtinti vietą"
                confirmEnabled={!!centerCoords}
                confirmLoading={saving}
                onConfirm={handleConfirm}
                overlay={
                    <>
                        <View style={styles.pinWrapper} pointerEvents="none">
                            <Ionicons name="location" size={44} color={colors.primary} style={styles.pinIcon} />
                            <View style={styles.pinShadow} />
                        </View>
                        <View style={styles.mapHintBar} pointerEvents="none">
                            <Text style={styles.mapHint}>Vilkite žemėlapį, kad patikslintumėte vietą</Text>
                        </View>
                    </>
                }
            />
        </>
    );
}

const makeStyles = (_c: AppTheme) =>
    StyleSheet.create({
        pinWrapper: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
        pinIcon: { marginTop: -22 },
        pinShadow: { width: 10, height: 5, borderRadius: 5, backgroundColor: 'rgba(0,0,0,0.18)', marginTop: -6 },
        mapHintBar: {
            position: 'absolute', bottom: 0, left: 0, right: 0,
            paddingVertical: 6, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.22)',
        },
        mapHint: { fontSize: 12, color: '#fff' },
    });
