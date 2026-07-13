import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import {
  NetworkError,
  ProcessingError,
  processOneReceipt,
} from "../services/receiptProcessingService";
import { useNetworkStatus } from "../state/networkStatus";
import { useReceiptQueueStore } from "../state/receiptQueueStore";

/**
 * Decides how a processing failure should be reflected in the queue.
 * Extracted from the runner so the routing rules — which determine
 * whether the user's item gets paused (recoverable) or errored out
 * (needs attention) — can be locked in tests.
 *
 * Order matters: ProcessingError is checked first because deterministic
 * failures (parser couldn't recognise the chain, OCR returned no text)
 * can't be fixed by waiting for connectivity.
 */
export type QueueErrorRouting =
  | { kind: "error"; message: string; isDuplicate: boolean }
  | { kind: "awaiting_network" };

export function routeQueueError(
  error: unknown,
  isOnline: boolean,
): QueueErrorRouting {
  if (error instanceof ProcessingError) {
    return {
      kind: "error",
      message: error.message,
      isDuplicate: error.message === "Kvitas jau įkeltas",
    };
  }
  if (error instanceof NetworkError || !isOnline) {
    return { kind: "awaiting_network" };
  }
  return { kind: "error", message: "Nepavyko apdoroti kvito", isDuplicate: false };
}

export function useReceiptQueueRunner(): void {
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Run once on mount to restore any interrupted items.
  const initialized = useReceiptQueueStore((s) => s.initialized);
  const initialize = useReceiptQueueStore((s) => s.initialize);
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Online state is read inside processNext via a ref so the callback
  // doesn't need re-binding on every connectivity flip. The dedicated
  // useEffect below watches the boolean for the offline→online edge.
  const isOnline = useNetworkStatus((s) => s.isOnline);
  const onlineRef = useRef(isOnline);
  useEffect(() => {
    onlineRef.current = isOnline;
  }, [isOnline]);

  function processNext(): void {
    if (!initialized) return;
    if (runningRef.current) return;
    if (!onlineRef.current) return; // wait for connectivity
    const store = useReceiptQueueStore.getState();
    const next = store.items.find((i) => i.status === "pending");
    if (!next) return;

    runningRef.current = true;
    abortRef.current = new AbortController();
    store.markProcessing(next.id, "Nuskaitoma...");

    processOneReceipt(
      next.uris,
      abortRef.current.signal,
      (step, done, total) =>
        useReceiptQueueStore
          .getState()
          .updateProgress(next.id, step, done, total),
      { isPdf: next.isPdf === true },
    )
      .then((result) => {
        useReceiptQueueStore.getState().markDone(next.id, result.receiptId);
      })
      .catch((e) => {
        const s = useReceiptQueueStore.getState();
        const routing = routeQueueError(e, onlineRef.current);
        if (routing.kind === "awaiting_network") {
          s.markAwaitingNetwork(next.id);
        } else {
          s.markError(next.id, routing.message);
          if (routing.isDuplicate) {
            // Duplicate receipts are informational — auto-dismiss after 4 s.
            setTimeout(
              () => useReceiptQueueStore.getState().removeItem(next.id),
              4000,
            );
          }
        }
      })
      .finally(() => {
        runningRef.current = false;
        abortRef.current = null;
        // Kick off the next item without waiting for a re-render.
        setTimeout(processNext, 0);
      });
  }

  // Watch queue: start processing when a new pending item arrives and nothing is running.
  const items = useReceiptQueueStore((s) => s.items);
  useEffect(() => {
    const hasPending = items.some((i) => i.status === "pending");
    const hasProcessing = items.some((i) => i.status === "processing");
    if (hasPending && !hasProcessing) {
      processNext();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, initialized]);

  // Offline → online edge: revive every `awaiting_network` item. The
  // items-effect above then picks the first one up. We don't call
  // processNext directly here because the store mutation triggers the
  // items-effect on the next tick.
  useEffect(() => {
    if (!initialized) return;
    if (!isOnline) return;
    useReceiptQueueStore.getState().resumeAwaitingNetwork();
  }, [isOnline, initialized]);

  // Resume after the app returns to the foreground (e.g. user backgrounded mid-batch).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") processNext();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized]);
}
