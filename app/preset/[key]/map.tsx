import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { PresetPointPicker } from '../../../components/PresetPointPicker';
import type { PresetKey } from '../../../utils/locationStorage';

/**
 * Home/work/other point-picker route — a thin wrapper over PresetPointPicker
 * (the same picker the store map embeds inline for its "define a location"
 * flow). Both save the preset and pop; the component owns all the map logic.
 */
export default function PresetMapScreen() {
    const router = useRouter();
    const { key, label, lat, lng } = useLocalSearchParams<{
        key: string; label: string; lat?: string; lng?: string;
    }>();

    const existing = lat != null && lng != null && !isNaN(Number(lat)) && !isNaN(Number(lng))
        ? { label: label ?? '', lat: Number(lat), lng: Number(lng) }
        : null;

    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <PresetPointPicker
                presetKey={key as PresetKey}
                label={label ?? ''}
                existing={existing}
                onDone={() => router.back()}
                onCancel={() => router.back()}
            />
        </>
    );
}
