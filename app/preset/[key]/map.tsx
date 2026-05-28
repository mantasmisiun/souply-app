import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    Platform,
} from 'react-native';
import MapView from 'react-native-maps';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useRef, useState, useMemo, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, type AppTheme } from '../../../constants/theme';
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

    // ── Editable title — same tap-to-edit pattern as basket [id].tsx ─────────
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
                    fontSize: 17,
                    fontWeight: '600',
                    color: colors.textPrimary,
                    minWidth: 160,
                    paddingVertical: 2,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.primary,
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

    // ── Shared: interactive map with fixed center pin ─────────────────────────
    const mapBlock = (
        <View style={styles.mapBlock}>
            <MapView
                ref={mapRef}
                style={StyleSheet.absoluteFillObject}
                initialRegion={initialRegion}
                onMapReady={handleMapReady}
                onRegionChangeComplete={r => setCenterCoords({ lat: r.latitude, lng: r.longitude })}
                showsUserLocation
                toolbarEnabled={false}
            />
            <View style={styles.pinWrapper} pointerEvents="none">
                <Ionicons name="location" size={44} color={colors.primary} style={styles.pinIcon} />
                <View style={styles.pinShadow} />
            </View>
            <View style={styles.mapHintBar} pointerEvents="none">
                <Text style={styles.mapHint}>Vilkite žemėlapį, kad patikslintumėte vietą</Text>
            </View>
        </View>
    );

    // ── Shared: search row ────────────────────────────────────────────────────
    const searchRow = (inline: boolean) => {
        const inner = (
            <View style={[styles.searchInputWrap, !inline && styles.searchInputWrapShadow]}>
                <TextInput
                    style={styles.searchInput}
                    value={searchText}
                    onChangeText={v => { setSearchText(v); setSearchError(null); }}
                    placeholder="Ieškoti adreso..."
                    placeholderTextColor={colors.textMuted}
                    returnKeyType="search"
                    onSubmitEditing={handleSearch}
                />
                {searching ? (
                    <ActivityIndicator size="small" color={colors.primary} style={styles.searchIconWrap} />
                ) : (
                    <TouchableOpacity onPress={handleSearch} style={styles.searchIconWrap}>
                        <Ionicons name="search" size={18} color={colors.textSecondary} />
                    </TouchableOpacity>
                )}
            </View>
        );
        // Floating (iOS): absolutely positioned overlay over the map
        // Inline (Android): plain block inside androidForm, full-width
        return inline
            ? inner
            : <View style={styles.searchRowFloating}>{inner}</View>;
    };

    // ── Shared: confirm panel ─────────────────────────────────────────────────
    const confirmPanel = (
        <View style={[styles.bottomPanel, { paddingBottom: Math.max(bottomInset, 16) }]}>
            <TouchableOpacity
                style={[styles.confirmBtn, (saving || !centerCoords) && styles.btnDisabled]}
                onPress={handleConfirm}
                disabled={saving || !centerCoords}
            >
                {saving
                    ? <ActivityIndicator color={colors.onPrimary} />
                    : <Text style={styles.confirmBtnText}>Patvirtinti vietą</Text>}
            </TouchableOpacity>
        </View>
    );

    // ── iOS: full-screen map, floating search bar ─────────────────────────────
    if (Platform.OS === 'ios') {
        return (
            <View style={styles.root}>
                <Stack.Screen options={{
                    headerTitle,
                    headerBackTitle: '',
                    headerTintColor: colors.textPrimary,
                    headerStyle: { backgroundColor: colors.cardBackground },
                    headerShadowVisible: false,
                }} />
                {mapBlock}
                {searchRow(false)}
                {searchError && (
                    <View style={styles.errorBubble}>
                        <Text style={styles.errorText}>{searchError}</Text>
                    </View>
                )}
                {confirmPanel}
            </View>
        );
    }

    // ── Android: search form strip above map ──────────────────────────────────
    return (
        <View style={[styles.root, { backgroundColor: colors.pageBackground }]}>
            <Stack.Screen options={{
                headerTitle,
                headerTintColor: colors.textPrimary,
                headerStyle: { backgroundColor: colors.cardBackground },
                headerShadowVisible: false,
            }} />
            <View style={styles.androidForm}>
                {searchRow(true)}
                {searchError && <Text style={styles.errorTextInline}>{searchError}</Text>}
            </View>
            {mapBlock}
            {confirmPanel}
        </View>
    );
}

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        root: { flex: 1 },

        // ── Map block ────────────────────────────────────────────────────────
        mapBlock: { flex: 1, overflow: 'hidden' },
        pinWrapper: {
            ...StyleSheet.absoluteFillObject,
            alignItems: 'center',
            justifyContent: 'center',
        },
        pinIcon: { marginTop: -22 },
        pinShadow: {
            width: 10,
            height: 5,
            borderRadius: 5,
            backgroundColor: 'rgba(0,0,0,0.18)',
            marginTop: -6,
        },
        mapHintBar: {
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            paddingVertical: 6,
            alignItems: 'center',
            backgroundColor: 'rgba(0,0,0,0.22)',
        },
        mapHint: { fontSize: 12, color: '#fff' },

        // ── iOS floating search row ──────────────────────────────────────────
        searchRowFloating: {
            position: 'absolute',
            top: 12,
            left: 12,
            right: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            zIndex: 10,
        },
        errorBubble: {
            position: 'absolute',
            top: 66,
            left: 12,
            right: 12,
            backgroundColor: c.error,
            borderRadius: 10,
            paddingHorizontal: 14,
            paddingVertical: 8,
            zIndex: 11,
        },
        errorText: { fontSize: 13, color: '#fff', fontWeight: '500' },

        androidForm: {
            paddingHorizontal: 12,
            paddingVertical: 10,
            backgroundColor: c.cardBackground,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: c.border,
        },
        errorTextInline: { fontSize: 12, color: c.error, marginTop: 4 },

        // ── Shared search input ──────────────────────────────────────────────
        searchInputWrap: {
            flexDirection: 'row',
            alignItems: 'center',
            height: 44,
            backgroundColor: c.cardBackground,
            borderRadius: 12,
            paddingHorizontal: 12,
        },
        searchInputWrapShadow: {
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.14,
            shadowRadius: 6,
            elevation: 4,
        },
        searchInput: { flex: 1, fontSize: 15, color: c.textPrimary },
        searchIconWrap: { paddingLeft: 6 },
        // ── Bottom confirm panel ─────────────────────────────────────────────
        bottomPanel: {
            backgroundColor: c.cardBackground,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: c.border,
            paddingHorizontal: 16,
            paddingTop: 12,
        },
        confirmBtn: {
            backgroundColor: c.primary,
            borderRadius: 14,
            paddingVertical: 15,
            alignItems: 'center',
        },
        btnDisabled: { opacity: 0.5 },
        confirmBtnText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },
    });
