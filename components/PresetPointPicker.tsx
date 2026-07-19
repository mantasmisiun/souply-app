import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import MapView from 'react-native-maps';
import { useRef, useState, useMemo, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, radius, spacing, type AppTheme } from '../constants/theme';
import { MapHost } from './map/MapHost';
import { GlassIconButton } from './GlassIconButton';
import { setPreset, type PresetKey, type LocationPreset } from '../utils/locationStorage';
import { geocodeAddress, reverseGeocode } from '../utils/nominatim';
import { tryGpsCoords, VILNIUS_FALLBACK } from '../utils/location';

const DELTA = 0.012;

/**
 * Home/work/other point picker — a full-bleed one-map host in a permanent
 * 'point' pick session (centre pin, viewport-biased address search,
 * tap-to-rename title, floating confirm). Extracted from the /preset/[key]/map
 * route so it can ALSO be rendered inline (as an overlay) on the store map's
 * "define a location" flow. `onDone(true)` = saved, `onCancel()` = backed out.
 */
export function PresetPointPicker({ presetKey, label, existing, onDone, onCancel }: {
    presetKey: PresetKey;
    label: string;
    existing: LocationPreset | null;
    onDone: (saved: boolean) => void;
    onCancel: () => void;
}) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();
    const { bottom: bottomInset } = useSafeAreaInsets();

    const hasInitial = existing != null;
    const mapRef = useRef<MapView>(null);
    const nameInputRef = useRef<TextInput>(null);

    const [centerCoords, setCenterCoords] = useState<{ lat: number; lng: number } | null>(
        hasInitial ? { lat: existing!.lat, lng: existing!.lng } : null,
    );
    const [name, setName] = useState(label ?? '');
    const [editingName, setEditingName] = useState(false);
    const [searchText, setSearchText] = useState('');
    const [searching, setSearching] = useState(false);
    const [saving, setSaving] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [mapReady, setMapReady] = useState(false);

    const animateTo = (lat: number, lng: number) =>
        mapRef.current?.animateToRegion({ latitude: lat, longitude: lng, latitudeDelta: DELTA, longitudeDelta: DELTA }, 600);

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
        if (trimmed.length < 3) { setSearchError(t('presetMap.min3')); return; }
        setSearching(true);
        setSearchError(null);
        const result = await geocodeAddress(trimmed, centerCoords ?? undefined);
        setSearching(false);
        if (!result) { setSearchError(t('presetMap.notFound')); return; }
        setCenterCoords({ lat: result.lat, lng: result.lng });
        animateTo(result.lat, result.lng);
    };

    const handleConfirm = async () => {
        if (!centerCoords) return;
        setSaving(true);
        let address = searchText.trim() || undefined;
        if (!address) {
            const rev = await reverseGeocode(centerCoords.lat, centerCoords.lng);
            address = rev?.split(',')[0].trim() || undefined;
        }
        await setPreset(presetKey, {
            label: name.trim() || (label ?? ''),
            address,
            lat: centerCoords.lat,
            lng: centerCoords.lng,
        });
        setSaving(false);
        onDone(true);
    };

    const initialRegion = {
        latitude: hasInitial ? existing!.lat : VILNIUS_FALLBACK.lat,
        longitude: hasInitial ? existing!.lng : VILNIUS_FALLBACK.lng,
        latitudeDelta: DELTA,
        longitudeDelta: DELTA,
    };

    const titleNode = editingName ? (
        <TextInput
            ref={nameInputRef}
            defaultValue={name}
            onChangeText={setName}
            onEndEditing={e => { setName(e.nativeEvent.text || label || ''); setEditingName(false); }}
            onBlur={() => setEditingName(false)}
            placeholder={label}
            placeholderTextColor={colors.textMuted}
            autoFocus
            style={styles.titleInput}
        />
    ) : (
        <TouchableOpacity onPress={() => setEditingName(true)} activeOpacity={0.6}>
            <Text style={styles.titleText} numberOfLines={1}>{name || label}</Text>
        </TouchableOpacity>
    );

    return (
        <MapHost
            mapRef={mapRef}
            initialRegion={initialRegion}
            onMapReady={handleMapReady}
            mapReady={mapReady}
            onRegionChangeComplete={r => setCenterCoords({ lat: r.latitude, lng: r.longitude })}
            pick={{
                kind: 'point',
                titleNode,
                headerLeft: <GlassIconButton icon="chevron-back" glass solid onPress={onCancel} size={22} />,
                confirmLabel: t('presetMap.confirm'),
                confirmEnabled: !!centerCoords,
                confirmLoading: saving,
                onConfirm: handleConfirm,
                onCancel,
                search: {
                    text: searchText,
                    onChangeText: v => { setSearchText(v); setSearchError(null); },
                    onSubmit: handleSearch,
                    searching,
                    error: searchError,
                    placeholder: t('presetMap.searchPlaceholder'),
                },
                overlay: (
                    <>
                        <View style={styles.pinWrapper} pointerEvents="none">
                            <Ionicons name="location" size={44} color={colors.primary} style={styles.pinIcon} />
                            <View style={styles.pinShadow} />
                        </View>
                        <View style={[styles.mapHintBar, { bottom: Math.max(bottomInset, 16) + 64 }]} pointerEvents="none">
                            <Text style={styles.mapHint}>{t('presetMap.dragHint')}</Text>
                        </View>
                    </>
                ),
            }}
        />
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
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
