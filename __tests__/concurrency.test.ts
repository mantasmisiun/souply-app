/**
 * mapLimit — the concurrency cap under the receipt match fan-out. The cap is
 * what keeps ~30 parallel match calls from monopolising the phone's per-host
 * socket pool (other screens' fetches starved until the burst drained).
 */
import { mapLimit } from "../utils/concurrency";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("mapLimit", () => {
  it("preserves order and maps every item", async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("never runs more than `limit` tasks at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      await tick();
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  it("handles empty input and limit larger than the list", async () => {
    expect(await mapLimit([], 4, async (x) => x)).toEqual([]);
    expect(await mapLimit([1, 2], 99, async (x) => x + 1)).toEqual([2, 3]);
  });

  it("propagates a task rejection", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
