import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ProductImage } from '../ProductImage';

type Props = {
    name: string;
    imageUrls?: (string | null | undefined)[] | string | null;
    amountText?: string;
    quantity: number;
    onOpen?: () => void;
    onAdd: () => void;
    onDec: () => void;
    onInc: () => void;
};

export default function BasketProductCard({
    name,
    imageUrls,
    amountText,
    quantity,
    onOpen,
    onAdd,
    onDec,
    onInc,
}: Props) {
    return (
        <View style={styles.productCard}>
            <TouchableOpacity
                onPress={onOpen}
                style={styles.productImageContainer}
                activeOpacity={onOpen ? 0.7 : 1}
                disabled={!onOpen}
            >
                <ProductImage
                    uris={imageUrls}
                    imageStyle={styles.productImage}
                    placeholderStyle={styles.productImagePlaceholder}
                    emojiStyle={styles.productImageEmoji}
                />
            </TouchableOpacity>

            <View style={styles.productInfo}>
                <Text style={styles.productName} numberOfLines={3}>{name}</Text>
                {!!amountText && <Text style={styles.amountText}>{amountText}</Text>}
            </View>

            {quantity === 0 ? (
                <TouchableOpacity style={styles.addButton} onPress={onAdd}>
                    <Text style={styles.addButtonText}>Į krepšelį</Text>
                </TouchableOpacity>
            ) : (
                <View style={styles.quantityControl}>
                    <TouchableOpacity style={styles.qtyButton} onPress={onDec}>
                        <Ionicons name="remove" size={16} color="#2e7d32" />
                    </TouchableOpacity>
                    <Text style={styles.qtyText}>
                        {Number.isInteger(quantity) ? quantity : quantity.toFixed(1)}
                    </Text>
                    <TouchableOpacity style={styles.qtyButton} onPress={onInc}>
                        <Ionicons name="add" size={16} color="#2e7d32" />
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    productCard: {
        backgroundColor: 'white',
        borderRadius: 12,
        padding: 12,
        alignItems: 'center',
        elevation: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        flex: 1,
        maxWidth: '50%',
    },
    productImageContainer: {
        width: '100%',
        height: 130,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 8,
    },
    productImage: { width: '100%', height: '100%' },
    productImagePlaceholder: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f3f4f6',
        borderRadius: 8,
    },
    productImageEmoji: {
        fontSize: 44,
        opacity: 0.4,
    },
    productInfo: { flex: 1, width: '100%', marginBottom: 10 },
    productName: { fontSize: 13, color: '#212121', lineHeight: 18 },
    amountText: { fontSize: 12, color: '#9e9e9e', marginTop: 2 },
    addButton: {
        width: '100%',
        backgroundColor: '#2e7d32',
        borderRadius: 8,
        paddingVertical: 10,
        alignItems: 'center',
    },
    addButtonText: { color: 'white', fontSize: 13, fontWeight: '600' },
    quantityControl: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderWidth: 1,
        borderColor: '#2e7d32',
        borderRadius: 8,
        paddingVertical: 6,
        paddingHorizontal: 10,
    },
    qtyButton: { padding: 2 },
    qtyText: {
        fontSize: 14,
        fontWeight: '700',
        color: '#2e7d32',
        minWidth: 20,
        textAlign: 'center',
    },
});