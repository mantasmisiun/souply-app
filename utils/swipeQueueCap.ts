// Re-export shim. The swipe-queue cap logic now lives in shared/swipeQueueCap.ts
// (canonical) so BOTH the client display path (SwipeQueue.loadQueue) and the server
// voluntary-queue-COUNT endpoint cap through one identical implementation — the
// count and the served queue can never drift. Importers keep using "../utils/swipeQueueCap".
export * from '@shared/swipeQueueCap';
