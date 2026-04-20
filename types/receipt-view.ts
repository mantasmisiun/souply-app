export interface ReceiptComparisonChain {
  chainId: number;
  chainName: string;
  storeId: number;
  storeName: string;
  storeAddress: string;
  distanceKm: number;
  total: number;
  savings: number;
  comparedItems: number;
  missingItems: number;
  note?: string;
  chainLogoUrl: string | null;
}

export interface ReceiptComparison {
  currentChain: {
    chainId: number;
    chainName: string;
    storeId: number;
    storeName: string;
    storeAddress: string;
    total: number;
    comparedItems: number;
    missingItems: number;
    chainLogoUrl: string | null;
  };
  alternatives: ReceiptComparisonChain[];
  summary: {
    recognizedItems: number;
    excludedItems: number;
    note?: string;
  };
}

export interface ReceiptHeaderView {
  chainName: string | null;
  storeName: string | null;
  storeAddress: string | null;
}

export interface ReceiptProductView {
  name: string;
  matchedName: string | null;
  matchConfirmed: boolean;
  price: number;
  promoPrice: number | null;
  quantity: number;
  unit: string | null;
}

export interface ReceiptFooterView {
  receiptNo: string | null;
  date: string | null;
  time: string | null;
  total: number | null;
}

export interface ReceiptViewModel {
  header: ReceiptHeaderView;
  products: ReceiptProductView[];
  footer: ReceiptFooterView;
}