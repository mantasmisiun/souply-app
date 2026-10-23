import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { API_BASE_URL } from '../config/api';
import { authedFetch } from './authApi';

/**
 * Save a receipt's image to the device gallery. Resolves the presigned URL from
 * GET /receipts/:id/image ({ url }), downloads it, then saves via MediaLibrary.
 * Returns false if permission is denied or the fetch fails.
 */
export async function downloadReceiptImage(receiptId: number): Promise<boolean> {
    try {
        const perm = await MediaLibrary.requestPermissionsAsync(true);
        if (perm.status !== 'granted') return false;
        const res = await authedFetch(`${API_BASE_URL}/api/receipts/${receiptId}/image`);
        if (!res.ok) return false;
        const { url } = await res.json();
        if (typeof url !== 'string' || !url) return false;
        const dest = `${FileSystem.cacheDirectory}receipt-${receiptId}.jpg`;
        const dl = await FileSystem.downloadAsync(url, dest);
        if (dl.status !== 200) return false;
        await MediaLibrary.saveToLibraryAsync(dl.uri);
        return true;
    } catch {
        return false;
    }
}

/** Save several receipts; returns how many succeeded. */
export async function downloadReceiptImages(receiptIds: number[]): Promise<number> {
    let ok = 0;
    for (const id of receiptIds) {
        if (await downloadReceiptImage(id)) ok += 1;
    }
    return ok;
}
