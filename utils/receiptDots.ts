import { chainBrandColor } from "./chainBrandName";

/**
 * Calendar dot-map helpers shared by the Analyze tab's date filter and the
 * shopping-list "pick an uploaded receipt" screen — both feed DateFilterButton
 * the same "YYYY-MM-DD" → chain-colour-dots map, deduped per chain per day.
 */

/** Loose "YYYY-MM-DD" / "YYYY.MM.DD" / "YYYY/M/D" (optional time tail) → local Date. */
export function parseLooseDate(str: string | null | undefined): Date | null {
  if (!str) return null;
  const m = String(str).match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const keyOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Build the marked-dates map: one dot per chain per day, order preserved. */
export function buildReceiptDotMap(
  rows: { date: Date | null; chainName: string | null }[],
): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.date || !r.chainName) continue;
    const key = keyOf(r.date);
    const chains = seen.get(key) ?? new Set<string>();
    if (chains.has(r.chainName)) continue;
    chains.add(r.chainName);
    seen.set(key, chains);
    const arr = m.get(key) ?? [];
    arr.push(chainBrandColor(r.chainName));
    m.set(key, arr);
  }
  return m;
}
