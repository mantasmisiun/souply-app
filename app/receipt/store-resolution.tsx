import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import MapView, { Marker, type Region } from 'react-native-maps';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, radius, typography, type AppTheme } from '../../constants/theme';
import { MapPickerScaffold } from '../../components/map/MapPickerScaffold';
import { ChainLogoChip } from '../../components/ChainLogoChip';
import { chainPinImage } from '../../utils/chainLogoAssets';
import { chainBrandName } from '../../utils/chainBrandName';
import { geocodeAddress } from '../../utils/nominatim';
import { tryGpsCoords, VILNIUS_FALLBACK } from '../../utils/location';
import { getStoreResolutionRequest, completeStoreResolution } from '../../utils/storeResolution';
import { API_BASE_URL } from '../../config/api';

interface ChainStore {
    id: number;
    name: string;
    address: string;
    latitude: number;
    longitude: number;
}

// Wide span for the initial GPS/Vilnius fallback (no address yet); CLOSE_DELTA
// is the tight zoom we snap to once an actual address geocodes, so the user
// lands right on the cluster of chain pins around it rather than a city view.
const DELTA = 0.05;
const CLOSE_DELTA = 0.008;

/**
 * Recoverable `store_unrecognized` fallback: the chain is known (so its logo is
 * shown, fixed) but the store wasn't matched. The user searches/zooms the map
 * and taps one of the chain's store pins; Confirm hands the chosen store back
 * to the receipt pipeline (via storeResolution handoff) which then continues.
 */
export default function StoreResolutionScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const mapRef = useRef<MapView>(null);

    const req = useMemo(() => getStoreResolutionRequest(), []);
    const [stores, setStores] = useState<ChainStore[]>([]);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [searchText, setSearchText] = useState(req?.ocrAddress ?? '');
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const completedRef = useRef(false);

    // Fetch the chain's stores + centre the map on the OCR address (else GPS/Vilnius).
    useEffect(() => {
        if (!req) { router.back(); return; }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/api/stores/chain/${req.chainId}`);
                const data = await res.json();
                if (cancelled) return;
                const parsed: ChainStore[] = (Array.isArray(data) ? data : [])
                    .map((s: any) => ({
                        id: s.id,
                        name: s.name,
                        address: s.address,
                        latitude: parseFloat(s.latitude),
                        longitude: parseFloat(s.longitude),
                    }))
                    .filter((s: ChainStore) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude));
                setStores(parsed);
            } catch { /* leave empty — the map still works for search */ }
        })();
        (async () => {
            let center: { lat: number; lng: number } | null = null;
            let geocoded = false;
            if (req.ocrAddress) { center = await geocodeAddress(req.ocrAddress); geocoded = !!center; }
            if (!center) center = await tryGpsCoords();
            const c = center ?? VILNIUS_FALLBACK;
            const delta = geocoded ? CLOSE_DELTA : DELTA;
            if (!cancelled) {
                mapRef.current?.animateToRegion(
                    { latitude: c.lat, longitude: c.lng, latitudeDelta: delta, longitudeDelta: delta },
                    600,
                );
            }
        })();
        return () => { cancelled = true; };
    }, [req, router]);

    // If the screen is dismissed (back) without confirming, cancel the handoff
    // so the awaiting pipeline doesn't hang.
    useEffect(() => () => { if (!completedRef.current) completeStoreResolution(null); }, []);

    const onSearch = useCallback(async () => {
        const q = searchText.trim();
        if (q.length < 3) { setSearchError(t('storeResolution.minChars')); return; }
        setSearching(true);
        setSearchError(null);
        const r = await geocodeAddress(q);
        setSearching(false);
        if (!r) { setSearchError(t('storeResolution.addressNotFound')); return; }
        mapRef.current?.animateToRegion(
            { latitude: r.lat, longitude: r.lng, latitudeDelta: CLOSE_DELTA, longitudeDelta: CLOSE_DELTA },
            600,
        );
    }, [searchText, t]);

    const onConfirm = useCallback(() => {
        const s = stores.find((x) => x.id === selectedId);
        if (!s) return;
        completedRef.current = true;
        completeStoreResolution({ storeId: s.id, storeName: s.name, storeAddress: s.address });
        router.back();
    }, [stores, selectedId, router]);

    const initialRegion: Region = {
        latitude: VILNIUS_FALLBACK.lat,
        longitude: VILNIUS_FALLBACK.lng,
        latitudeDelta: DELTA,
        longitudeDelta: DELTA,
    };

    if (!req) return null;

    return (
        <View style={styles.root}>
            <Stack.Screen
                options={{
                    title: t('storeResolution.title'),
                    headerTintColor: colors.primary,
                    headerStyle: { backgroundColor: colors.cardBackground },
                    headerShadowVisible: false,
                }}
            />
            {/* Recognised chain — shown, NOT changeable. */}
            <View style={styles.chainBar}>
                <ChainLogoChip chainId={req.chainId} name={req.chainName} size={32} />
                <View style={{ flex: 1 }}>
                    <Text style={styles.chainName} numberOfLines={1}>{chainBrandName(req.chainName)}</Text>
                    <Text style={styles.hint} numberOfLines={2}>{t('storeResolution.hint')}</Text>
                </View>
            </View>
            <MapPickerScaffold
                mapRef={mapRef}
                initialRegion={initialRegion}
                searchText={searchText}
                onSearchTextChange={(v) => { setSearchText(v); setSearchError(null); }}
                onSearch={onSearch}
                searching={searching}
                searchError={searchError}
                searchPlaceholder={t('storeResolution.searchPlaceholder')}
                confirmLabel={t('storeResolution.confirm')}
                confirmEnabled={selectedId != null}
                onConfirm={onConfirm}
                mapChildren={stores.map((s) => {
                    const sel = s.id === selectedId;
                    // Key includes selection so the native marker remounts with the
                    // bigger pink-ringed selected pin image on tap (Android-safe).
                    return (
                        <Marker
                            key={`${s.id}-${sel ? 'sel' : ''}`}
                            coordinate={{ latitude: s.latitude, longitude: s.longitude }}
                            image={chainPinImage(req.chainId, sel) ?? undefined}
                            anchor={{ x: 0.5, y: 1 }}
                            zIndex={sel ? 10 : 1}
                            onPress={() => setSelectedId(s.id)}
                        />
                    );
                })}
            />
        </View>
    );
}

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        root: { flex: 1, backgroundColor: c.pageBackground },
        chainBar: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.md,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            backgroundColor: c.cardBackground,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: c.border,
        },
        chainName: { ...typography.bodyStrong, color: c.textPrimary },
        hint: { ...typography.labelSmall, fontWeight: '400', color: c.textMuted, marginTop: 2 },
    });
