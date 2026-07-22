/**
 * Legacy stage-5 route — the stats screen merged into the two-tab final screen
 * (/trip/receipts/[id]). Redirect there with the Stats tab preselected so any
 * lingering deep links still land correctly.
 */
import { Redirect, useLocalSearchParams } from 'expo-router';

export default function TripStatsRedirect() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <Redirect href={`/trip/receipts/${id}?tab=stats` as any} />;
}
