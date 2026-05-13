import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useState } from 'react';
import { API_BASE_URL } from '../config/api';
import { ReceiptComparison } from '../types/receipt-view';
import { fetchWithTimeout, TIMEOUT_STANDARD_MS } from '../utils/fetchWithTimeout';

/**
 * Hard cap on how far a comparison alternative store may sit from the
 * visited store. The server takes this as `?maxDistanceKm=` and applies
 * its own cluster fallback when no cross-chain alt is within range.
 * Lithuanian urban areas have meaningful neighbours within ~5 km, 10 km
 * is generous; bumping later is one constant edit + a cache version bump.
 */
export const COMPARISON_MAX_DISTANCE_KM = 10;

// cacheKey v2: bumped from v1 when distance filtering shipped, so older
// cached comparisons (which were computed without the filter) get
// invalidated automatically.
const cacheKey = (receiptId: string | number) =>
    `comparison_v2_${receiptId}_d${COMPARISON_MAX_DISTANCE_KM}`;

const comparisonUrl = (receiptId: string | number) =>
    `${API_BASE_URL}/api/receipts/${receiptId}/comparison?maxDistanceKm=${COMPARISON_MAX_DISTANCE_KM}`;

async function readCache(id: string | number): Promise<ReceiptComparison | null> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(id));
    if (!raw) return null;
    const { data } = JSON.parse(raw);
    return data ?? null;
  } catch {
    return null;
  }
}

async function writeCache(id: string | number, data: ReceiptComparison) {
  try {
    await AsyncStorage.setItem(cacheKey(id), JSON.stringify({ data, ts: Date.now() }));
  } catch {}
}

export function useReceiptComparison() {
  const [comparison, setComparison] = useState<ReceiptComparison | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);

  const fetchComparison = useCallback(async (receiptId: string | number) => {
    // Serve cached data instantly — no loading spinner on repeat opens.
    const cached = await readCache(receiptId);
    if (cached) {
      setComparison(cached);
      // Refresh silently in the background; update when done.
      void (async () => {
        try {
          const res = await fetchWithTimeout(comparisonUrl(receiptId), {
            timeoutMs: TIMEOUT_STANDARD_MS,
          });
          if (!res.ok) return;
          const fresh = await res.json();
          setComparison(fresh);
          void writeCache(receiptId, fresh);
        } catch {}
      })();
      return cached;
    }

    // No cache — show loading indicator for the first fetch.
    try {
      setComparisonLoading(true);
      setComparisonError(null);

      const res = await fetchWithTimeout(comparisonUrl(receiptId), {
        timeoutMs: TIMEOUT_STANDARD_MS,
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || 'Nepavyko gauti palyginimo');
      }

      setComparison(data);
      void writeCache(receiptId, data);
      return data;
    } catch (e: any) {
      const msg = e?.message || 'Nepavyko gauti palyginimo';
      setComparisonError(msg);
      return null;
    } finally {
      setComparisonLoading(false);
    }
  }, []);

  return {
    comparison,
    comparisonLoading,
    comparisonError,
    fetchComparison,
    setComparison,
  };
}
