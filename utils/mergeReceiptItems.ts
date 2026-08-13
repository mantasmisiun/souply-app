import type { TripReceipt } from './tripsApi';
import { fmtSize, unitLabel } from './amountDisplay';

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
    /** The (receiptId, lineIdx) refs behind this row — what the family/personal
     *  scope PATCH addresses (a row may span several receipts). */
    lines: { receiptId: number; lineIdx: number }[];
    chainId: number | null;
    chainName: string | null;
}

export function mergeReceiptItems(receipts: TripReceipt[]): MergedReceiptItem[] {
    const map = new Map<string, MergedReceiptItem>();
    const order: string[] = [];
    for (const r of receipts) {
        // COMBO / SET-DEAL: the footer combo discount (IKI RINKINYS) is money paid off
        // the whole receipt that never lands on a line price. Scale THIS receipt's paid
        // item totals to the printed total (the paid truth) so each row shows the real
        // net price, and the pre-combo `regularTotal` reads as a discount in the promo
        // view. Which lines form the bundle is unknown, so it's spread proportionally.
        const lineOf = (it: TripReceipt['items'][number]) =>
            it.lineTotal != null ? Number(it.lineTotal) : it.price != null ? Number(it.price) : 0;
        const combo = r.comboDiscount > 0 ? r.comboDiscount : 0;
        let comboScale = 1;
        if (combo > 0) {
            const grossR = r.items.reduce((s, it) => s + lineOf(it), 0);
            if (grossR > 0) {
                const printed = r.printedTotal;
                const net = (printed != null && printed > 0 && printed <= grossR) ? printed : Math.max(0, grossR - combo);
                comboScale = net / grossR;
            }
        }
        for (const it of r.items) {
            const key = it.matchedSpId != null
                ? `sp:${it.matchedSpId}`
                : `nm:${(it.matchedName ?? it.name ?? '').trim().toLowerCase()}`;
            // Net paid = line total × the receipt's combo scale (1 when no combo).
            const paid = lineOf(it) * comboScale;
            const qty = it.quantity != null ? Number(it.quantity) : 1;
            // Regular (pre-promo, pre-combo) line total: price is the REGULAR unit price;
            // it stays GROSS so the discounts view can strike it through. When price is
            // missing there is nothing to strike out, so fall back to the paid amount.
            const regular = it.price != null ? Number(it.price) * qty : paid;
            const ex = map.get(key);
            if (ex) {
                ex.quantity += qty;
                ex.lineTotal += paid;
                ex.regularTotal += regular;
                ex.count += 1;
                ex.receiptItemIds.push(it.id);
                ex.lines.push({ receiptId: r.id, lineIdx: it.lineIdx });
                if (!ex.imageUrl && it.storeProductImageUrl) ex.imageUrl = it.storeProductImageUrl;
            } else {
                map.set(key, {
                    key, name: it.matchedName ?? it.name,
                    imageUrl: it.storeProductImageUrl, unit: it.unit, sizeUnit: it.sizeUnit,
                    quantity: qty, lineTotal: paid, regularTotal: regular, count: 1,
                    receiptItemIds: [it.id],
                    lines: [{ receiptId: r.id, lineIdx: it.lineIdx }],
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
    const asWeight = (kg: number) => {
        const s = fmtSize(kg, 'kg');            // grams/kg polish, shared everywhere
        return `${s.value} ${unitLabel(s.unit)}`;
    };
    if (unit.includes('kg')) return asWeight(m.quantity);
    // Several merged lines of the same pack → "N × pack size".
    if (m.count > 1 && m.sizeUnit) return `${m.count} × ${m.sizeUnit}`;
    // A fractional qty is a weight even without a 'kg' unit; else a piece count.
    if (m.quantity % 1 !== 0) return asWeight(m.quantity);
    return `${Math.max(1, Math.round(m.quantity))} vnt`;
}
