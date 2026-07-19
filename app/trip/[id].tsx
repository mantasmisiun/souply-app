/**
 * Trip stage REDIRECTOR (simplified-flow rework, TRIP_MAP_SURFACE_PLAN.md):
 * a trip no longer has its own container surface — every entry point
 * (Shopping cards, list-creation navigation, invite links) lands here and is
 * immediately replaced by the ONE screen the trip's derived stage calls for:
 *
 *   1 forming      → /basket/[basketId]           (edit items, "Find stores")
 *   2 compared     → /basket/results/[basketId]   (the working comparison map)
 *   3 shopping     → /shopping-list/[listId]      (closest unfinished store)
 *   4 need receipt → /trip/receipts/[tripId]
 *   5 done         → /trip/stats/[tripId]
 *
 * The six-tab map dock this file used to host was removed — a trip is a
 * journey, not a workspace: one stage, one screen, one primary action.
 */
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef } from 'react';
import { MaterialProgress } from '@/components/MaterialProgress';
import { useTheme, type AppTheme } from '../../constants/theme';
import { fetchTrips } from '../../utils/tripsApi';
import { tripStageHref } from '../../utils/tripStageRoute';

export default function TripStageRedirect() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const { id } = useLocalSearchParams<{ id: string }>();
    const tripId = Number(id);
    // One redirect per mount; re-focusing this spinner (e.g. the stage screen
    // popping back to it) just pops on through instead of re-resolving.
    const routedRef = useRef(false);

    useFocusEffect(useCallback(() => {
        if (routedRef.current) { router.back(); return; }
        routedRef.current = true;
        (async () => {
            try {
                const trips = await fetchTrips();
                const trip = trips.find(tr => tr.id === tripId);
                if (!trip) { router.back(); return; }
                router.replace(await tripStageHref(trip) as any);
            } catch {
                router.back();
            }
        })();
    }, [tripId, router]));

    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <View style={styles.centered}>
                <MaterialProgress size="large" color={colors.primary} />
            </View>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.pageBackground },
});
