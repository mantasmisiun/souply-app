import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { SwipeQueue } from "../../components/swipe/SwipeQueue";

/**
 * Thin route wrapper around the reusable <SwipeQueue> component. Used for the VOLUNTARY
 * "Pagerinti atpažinimą" entry and the multi-receipt banner batch. The mandatory
 * post-scan swipes are NOT a route anymore — receipt-process hosts <SwipeQueue> in-place
 * as its 'swiping' phase (no route bounce, no swipeDone round-trip).
 *
 * Param surface:
 *   receiptIds=a,b,c  multi-receipt mandatory batch
 *   receiptId=a       single receipt (typically with voluntary=1)
 *   voluntary=1       voluntary deep-rescue mode
 *   returnTo=/...     where to land after the session ends
 */
export default function SwipeQueueScreen() {
  const router = useRouter();
  const { receiptId, receiptIds, voluntary, returnTo } = useLocalSearchParams<{
    receiptId?: string;
    receiptIds?: string;
    voluntary?: string;
    returnTo?: string;
  }>();

  const ids = useMemo<string[]>(() => {
    if (receiptIds) return receiptIds.split(",").map((s) => s.trim()).filter(Boolean);
    if (receiptId) return [receiptId];
    return [];
  }, [receiptId, receiptIds]);

  return (
    <SwipeQueue
      receiptIds={ids}
      voluntary={voluntary === "1"}
      returnTo={returnTo}
      renderHeader
      onAllDone={({ returnTo: rt }) => {
        if (rt) router.replace(rt as any);
        else router.back();
      }}
      onExit={() => router.back()}
    />
  );
}
