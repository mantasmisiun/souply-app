import { Stack, useLocalSearchParams } from 'expo-router';
import StoreResultsSurface from '../../../components/results/StoreResultsSurface';

/**
 * Thin route wrapper — the whole store-comparison surface lives in
 * components/results/StoreResultsSurface so the trip map embeds the exact
 * same working map (pills with prices + 1·2·3 toggle) without duplication.
 */
export default function BasketResultsScreen() {
    const { id } = useLocalSearchParams();
    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <StoreResultsSurface basketId={String(id)} />
        </>
    );
}
