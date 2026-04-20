import { useCallback, useState } from 'react';
import { API_BASE_URL } from '../config/api';
import { ReceiptComparison } from '../types/receipt-view';

export function useReceiptComparison() {
  const [comparison, setComparison] = useState<ReceiptComparison | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);

  const fetchComparison = useCallback(async (receiptId: string | number) => {
    try {
      setComparisonLoading(true);
      setComparisonError(null);

      const res = await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/comparison`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || 'Nepavyko gauti palyginimo');
      }

      setComparison(data);
      return data;
    } catch (e: any) {
      const msg = e?.message || 'Nepavyko gauti palyginimo';
      setComparisonError(msg);
      return null;
    } finally {
      setComparisonLoading(false);
    }
  }, []);

  return {
    comparison,
    comparisonLoading,
    comparisonError,
    fetchComparison,
    setComparison,
  };
}