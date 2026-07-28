import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import type MapView from 'react-native-maps';
import { RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, radius, spacing, type AppTheme } from '../constants/theme';
import { MapPickChrome } from './map/MapPickChrome';
import { MapBackButton } from './map/MapBackButton';
import { setPreset, type PresetKey, type LocationPreset } from '../utils/locationStorage';
import { geocodeAddress, reverseGeocode } from '../utils/nominatim';
import { tryGpsCoords, loadCachedCoords, VILNIUS_FALLBACK } from '../utils/location';

const DELTA = 0.012;

/**
 * Point-pick CHROME for a preset (Home/Work/Other), driving a map the CALLER
 * already owns (the shared store-results map, in pickMode).
 *
 * It keeps an AUTHORITATIVE pin coordinate (`pinCoordsRef`) that it sets itself
 * for every intentional change — entry framing, address search — and that the
 * map reports for tap / POI / real drag (`pickTarget`). The address line and the
 * saved value both read from that, NOT from the shared map's raw region settles
 * (those fire spuriously on the pick-mode / mapPadding transition and used to
 * hijack the address with the previous edit's location). The entry animate is
 * deferred one beat past that transition so the native camera command isn't
 * dropped. Render inside a full-screen `pointerEvents="box-none"` container over
 * the map so empty-area pans still reach the map while the chrome takes touches.
 */
