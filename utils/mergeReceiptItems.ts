import type { TripReceipt } from './tripsApi';

/**
 * Collapses a trip's receipt lines for the identified-items list: lines matched
 * to the SAME product (or, unmatched, the same name) merge into one row —
 * quantities/weights and the ACTUAL paid totals (lineTotal) summed. Preserves
 * first-seen order.
 */
export interface MergedReceiptItem {
    key: string;
    name: string;
    imageUrl: string | null;
    unit: string | null;
    sizeUnit: string | null;
    /** Summed quantity (pieces or kg, per `unit`). */
    quantity: number;
    /** Summed actual paid (promo-adjusted line totals). */
    lineTotal: number;
    /** Summed REGULAR total (price × qty, ignoring promos) — equals lineTotal
     *  when nothing was discounted; strictly greater when a promo applied. Lets
     *  the discounts view show the crossed-out pre-promo price. */
    regularTotal: number;
    /** How many receipt lines merged into this row. */
    count: number;
    /** The ReceiptItem ids that merged here — all share the same plan/impulse
     *  status (same product/name), so the Impulse sheet can flag the row. */
    receiptItemIds: number[];
    chainId: number | null;
    chainName: string | null;
}

export function mergeReceiptItems(receipts: TripReceipt[]): MergedReceiptItem[] {
    const map = new Map<string, MergedReceiptItem>();
    const order: string[] = [];
    for (const r of receipts) {
        for (const it of r.items) {
            const key = it.matchedSpId != null
                ? `sp:${it.matchedSpId}`
                : `nm:${(it.matchedName ?? it.name ?? '').trim().toLowerCase()}`;
            const paid = it.lineTotal != null ? Number(it.lineTotal)
                : it.price != null ? Number(it.price) : 0;
            const qty = it.quantity != null ? Number(it.quantity) : 1;
            // Regular (pre-promo) line total: price is the REGULAR unit price;
            // lineTotal already applied any promo. When price is missing there is
            // nothing to strike out, so fall back to the paid amount.
            const regular = it.price != null ? Number(it.price) * qty : paid;
            const ex = map.get(key);
            if (ex) {
                ex.quantity += qty;
                ex.lineTotal += paid;
                ex.regularTotal += regular;
                ex.count += 1;
                ex.receiptItemIds.push(it.id);
                if (!ex.imageUrl && it.storeProductImageUrl) ex.imageUrl = it.storeProductImageUrl;
            } else {
                map.set(key, {
                    key, name: it.matchedName ?? it.name,
                    imageUrl: it.storeProductImageUrl, unit: it.unit, sizeUnit: it.sizeUnit,
                    quantity: qty, lineTotal: paid, regularTotal: regular, count: 1,
                    receiptItemIds: [it.id],
                    chainId: r.chainId, chainName: r.chainName,
                });
                order.push(key);
            }
        }
    }
    return order.map(k => map.get(k)!);
}

/**
 * The quantity/size caption for a merged row — ALWAYS present so every item
 * shows its amount:
 *   • weighable (unit kg)        → summed weight, e.g. "1.85 kg"
 *   • fractional, no kg unit     → still a weight ("0.2 kg")
 *   • repeated fixed-size packs  → "2 × 400 g"
 *   • discrete pieces            → "N vnt", including a single "1 vnt"
 */
export function mergedQtyLabel(m: MergedReceiptItem): string {
    const unit = (m.unit ?? '').toLowerCase();
    if (unit.includes('kg')) {
        const w = parseFloat(m.quantity.toFixed(3));
        return `${w} kg`;
    }
    if (m.count > 1 && m.sizeUnit) return `${m.count} × ${m.sizeUnit}`;
    // A fractional qty is a weight even without a 'kg' unit; else a piece count.
    if (m.quantity % 1 !== 0) return `${parseFloat(m.quantity.toFixed(3))} kg`;
    return `${Math.max(1, Math.round(m.quantity))} vnt`;
}
