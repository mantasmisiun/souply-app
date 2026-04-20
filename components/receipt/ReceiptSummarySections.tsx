import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ReceiptViewModel } from '../../types/receipt-view';

type Props = {
  vm: ReceiptViewModel;
  status: string;
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'completed': return '#2e7d32';
    case 'processing': return '#f57c00';
    case 'failed': return '#c62828';
    default: return '#757575';
  }
};

export default function ReceiptSummarySections({ vm, status }: Props) {
    const [expanded, setExpanded] = useState(false);
  return (
    <>
      <View style={styles.sectionCard}>
        <View style={styles.chainRow}>
          <Text style={styles.chainBadge}>{vm.header.chainName || 'Neatpažinta'}</Text>
          <Ionicons
            name="checkmark-circle"
            size={20}
            color={getStatusColor(status)}
            style={{ marginLeft: 8 }}
          />
        </View>

        {!!vm.header.storeName && <Text style={styles.storeName}>{vm.header.storeName}</Text>}
        {!!vm.header.storeAddress && (
          <Text style={styles.sectionSubvalue}>{vm.header.storeAddress}</Text>
        )}
      </View>

      <TouchableOpacity style={styles.productsHeader} onPress={() => setExpanded((v) => !v)}>
        <View style={styles.productsHeaderLeft}>
            <Ionicons name="cart-outline" size={20} color="#2e7d32" />
            <Text style={styles.sectionTitle}>Prekės ({vm.products.length})</Text>
        </View>
        <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={18}
            color="#757575"
        />
        </TouchableOpacity>
        {expanded && (
        <>
            {vm.products.map((product, index) => (
                <View key={index} style={styles.productCard}>
                <View style={styles.productRow}>
                    <View style={styles.productInfo}>
                    {product.matchedName ? (
                        <>
                        <Text style={[styles.matchedName, product.matchConfirmed === false && { color: '#f57c00' }]}>
                            {product.matchedName}
                        </Text>
                        <Text style={styles.ocrName}>{product.name}</Text>
                        </>
                    ) : (
                        <Text style={styles.productName}>{product.name}</Text>
                    )}
                    <Text style={styles.productQuantity}>
                        {product.quantity} {product.unit || ''}
                    </Text>
                    </View>

                    <View style={styles.productPriceCol}>
                    {product.promoPrice !== null && product.promoPrice !== undefined ? (
                        <>
                        <Text style={styles.productPriceStrike}>€{Number(product.price || 0).toFixed(2)}</Text>
                        <Text style={styles.productPromoPrice}>€{Number(product.promoPrice).toFixed(2)}</Text>
                        </>
                    ) : (
                        <Text style={styles.productPrice}>€{Number(product.price || 0).toFixed(2)}</Text>
                    )}
                    </View>

                    <View style={styles.matchIndicator}>
                    <Ionicons
                        name={product.matchConfirmed ? 'checkmark-circle' : 'warning'}
                        size={20}
                        color={product.matchConfirmed ? '#2e7d32' : '#f57c00'}
                    />
                    </View>
                </View>
                </View>
            ))}
            {vm.products.length === 0 && (
                <View style={styles.emptyProducts}>
                    <Ionicons name="alert-circle-outline" size={32} color="#e0e0e0" />
                    <Text style={styles.emptyText}>Prekės neatpažintos</Text>
                </View>
                )}
            </>
            )}

      {vm.products.length === 0 && (
        <View style={styles.emptyProducts}>
          <Ionicons name="alert-circle-outline" size={32} color="#e0e0e0" />
          <Text style={styles.emptyText}>Prekės neatpažintos</Text>
        </View>
      )}

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Kvito duomenys</Text>
        <View style={styles.footerContent}>
          <View style={styles.footerRow}>
            <Text style={styles.footerLabel}>Suma:</Text>
            <Text style={styles.footerValue}>
              {typeof vm.footer.total === 'number' ? `€${vm.footer.total.toFixed(2)}` : '—'}
            </Text>
          </View>
          <View style={styles.footerRow}>
            <Text style={styles.footerLabel}>Data:</Text>
            <Text style={styles.footerValue}>{vm.footer.date || '—'} {vm.footer.time || ''}</Text>
          </View>
          <View style={styles.footerRow}>
            <Text style={styles.footerLabel}>Kvito Nr.:</Text>
            <Text style={styles.footerValue}>{vm.footer.receiptNo || '—'}</Text>
          </View>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
sectionCard: {
    backgroundColor: 'white',
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    padding: 16,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
},
sectionTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: '#212121' },
sectionSubvalue: { fontSize: 13, color: '#757575', marginTop: 4 },

chainRow: { flexDirection: 'row', alignItems: 'center' },
chainBadge: { fontSize: 18, fontWeight: '700', color: '#212121' },
storeName: { fontSize: 14, color: '#424242', marginTop: 4 },
productCard: {
    backgroundColor: 'white',
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 12,
    padding: 14,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    },
    productRow: { flexDirection: 'row', alignItems: 'center' },
    productInfo: { flex: 1 },
    productName: { fontSize: 14, color: '#212121', fontWeight: '500' },
    matchedName: { fontSize: 14, color: '#2e7d32', fontWeight: '600' },
    ocrName: { fontSize: 11, color: '#9e9e9e', marginTop: 2 },
    productQuantity: { fontSize: 12, color: '#757575', marginTop: 2 },
    productPriceCol: { alignItems: 'flex-end', marginRight: 8 },
    productPrice: { fontSize: 15, fontWeight: '700', color: '#212121' },
    productPriceStrike: { fontSize: 12, color: '#9e9e9e', textDecorationLine: 'line-through' },
    productPromoPrice: { fontSize: 15, fontWeight: '700', color: '#d32f2f' },
    matchIndicator: { marginLeft: 4 },

    footerContent: { marginTop: 10 },
    footerRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
    footerLabel: { fontSize: 13, color: '#757575' },
    footerValue: { fontSize: 13, fontWeight: '600', color: '#212121' },

    emptyProducts: { alignItems: 'center', padding: 32, gap: 8 },
    emptyText: { fontSize: 14, color: '#9e9e9e' },

productsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginTop: 20,
    marginBottom: 4,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#edf2f7',
},
    productsHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    },
});