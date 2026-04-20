import { ReceiptViewModel } from '../types/receipt-view';

type AnyObj = Record<string, any>;

const asObj = (v: unknown): AnyObj | null =>
  v && typeof v === 'object' ? (v as AnyObj) : null;

const asStringOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v : null;

const asNumberOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const asBool = (v: unknown): boolean => v === true;

export const normalizeParsedData = (raw: unknown): AnyObj | null => {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return asObj(parsed);
    } catch {
      return null;
    }
  }
  return asObj(raw);
};

export const buildReceiptViewModel = (
  rawParsedData: unknown,
  fallback?: {
    chainName?: string | null;
    receiptNo?: string | null;
    receiptDate?: string | null;
  }
): ReceiptViewModel => {
  const parsed = normalizeParsedData(rawParsedData);
  const header = asObj(parsed?.header);
  const footer = asObj(parsed?.footer);
  const productsRaw = Array.isArray(parsed?.products) ? parsed!.products : [];

  return {
    header: {
      chainName: asStringOrNull(header?.chainName) ?? fallback?.chainName ?? null,
      storeName: asStringOrNull(header?.storeName),
      storeAddress:
        asStringOrNull(header?.storeAddressMatched) ??
        asStringOrNull(header?.storeAddress),
    },
    products: productsRaw.map((p: any) => ({
      name: asStringOrNull(p?.name) ?? '',
      matchedName: asStringOrNull(p?.matchedName),
      matchConfirmed: asBool(p?.matchConfirmed),
      price: asNumberOrNull(p?.price) ?? 0,
      promoPrice: asNumberOrNull(p?.promoPrice),
      quantity: asNumberOrNull(p?.quantity) ?? 1,
      unit: asStringOrNull(p?.unit),
    })),
    footer: {
      receiptNo: asStringOrNull(footer?.receiptNo) ?? fallback?.receiptNo ?? null,
      date: asStringOrNull(footer?.date) ?? fallback?.receiptDate ?? null,
      time: asStringOrNull(footer?.time),
      total: asNumberOrNull(footer?.total),
    },
  };
};