export function PresetPickChrome({ mapRef, presetKey, label, existing, pickTarget, onDone, onCancel }: {
    mapRef: RefObject<MapView | null>;
    presetKey: PresetKey;
    label: string;
    existing: LocationPreset | null;
    /** An INTENTIONAL pin move reported by the map (tap / POI / real drag). */
    pickTarget?: { lat: number; lng: number } | null;
    onDone: (saved: boolean) => void;
    onCancel: () => void;
}) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();
    const { bottom: bottomInset } = useSafeAreaInsets();

    const nameInputRef = useRef<TextInput>(null);
    // Load the SAVED name when editing; fall back to the default label for a new one.
    const [name, setName] = useState(existing?.label ?? label ?? '');
    const [searchText, setSearchText] = useState('');
    const [searching, setSearching] = useState(false);
    const [saving, setSaving] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    // The displayed + saved address. Seeded from the preset so an edit shows its
    // own address immediately (and is never overwritten by a stray settle).
    const [address, setAddress] = useState<string | null>(existing?.address ?? null);
    const [addrLoading, setAddrLoading] = useState(false);

    // The pin's authoritative coordinate — what confirm saves. Seeded to the
    // preset's own coords for an edit; resolved to current location for a new one.
    const pinCoordsRef = useRef<{ lat: number; lng: number } | null>(
        existing?.address ? { lat: existing.lat, lng: existing.lng } : null,
    );
    const reqRef = useRef(0);

    const animateTo = useCallback((lat: number, lng: number) => {
        mapRef.current?.animateToRegion(
            { latitude: lat, longitude: lng, latitudeDelta: DELTA, longitudeDelta: DELTA }, 500);
    }, [mapRef]);

    /** Move the pin to (lat,lng) and, unless told to keep it, reverse-geocode its
     *  address. Request id drops stale responses; a failed lookup keeps the last. */
    const applyPin = useCallback((lat: number, lng: number, opts?: { keepAddress?: boolean }) => {
        pinCoordsRef.current = { lat, lng };
        if (opts?.keepAddress) return;
        const id = ++reqRef.current;
        setAddrLoading(true);
        reverseGeocode(lat, lng).then(addr => {
            if (id !== reqRef.current) return;
            setAddrLoading(false);
            if (addr) setAddress(addr);
        });
    }, []);

    /** Fallback live camera read (only if we somehow have no pin coord yet). */
    const getCenter = useCallback(async (): Promise<{ lat: number; lng: number } | null> => {
        try {
            const cam = await mapRef.current?.getCamera();
            const c = cam?.center;
            if (c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude)) {
                return { lat: c.latitude, lng: c.longitude };
            }
        } catch { /* getCamera can reject while the map tears down */ }
        return null;
    }, [mapRef]);

    // Frame the pin on entry:
    //  · a preset WITH a saved address → its own spot (address already seeded);
    //  · one WITHOUT → the user's TRUE current location (cached GPS, then a fresh
    //    read, then Vilnius) — never the calc origin — and reverse it.
    // Deferred one beat so the native animate isn't dropped by the pick-mode /
    // mapPadding transition happening in the same commit.
    useEffect(() => {
        let alive = true;
        const frame = async () => {
            if (existing?.address) { animateTo(existing.lat, existing.lng); return; }
            const cur = (await loadCachedCoords()) ?? (await tryGpsCoords()) ?? VILNIUS_FALLBACK;
            if (!alive) return;
            applyPin(cur.lat, cur.lng);
            animateTo(cur.lat, cur.lng);
        };
        const id = setTimeout(() => { if (alive) void frame(); }, 150);
        return () => { alive = false; clearTimeout(id); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Intentional map move (tap / POI / real drag) reported by the map → move the
    // pin + refresh the address. (Residual/programmatic settles never get here.)
    useEffect(() => {
        if (!pickTarget) return;
        applyPin(pickTarget.lat, pickTarget.lng);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pickTarget?.lat, pickTarget?.lng]);

    const handleSearch = async () => {
        const trimmed = searchText.trim();
        if (trimmed.length < 3) { setSearchError(t('presetMap.min3')); return; }
        setSearching(true);
        setSearchError(null);
        const result = await geocodeAddress(trimmed, pinCoordsRef.current ?? undefined);
        setSearching(false);
        if (!result) { setSearchError(t('presetMap.notFound')); return; }
        applyPin(result.lat, result.lng);   // pin + address, authoritative
        animateTo(result.lat, result.lng);
        // Weak match (no exact house number / wrong city) → warn it's approximate.
        setSearchError(result.precise ? null : t('presetMap.approx'));
    };

    const handleConfirm = async () => {
        // Save the authoritative pin coord + its address — both set by our own
        // actions, so they stay in sync and never reflect a stray settle.
        let coords = pinCoordsRef.current;
        if (!coords) { const c = await getCenter(); if (!c) return; coords = c; }
        setSaving(true);
        let addr = address?.trim() || null;
        if (!addr) {
            const rev = await reverseGeocode(coords.lat, coords.lng);
            addr = rev || existing?.address || null;
        }
        await setPreset(presetKey, {
            label: name.trim() || (label ?? ''),
            address: addr ?? undefined,
            lat: coords.lat,
            lng: coords.lng,
        });
        setSaving(false);
        onDone(true);
    };

    // Always-editable name (no tap-to-toggle): nothing remounts on focus, so
    // moving from the name to the search field focuses in one tap. The input
    // hugs its text so the card stays compact; the pencil focuses it and (via
    // selectTextOnFocus) selects the whole name so typing replaces it. Capped so
    // the compact card can't be blown out by a long name.
    const titleNode = (
        <View style={styles.nameRow}>
            <TextInput
                ref={nameInputRef}
                value={name}
                onChangeText={setName}
                onBlur={() => { if (!name.trim()) setName(label ?? ''); }}
                placeholder={label}
                placeholderTextColor={colors.textMuted}
                returnKeyType="done"
                maxLength={20}
                selectTextOnFocus
                style={styles.titleInput}
            />
            <Pressable onPress={() => nameInputRef.current?.focus()} hitSlop={10}>
                <Ionicons name="pencil" size={13} color={colors.textMuted} />
            </Pressable>
        </View>
    );

    return (
        <>
            {/* Centre pin over the shared map — pointerEvents none so pans pass
                straight through to the map underneath. */}
            <View style={styles.pinWrapper} pointerEvents="none">
                <Ionicons name="location" size={44} color={colors.primary} style={styles.pinIcon} />
                <View style={styles.pinShadow} />
            </View>
            <View style={[styles.mapHintBar, { bottom: Math.max(bottomInset, 16) + 64 }]} pointerEvents="none">
                <Text style={styles.mapHint}>{t('presetMap.dragHint')}</Text>
            </View>
            <MapPickChrome
                searchText={searchText}
                onSearchTextChange={v => { setSearchText(v); setSearchError(null); }}
                onSearch={handleSearch}
                searching={searching}
                searchError={searchError}
                searchPlaceholder={t('presetMap.searchPlaceholder')}
                confirmLabel={t('presetMap.confirm')}
                confirmEnabled={!saving}
                confirmLoading={saving}
                onConfirm={handleConfirm}
                titleNode={titleNode}
                subtitle={address ?? ''}
                subtitleLoading={addrLoading}
                headerLeft={<MapBackButton onPress={onCancel} />}
                confirmAlwaysVisible
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    pinWrapper: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
    pinIcon: { marginTop: -22 },
    pinShadow: { width: 10, height: 5, borderRadius: 5, backgroundColor: 'rgba(0,0,0,0.18)', marginTop: -6 },
    mapHintBar: {
        position: 'absolute', alignSelf: 'center',
        paddingVertical: 6, paddingHorizontal: spacing.lg,
        borderRadius: radius.pill, backgroundColor: 'rgba(0,0,0,0.35)',
    },
    mapHint: { fontSize: 12, color: '#fff' },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    // Reads as the title, but is a live input — no border until focused. Hugs its
    // text (flexShrink, no grow) so the card sizes to the name, not the row.
    titleInput: {
        ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary,
        flexShrink: 1, minWidth: 40, paddingVertical: 0,
    },
});
