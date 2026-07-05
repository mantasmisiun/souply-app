import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import MapView from 'react-native-maps';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useRef, useState, useMemo, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, typography, radius, spacing, type AppTheme } from '../../../constants/theme';
import { MapPickerScaffold } from '../../../components/map/MapPickerScaffold';
import { GlassIconButton } from '../../../components/GlassIconButton';
import { setPreset, type PresetKey } from '../../../utils/locationStorage';
import { geocodeAddress, reverseGeocode } from '../../../utils/nominatim';
import { tryGpsCoords, VILNIUS_FALLBACK } from '../../../utils/location';

const DELTA = 0.012;

export default function PresetMapScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const { bottom: bottomInset } = useSafeAreaInsets();

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
    const [mapReady, setMapReady] = useState(false);

    const animateTo = (lat: number, lng: number) =>
        mapRef.current?.animateToRegion(
            { latitude: lat, longitude: lng, latitudeDelta: DELTA, longitudeDelta: DELTA },
            600,
        );

    const handleMapReady = useCallback(async () => {
        setMapReady(true);
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

    // Tap-to-rename title, now living INSIDE the floating glass chip (same pattern
    // as basket [id].tsx, restyled for the chip's fixed 40pt height).
    const titleNode = editingName
        ? (
            <TextInput
                ref={nameInputRef}
                defaultValue={name}
                onChangeText={setName}
                onEndEditing={e => { setName(e.nativeEvent.text || presetLabel || ''); setEditingName(false); }}
                onBlur={() => setEditingName(false)}
                placeholder={presetLabel}
                placeholderTextColor={colors.textMuted}
                autoFocus
                style={styles.titleInput}
            />
        )
        : (
            <TouchableOpacity onPress={() => setEditingName(true)} activeOpacity={0.6}>
                <Text style={styles.titleText} numberOfLines={1}>{name || presetLabel}</Text>
            </TouchableOpacity>
        );

    return (
        <>
            {/* Full-bleed glass-chrome map (same shell as the store-resolution screen):
                no native header — the map runs edge to edge, the back chevron + title
                chip + search float over it in liquid glass. */}
            <Stack.Screen options={{ headerShown: false }} />
            <MapPickerScaffold
                glassChrome
                headerLeft={
                    <GlassIconButton icon="chevron-back" glass onPress={() => router.back()} size={22} />
                }
                titleNode={titleNode}
                mapRef={mapRef}
                initialRegion={initialRegion}
                onMapReady={handleMapReady}
                mapReady={mapReady}
                onRegionChangeComplete={r => setCenterCoords({ lat: r.latitude, lng: r.longitude })}
                searchText={searchText}
                onSearchTextChange={v => { setSearchText(v); setSearchError(null); }}
                onSearch={handleSearch}
                searching={searching}
                searchError={searchError}
                searchPlaceholder="Ieškoti adreso..."
                confirmLabel="Patvirtinti vietą"
                confirmEnabled={!!centerCoords}
                confirmAlwaysVisible
                confirmLoading={saving}
                onConfirm={handleConfirm}
                overlay={
                    <>
                        <View style={styles.pinWrapper} pointerEvents="none">
                            <Ionicons name="location" size={44} color={colors.primary} style={styles.pinIcon} />
                            <View style={styles.pinShadow} />
                        </View>
                        {/* Drag hint floats above the confirm pill (the map is full-bleed
                            now, so bottom:0 would put it under the button/home indicator). */}
                        <View style={[styles.mapHintBar, { bottom: Math.max(bottomInset, 16) + 64 }]} pointerEvents="none">
                            <Text style={styles.mapHint}>Vilkite žemėlapį, kad patikslintumėte vietą</Text>
                        </View>
                    </>
                }
            />
        </>
    );
}

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        pinWrapper: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
        pinIcon: { marginTop: -22 },
        pinShadow: { width: 10, height: 5, borderRadius: 5, backgroundColor: 'rgba(0,0,0,0.18)', marginTop: -6 },
        mapHintBar: {
            position: 'absolute', alignSelf: 'center',
            paddingVertical: 6, paddingHorizontal: spacing.lg,
            borderRadius: radius.pill, backgroundColor: 'rgba(0,0,0,0.35)',
        },
        mapHint: { fontSize: 12, color: '#fff' },
        titleText: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary },
        titleInput: {
            ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary,
            minWidth: 140, paddingVertical: 0,
            borderBottomWidth: 1, borderBottomColor: c.primary,
        },
    });
