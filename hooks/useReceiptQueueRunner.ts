import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import {
  NetworkError,
  ProcessingError,
  processOneReceipt,
} from "../services/receiptProcessingService";
import { useNetworkStatus } from "../state/networkStatus";
import { useReceiptQueueStore } from "../state/receiptQueueStore";
import { devLog } from "../utils/devLog";

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
    const store = useReceiptQueueStore.getState();
    const next = store.items.find((i) => i.status === "pending");
    if (!next) return;
    if (!onlineRef.current) {
      // OFFLINE: park the item visibly as awaiting-network instead of leaving
      // it "pending" (which reads as stalled). resumeAwaitingNetwork flips it
      // back on the offline→online edge and processing starts then.
      store.markAwaitingNetwork(next.id);
      setTimeout(processNext, 0); // park any further pending items too
      return;
    }

    runningRef.current = true;
    abortRef.current = new AbortController();
    store.markProcessing(next.id, "Nuskaitoma...");
    // The queue is headless and its items can be parked, resumed and re-parked
    // across app restarts — without a trace, "my receipt never arrived" is
    // unanswerable after the fact.
    devLog('queue.start', {
        id: next.id, pages: next.uris.length, heal: next.healReceiptId ?? null,
        linkChoiceListId: next.linkChoiceListId ?? null, linkAdHoc: !!next.linkAdHoc, linkTripId: next.linkTripId ?? null,
        linkMap: next.linkMap ?? null, retryOfDate: !!next.overrideDate,
    });

    processOneReceipt(
      next.uris,
      abortRef.current.signal,
      (step, done, total) =>
        useReceiptQueueStore
          .getState()
          .updateProgress(next.id, step, done, total),
      { isPdf: next.isPdf === true, linkMap: next.linkMap, fallbackLinkId: next.fallbackLinkId, healReceiptId: next.healReceiptId, devReplace: next.devReplace, overrideDate: next.overrideDate, resolvedStore: next.resolvedStore, linkChoiceListId: next.linkChoiceListId, linkAdHoc: next.linkAdHoc, linkTripId: next.linkTripId },
    )
      .then((result) => {
        devLog('queue.done', { id: next.id, receiptId: result.receiptId, linkedListId: result.linkedListId ?? null });
        useReceiptQueueStore.getState().markDone(next.id, result.receiptId, result.linkedListId);
      })
      .catch((e) => {
        const s = useReceiptQueueStore.getState();
        devLog('queue.fail', {
            id: next.id,
            reason: e instanceof ProcessingError ? e.reason : (e?.name ?? 'unknown'),
            message: String(e?.message ?? e).slice(0, 200),
            online: onlineRef.current,
        });
        // PARKED, not failed: the parse succeeded but the purchase date didn't
        // read. The card asks for it and resolveDate() re-queues the item.
        if (e instanceof ProcessingError && e.reason === "needs_date") {
          s.markNeedsDate(next.id, e.message);
          return;
        }
        // PARKED: uploaded for a trip, but from a store that trip didn't plan.
        // The card asks which slot it covers; resolveStoreLink() re-queues it.
        if (e instanceof ProcessingError && e.reason === "needs_store" && e.linkChoice) {
          s.markNeedsStore(next.id, e.message, e.linkChoice);
          return;
        }
        // PARKED: the receipt SAVED but never attached to its list. Retrying the
        // whole pipeline would only trip duplicate detection — the card retries
        // just the link, so the receipt can still reach the trip it was meant for.
        if (e instanceof ProcessingError && e.reason === "link_failed" && e.linkFailure) {
          s.markNeedsLink(next.id, e.message, e.linkFailure);
          return;
        }
        const routing = routeQueueError(e, onlineRef.current);
        if (routing.kind === "awaiting_network") {
          s.markAwaitingNetwork(next.id);
        } else {
          // Carry the chain/address context of a store_unrecognized failure so the
          // error card can offer "Rasti parduotuvę" (open the store map).
          const ctx = e instanceof ProcessingError
            ? { reason: e.reason, chainId: e.storeContext?.chainId, chainName: e.storeContext?.chainName, storeAddress: e.storeContext?.storeAddress }
            : undefined;
          s.markError(next.id, routing.message, ctx);
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
  //
  // Subscribe to the two DERIVED BOOLEANS, not the items array: this hook runs
  // inside RootLayout (above the Stack and every provider), so an array-identity
  // subscription re-rendered the whole app on every updateProgress tick during
  // product matching. Zustand compares selector results with Object.is, so a
  // boolean selector only re-renders on an actual pending/processing flip.
  const hasPending = useReceiptQueueStore((s) =>
    s.items.some((i) => i.status === "pending"),
  );
  const hasProcessing = useReceiptQueueStore((s) =>
    s.items.some((i) => i.status === "processing"),
  );
  useEffect(() => {
    if (hasPending && !hasProcessing) {
      processNext();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPending, hasProcessing, initialized]);

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
