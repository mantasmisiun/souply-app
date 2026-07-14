/**
 * Map with a concurrency cap, preserving order. Used by the receipt product-
 * matching pipelines: firing all ~30 match requests at once monopolised the
 * phone's per-host connection pool (~5 sockets), starving every other
 * screen's fetch against the same API host until the burst drained — the
 * "nothing loads while a receipt is processing" report. A cap of 4 leaves
 * headroom for the rest of the app and softens the server/DB burst, while
 * matching wall-time stays ~unchanged (the transport was already the
 * bottleneck).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
