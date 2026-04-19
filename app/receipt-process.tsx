import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Image, ActivityIndicator, TextInput, Dimensions, Modal } from 'react-native';
import { useState, useEffect } from 'react';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import { isRimiReceipt, parseRimiReceipt, parseRimiHeaderOnly, RimiProduct, RimiHeader, RimiFooter, Region, RimiLine } from '../utils/rimiParser';
import { API_BASE_URL } from '../config/api';

interface ProductMatchOption {
    storeProductId: number;
    productId: number;
    name: string;
    imageUrl: string | null;
    amount: number | null;
    unit: string | null;
    confidence: number;
}

interface ProductLine {
    name: string;                            // OCR name
    matchedName: string | null;              // DB name (if matched)
    storeProductId: number | null;           // null if not confidently matched
    storeProductImageUrl: string | null;
    matchConfidence: number | null;
    matchConfirmed: boolean;                 // true = auto-applied OR user-picked
    altMatches: ProductMatchOption[];        // top 3 from backend, for manual picker
    price: number;
    promoPrice: number | null;
    quantity: number;
    unit: string;
    pricePerUnit: number | null;
    rawLines: string[];
    region: Region;
}

interface HeaderData {
    chainName: string;
    chainId: number | null;
    storeCode: string;
    storeAddress: string;           // OCR'd address
    storeId: number | null;
    storeName: string | null;
    storeAddressMatched: string | null; // clean address from DB
    matchConfidence: number | null;
    matchLoading: boolean;
    rawText: string;
    region: Region;
}

interface FooterData {
    total: number | null;
    date: string;
    time: string;
    receiptNo: string;
    totalSavings: number | null;
    rawText: string;
    region: Region;
}

interface RegionPreviewProps {
    imageUri: string;
    imageWidth: number;
    imageHeight: number;
    region: Region;
    cardWidth: number;
}
const CARD_WIDTH = Dimensions.get('window').width - 32 - 32; // screen - horizontal margins (16+16) - card padding (16+16)
function RegionPreview({ imageUri, imageWidth, imageHeight, region, cardWidth }: RegionPreviewProps) {
    // Bail out if region is empty (e.g. generic result fallback)
    if (region.yBottom <= region.yTop || region.xRight <= region.xLeft) {
        return null;
    }

    // Scale factor: how much we shrink the image to fit the card width.
    // We show the full image width, cropped vertically (and horizontally if needed) to the region.
    const scale = cardWidth / imageWidth;

    const regionHeight = region.yBottom - region.yTop;
    const displayHeight = regionHeight * scale;

    return (
        <View style={{
            width: cardWidth,
            height: displayHeight,
            overflow: 'hidden',
            borderRadius: 6,
            backgroundColor: '#fafafa',
        }}>
            <Image
                source={{ uri: imageUri }}
                style={{
                    width: imageWidth * scale,
                    height: imageHeight * scale,
                    marginTop: -region.yTop * scale,
                }}
                resizeMode="cover"
            />
        </View>
    );
}
export default function ProcessReceiptScreen() {
    const { uri } = useLocalSearchParams<{ uri: string }>();
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [loadingMessage, setLoadingMessage] = useState('Nuskaitomas kvitas...');

    const [header, setHeader] = useState<HeaderData | null>(null);
    const [products, setProducts] = useState<ProductLine[]>([]);
    const [footer, setFooter] = useState<FooterData | null>(null);
    const [editingSection, setEditingSection] = useState<'header' | 'footer' | number | null>(null);
    const [imageUri, setImageUri] = useState<string | null>(null);
    const [imageDims, setImageDims] = useState<{ width: number; height: number } | null>(null);
    const [pickerState, setPickerState] = useState<{ productIndex: number } | null>(null);
    useEffect(() => {
        if (uri) {
            const decoded = decodeURIComponent(uri);
            setImageUri(decoded);
            processReceipt(decoded);
        }
    }, [uri]);

    const processReceipt = async (imageUri: string) => {
        try {
            setLoading(true);
            setLoadingMessage('Atpažįstamas tekstas...');

            // Get the displayed image dimensions first so we can normalize MLKit coords
            const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
                Image.getSize(imageUri, (width, height) => resolve({ width, height }), reject);
            });
            setImageDims(dims);

            const result = await TextRecognition.recognize(imageUri);

            // Find MLKit's internal image bounds (max extents of all detected text)
            let mlkitMaxX = 0, mlkitMaxY = 0;
            for (const block of result.blocks) {
                for (const line of block.lines) {
                    if (line.frame) {
                        mlkitMaxX = Math.max(mlkitMaxX, line.frame.left + line.frame.width);
                        mlkitMaxY = Math.max(mlkitMaxY, line.frame.top + line.frame.height);
                    }
                }
            }

            // MLKit processes at the image's *native* resolution, but Image.getSize returns
            // the on-disk dimensions (which may be a smaller display-sized version).
            // Compute a scale factor to map MLKit frames → display image coords.
            // We estimate MLKit's source height from its max Y plus a small margin,
            // or compare ratios if the image aspect is consistent.
            const scaleX = dims.width / mlkitMaxX;
            const scaleY = dims.height / mlkitMaxY;
            // Use the average — both should be ~identical for a uniform downscale
            const frameScale = (scaleX + scaleY) / 2;

            console.log('=== COORDINATE NORMALIZATION ===');
            console.log(`Image dims: ${dims.width} x ${dims.height}`);
            console.log(`MLKit max: ${mlkitMaxX} x ${mlkitMaxY}`);
            console.log(`Scale X: ${scaleX.toFixed(3)}, Y: ${scaleY.toFixed(3)}, using: ${frameScale.toFixed(3)}`);

            interface LineWithFrame {
                text: string;
                yTop: number;
                yBottom: number;
                xLeft: number;
                xRight: number;
            }

            const allLines: LineWithFrame[] = [];
            for (const block of result.blocks) {
                for (const line of block.lines) {
                    if (line.frame && line.text.trim()) {
                        allLines.push({
                            text: line.text.trim(),
                            yTop: line.frame.top * frameScale,
                            yBottom: (line.frame.top + line.frame.height) * frameScale,
                            xLeft: line.frame.left * frameScale,
                            xRight: (line.frame.left + line.frame.width) * frameScale,
                        });
                    }
                }
            }
            allLines.sort((a, b) => a.yTop - b.yTop);

            // Merge lines on same physical row (threshold also needs scaling — was 30 in MLKit coords)
            const mergedLines: LineWithFrame[] = [];
            const PRICE_RE = /^\d+[.,]\s?\d{2}\s*[AB]\s*$/;
            const ROW_THRESHOLD = 30 * frameScale;

            for (const line of allLines) {
                if (mergedLines.length > 0) {
                    const last = mergedLines[mergedLines.length - 1];
                    if (Math.abs(line.yTop - last.yTop) < ROW_THRESHOLD) {
                        if (PRICE_RE.test(line.text)) {
                            mergedLines.push({ ...line });
                        } else if (PRICE_RE.test(last.text)) {
                            mergedLines.splice(mergedLines.length - 1, 0, { ...line });
                        } else {
                            last.text = last.text + ' ' + line.text;
                            last.yTop = Math.min(last.yTop, line.yTop);
                            last.yBottom = Math.max(last.yBottom, line.yBottom);
                            last.xLeft = Math.min(last.xLeft, line.xLeft);
                            last.xRight = Math.max(last.xRight, line.xRight);
                        }
                        continue;
                    }
                }
                mergedLines.push({ ...line });
            }

            console.log('=== MERGED OCR LINES ===');
            mergedLines.forEach((l, i) => console.log(`${i}: [y=${Math.round(l.yTop)}] ${l.text}`));

            const lineTexts = mergedLines.map(l => l.text);

            setLoadingMessage('Analizuojama struktūra...');

            if (isRimiReceipt(lineTexts)) {
                const earlyHeader = parseRimiHeaderOnly(mergedLines);
                setHeader({
                    chainName: 'RIMI',
                    chainId: 2,
                    storeCode: earlyHeader.storeCode,
                    storeAddress: earlyHeader.storeAddress,
                    storeId: null,
                    storeName: null,
                    storeAddressMatched: null,
                    matchConfidence: null,
                    matchLoading: true,
                    rawText: earlyHeader.rawText,
                    region: earlyHeader.region,
                });
                setLoading(false);

                const parsed = parseRimiReceipt(mergedLines);
                
                console.log('=== PARSED REGIONS ===');
                console.log('Header region:', parsed.header.region);
                parsed.products.forEach((p, i) =>
                    console.log(`Product ${i} "${p.name}" region:`, p.region)
                );
                console.log('Footer region:', parsed.footer.region);

                await applyRimiResult(parsed.header, parsed.products, parsed.footer);
            } else {
                applyGenericResult(lineTexts);
                setLoading(false);
            }
        } catch (error) {
            console.error('OCR error:', error);
            setLoadingMessage('Klaida apdorojant kvitą');
            setLoading(false);
        }
    };

    const applyRimiResult = async (
        rHeader: RimiHeader,
        rProducts: RimiProduct[],
        rFooter: RimiFooter
    ) => {
        const chainId = 2; // Rimi

        // Match store via backend Levenshtein endpoint
        let storeId: number | null = null;
        let storeName: string | null = null;
        let storeAddressMatched: string | null = null;
        let matchConfidence: number | null = null;

        if (rHeader.storeAddress) {
            try {
                const url = `${API_BASE_URL}/api/stores/match?chainId=${chainId}&address=${encodeURIComponent(rHeader.storeAddress)}`;
                console.log('=== STORE MATCH REQUEST ===');
                console.log('URL:', url);
                console.log('OCR address:', rHeader.storeAddress);
                
                const res = await fetch(url);
                console.log('Response status:', res.status);
                
                const data = await res.json();
                console.log('Response data:', JSON.stringify(data));
                
                if (data?.match) {
                    storeId = data.match.storeId;
                    storeName = data.match.storeName;
                    storeAddressMatched = data.match.address;
                    matchConfidence = data.match.confidence;
                    console.log('Matched:', storeName, 'confidence:', matchConfidence);
                } else {
                    console.log('No match in response');
                }
            } catch (e) {
                console.warn('Store match failed:', e);
            }
        } else {
            console.log('No storeAddress parsed from OCR — skipping match');
        }

        setHeader({
            chainName: 'RIMI',
            chainId,
            storeCode: rHeader.storeCode,
            storeAddress: rHeader.storeAddress,
            storeId,
            storeName,
            storeAddressMatched,
            matchConfidence,
            matchLoading: false,
            rawText: rHeader.rawText,
            region: rHeader.region,
        });

        // Match products with StoreProduct (unchanged)
        // Match each product via backend endpoint, in parallel
        const AUTO_APPLY_THRESHOLD = 0.85;

        const matchPromises = rProducts.map(async (rp) => {
            let altMatches: ProductMatchOption[] = [];

            try {
                const params = new URLSearchParams({
                    chainId: String(chainId),
                    name: rp.name,
                });
                // Include amount/unit to boost matching when we have them
                if (rp.pricePerUnit !== null && rp.unit === 'kg') {
                    // For weighable items, amount in the DB is the package size, not the kg weight.
                    // Skip the hint; name-only match is safer.
                } else if (rp.unit && rp.unit !== 'vnt') {
                    // Edge case — pass through if we ever see other units
                }
                // For multi-buy (unit=vnt), skip amount hint too — quantity is count, not package size.

                const res = await fetch(`${API_BASE_URL}/api/store-products/match?${params.toString()}`);
                const data = await res.json();
                if (Array.isArray(data?.matches)) altMatches = data.matches;
            } catch (e) {
                console.warn(`Product match failed for "${rp.name}":`, e);
            }

            const top = altMatches[0] || null;
            const autoApply = top !== null && top.confidence >= AUTO_APPLY_THRESHOLD;

            return {
                name: rp.name,
                matchedName: top?.name ?? null,
                storeProductId: autoApply ? top!.storeProductId : null,
                storeProductImageUrl: top?.imageUrl ?? null,
                matchConfidence: top?.confidence ?? null,
                matchConfirmed: autoApply,
                altMatches,
                price: rp.price,
                promoPrice: rp.promoPrice,
                quantity: rp.quantity,
                unit: rp.unit,
                pricePerUnit: rp.pricePerUnit,
                rawLines: rp.rawLines,
                region: rp.region,
            } as ProductLine;
        });

        const productLines = await Promise.all(matchPromises);
        setProducts(productLines);

        setFooter({
            total: rFooter.total,
            date: rFooter.date,
            time: rFooter.time,
            receiptNo: rFooter.receiptNo,
            totalSavings: rFooter.totalSavings,
            rawText: rFooter.rawText,
            region: rFooter.region,
        });

    };
    const applyGenericResult = (lines: string[]) => {
        setHeader({
            chainName: 'Neatpažinta',
            chainId: null,
            storeCode: '',
            storeAddress: '',
            storeId: null,
            storeName: null,
            storeAddressMatched: null,
            matchConfidence: null,
            matchLoading: false,
            rawText: lines.slice(0, 5).join('\n'),
            region: { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 },
        });
        setProducts([]);
        setFooter({
            total: null,
            date: '',
            time: '',
            receiptNo: '',
            totalSavings: null,
            rawText: lines.slice(-5).join('\n'),
            region: { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 },
        });
    };

    // Simple similarity score (Dice coefficient on bigrams)
    const similarity = (a: string, b: string): number => {
        if (!a || !b) return 0;
        if (a === b) return 1;
        const bigrams = (s: string) => {
            const set = new Set<string>();
            for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
            return set;
        };
        const aSet = bigrams(a);
        const bSet = bigrams(b);
        let intersection = 0;
        for (const bg of aSet) if (bSet.has(bg)) intersection++;
        return (2 * intersection) / (aSet.size + bSet.size);
    };

    if (loading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#2e7d32" />
                <Text style={styles.loadingText}>{loadingMessage}</Text>
            </View>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: 'Kvito peržiūra' }} />
            <ScrollView style={styles.container}>
                {/* Header section */}
                <TouchableOpacity
                    style={styles.sectionCard}
                    onPress={() => setEditingSection(editingSection === 'header' ? null : 'header')}
                >
                    <View style={styles.sectionContent}>
                        <View style={styles.chainRow}>
                            <Text style={styles.chainBadge}>{header?.chainName || 'Neatpažinta'}</Text>
                            {header?.matchLoading && (
                                <ActivityIndicator size="small" color="#2e7d32" style={{ marginLeft: 8 }} />
                            )}
                            {!header?.matchLoading && header?.storeId && (
                                <Ionicons name="checkmark-circle" size={20} color="#2e7d32" style={{ marginLeft: 8 }} />
                            )}
                            {!header?.matchLoading && !header?.storeId && header?.chainId && (
                                <Ionicons name="alert-circle" size={20} color="#f57c00" style={{ marginLeft: 8 }} />
                            )}
                        </View>
                        {header?.storeName && (
                            <Text style={styles.storeName}>{header.storeName}</Text>
                        )}
                        {header?.storeAddressMatched ? (
                            <Text style={styles.sectionSubvalue}>{header.storeAddressMatched}</Text>
                        ) : header?.storeAddress ? (
                            <Text style={styles.sectionSubvalue}>{header.storeAddress}</Text>
                        ) : null}
                        {!header?.matchLoading && header?.storeId === null && header?.chainId && (
                            <Text style={styles.warningText}>Parduotuvė neatpažinta</Text>
                        )}
                    </View>
                    {editingSection === 'header' && header?.region && imageUri && imageDims && (
                        <View style={styles.editSection}>
                            <Text style={styles.rawTextLabel}>Nuskaitytas regionas:</Text>
                            <RegionPreview
                                imageUri={imageUri}
                                imageWidth={imageDims.width}
                                imageHeight={imageDims.height}
                                region={header.region}
                                cardWidth={CARD_WIDTH}
                            />
                        </View>
                    )}
                </TouchableOpacity>

                {/* Products section */}
                <View style={styles.productsHeader}>
                    <Ionicons name="cart-outline" size={20} color="#2e7d32" />
                    <Text style={styles.sectionTitle}>Prekės ({products.length})</Text>
                </View>

                {products.map((product, index) => (
                    <TouchableOpacity
                        key={index}
                        style={styles.productCard}
                        onPress={() => setEditingSection(editingSection === index ? null : index)}
                    >
                        <View style={styles.productRow}>
                            {product.storeProductImageUrl && (
                                <Image
                                    source={{ uri: product.storeProductImageUrl }}
                                    style={styles.productThumb}
                                    resizeMode="contain"
                                />
                            )}
                            <View style={styles.productInfo}>
                                {product.matchedName ? (
                                    <>
                                        <Text style={[
                                            styles.matchedName,
                                            !product.matchConfirmed && { color: '#f57c00' }
                                        ]}>
                                            {product.matchedName}
                                        </Text>
                                        <Text style={styles.ocrName}>{product.name}</Text>
                                    </>
                                ) : (
                                    <Text style={styles.productName}>{product.name}</Text>
                                )}
                                {product.quantity !== 1 && (
                                    <Text style={styles.productQuantity}>
                                        {product.quantity} {product.unit}
                                        {product.pricePerUnit ? ` × €${product.pricePerUnit.toFixed(2)}/${product.unit}` : ''}
                                    </Text>
                                )}
                            </View>
                            <View style={styles.productPriceCol}>
                                {product.promoPrice !== null ? (
                                    <>
                                        <Text style={styles.productPriceStrike}>€{product.price.toFixed(2)}</Text>
                                        <Text style={styles.productPromoPrice}>€{product.promoPrice.toFixed(2)}</Text>
                                    </>
                                ) : (
                                    <Text style={styles.productPrice}>€{product.price.toFixed(2)}</Text>
                                )}
                            </View>
                            <TouchableOpacity
                                style={styles.matchIndicator}
                                onPress={(e) => {
                                    e.stopPropagation?.();  // don't toggle the raw-text editing section
                                    setPickerState({ productIndex: index });
                                }}
                            >
                                <Ionicons
                                    name={
                                        product.matchConfirmed ? 'checkmark-circle' :
                                        product.matchedName ? 'warning' :
                                        'help-circle-outline'
                                    }
                                    size={20}
                                    color={
                                        product.matchConfirmed ? '#2e7d32' :
                                        product.matchedName ? '#f57c00' :
                                        '#9e9e9e'
                                    }
                                />
                            </TouchableOpacity>
                        </View>

                        {editingSection === index && (
                        <View style={styles.editSection}>
                            <Text style={styles.rawTextLabel}>Nuskaitytas regionas:</Text>
                            {imageUri && imageDims && (
                                <RegionPreview
                                    imageUri={imageUri}
                                    imageWidth={imageDims.width}
                                    imageHeight={imageDims.height}
                                    region={product.region}
                                    cardWidth={CARD_WIDTH}
                                />
                            )}
                            <View style={{ height: 12 }} />
                            <TextInput
                                    style={styles.editInput}
                                    value={product.name}
                                    onChangeText={(text) => {
                                        setProducts(prev => {
                                            const updated = [...prev];
                                            updated[index] = { ...updated[index], name: text };
                                            return updated;
                                        });
                                    }}
                                    placeholder="Pavadinimas"
                                    placeholderTextColor="#9e9e9e"
                                />
                                <View style={styles.editRow}>
                                    <View style={styles.editField}>
                                        <Text style={styles.editLabel}>Kaina</Text>
                                        <TextInput
                                            style={styles.editInput}
                                            value={product.price.toString()}
                                            onChangeText={(text) => {
                                                setProducts(prev => {
                                                    const updated = [...prev];
                                                    updated[index] = { ...updated[index], price: parseFloat(text) || 0 };
                                                    return updated;
                                                });
                                            }}
                                            keyboardType="decimal-pad"
                                        />
                                    </View>
                                    <View style={styles.editField}>
                                        <Text style={styles.editLabel}>Galutinė kaina</Text>
                                        <TextInput
                                            style={styles.editInput}
                                            value={product.promoPrice?.toString() || ''}
                                            onChangeText={(text) => {
                                                setProducts(prev => {
                                                    const updated = [...prev];
                                                    updated[index] = { ...updated[index], promoPrice: text ? parseFloat(text) || null : null };
                                                    return updated;
                                                });
                                            }}
                                            keyboardType="decimal-pad"
                                            placeholder="—"
                                        />
                                    </View>
                                </View>
                            </View>
                        )}
                    </TouchableOpacity>
                ))}

                {products.length === 0 && (
                    <View style={styles.emptyProducts}>
                        <Ionicons name="alert-circle-outline" size={32} color="#e0e0e0" />
                        <Text style={styles.emptyText}>Prekės neatpažintos</Text>
                    </View>
                )}

                {/* Footer section */}
                <TouchableOpacity
                    style={styles.sectionCard}
                    onPress={() => setEditingSection(editingSection === 'footer' ? null : 'footer')}
                >
                    <View style={styles.sectionHeader}>
                        <Ionicons name="document-text-outline" size={20} color="#2e7d32" />
                        <Text style={styles.sectionTitle}>Kvito duomenys</Text>
                        <Ionicons
                            name={editingSection === 'footer' ? 'chevron-up' : 'chevron-down'}
                            size={18} color="#757575"
                        />
                    </View>
                    <View style={styles.footerContent}>
                        <View style={styles.footerRow}>
                            <Text style={styles.footerLabel}>Suma:</Text>
                            <Text style={styles.footerValue}>
                                {footer?.total ? `€${footer.total.toFixed(2)}` : '—'}
                            </Text>
                        </View>
                        <View style={styles.footerRow}>
                            <Text style={styles.footerLabel}>Data:</Text>
                            <Text style={styles.footerValue}>
                                {footer?.date || '—'} {footer?.time || ''}
                            </Text>
                        </View>
                        <View style={styles.footerRow}>
                            <Text style={styles.footerLabel}>Kvito Nr.:</Text>
                            <Text style={styles.footerValue}>{footer?.receiptNo || '—'}</Text>
                        </View>
                    </View>
                    {editingSection === 'footer' && footer?.region && imageUri && imageDims && (
                        <View style={styles.editSection}>
                            <Text style={styles.rawTextLabel}>Nuskaitytas regionas:</Text>
                            <RegionPreview
                                imageUri={imageUri}
                                imageWidth={imageDims.width}
                                imageHeight={imageDims.height}
                                region={footer.region}
                                cardWidth={CARD_WIDTH}
                            />
                        </View>
                    )}
                </TouchableOpacity>

                {/* Save button */}
                <TouchableOpacity style={styles.saveButton} onPress={() => {
                    // TODO: Save to backend
                    console.log('Header:', header);
                    console.log('Products:', products);
                    console.log('Footer:', footer);
                    router.back();
                }}>
                    <Ionicons name="save-outline" size={20} color="white" />
                    <Text style={styles.saveText}>Išsaugoti</Text>
                </TouchableOpacity>

                <View style={{ height: 40 }} />
            </ScrollView>
            {pickerState !== null && (
            <Modal
                transparent
                animationType="fade"
                onRequestClose={() => setPickerState(null)}
            >
                <TouchableOpacity
                    style={styles.modalBackdrop}
                    activeOpacity={1}
                    onPress={() => setPickerState(null)}
                >
                    <View style={styles.modalCard}>
                        <Text style={styles.modalTitle}>Pasirinkite prekę</Text>
                        <Text style={styles.modalSubtitle}>
                            {products[pickerState.productIndex]?.name}
                        </Text>
                        {products[pickerState.productIndex]?.altMatches.length === 0 && (
                            <Text style={styles.emptyText}>Atitikmenų nerasta</Text>
                        )}
                        {products[pickerState.productIndex]?.altMatches.map(alt => (
                            <TouchableOpacity
                                key={alt.storeProductId}
                                style={styles.modalOption}
                                onPress={() => {
                                    const idx = pickerState.productIndex;
                                    setProducts(prev => {
                                        const updated = [...prev];
                                        updated[idx] = {
                                            ...updated[idx],
                                            matchedName: alt.name,
                                            storeProductId: alt.storeProductId,
                                            storeProductImageUrl: alt.imageUrl,
                                            matchConfidence: alt.confidence,
                                            matchConfirmed: true,
                                        };
                                        return updated;
                                    });
                                    setPickerState(null);
                                }}
                            >
                                {alt.imageUrl && (
                                    <Image
                                        source={{ uri: alt.imageUrl }}
                                        style={styles.modalThumb}
                                        resizeMode="contain"
                                    />
                                )}
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.modalOptionName}>{alt.name}</Text>
                                    <Text style={styles.modalOptionMeta}>
                                        Tikimybė {Math.round(alt.confidence * 100)}%
                                    </Text>
                                </View>
                            </TouchableOpacity>
                        ))}
                        <TouchableOpacity
                            style={styles.modalCancel}
                            onPress={() => setPickerState(null)}
                        >
                            <Text style={styles.modalCancelText}>Atšaukti</Text>
                        </TouchableOpacity>
                    </View>
                </TouchableOpacity>
            </Modal>
        )}
        </>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f5f5f5',
        gap: 16,
    },
    loadingText: { fontSize: 15, color: '#757575' },

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
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    sectionTitle: {
        flex: 1,
        fontSize: 15,
        fontWeight: '600',
        color: '#212121',
    },
    sectionContent: { marginTop: 10 },
    chainBadge: {
        fontSize: 18,
        fontWeight: '700',
        color: '#212121',
    },
    storeName: {
        fontSize: 14,
        color: '#424242',
        marginTop: 4,
    },
    sectionSubvalue: {
        fontSize: 13,
        color: '#757575',
        marginTop: 2,
    },
    warningText: {
        fontSize: 12,
        color: '#f57c00',
        marginTop: 4,
    },

    productsHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 16,
        marginTop: 20,
        marginBottom: 4,
    },
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
    productRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    productInfo: { flex: 1 },
    productName: {
        fontSize: 14,
        color: '#212121',
        fontWeight: '500',
    },
    matchedName: {
        fontSize: 14,
        color: '#2e7d32',
        fontWeight: '600',
    },
    ocrName: {
        fontSize: 11,
        color: '#9e9e9e',
        marginTop: 2,
    },
    productQuantity: {
        fontSize: 12,
        color: '#757575',
        marginTop: 2,
    },
    productPriceCol: {
        alignItems: 'flex-end',
        marginRight: 8,
    },
    productPrice: {
        fontSize: 15,
        fontWeight: '700',
        color: '#212121',
    },
    productPriceStrike: {
        fontSize: 12,
        color: '#9e9e9e',
        textDecorationLine: 'line-through',
    },
    productPromoPrice: {
        fontSize: 15,
        fontWeight: '700',
        color: '#d32f2f',
    },
    matchIndicator: {
        marginLeft: 4,
    },

    editSection: {
        marginTop: 12,
        paddingTop: 12,
        borderTopWidth: 0.5,
        borderTopColor: '#e0e0e0',
    },
    rawTextLabel: {
        fontSize: 11,
        color: '#9e9e9e',
        marginBottom: 4,
    },
    rawText: {
        fontSize: 12,
        color: '#757575',
        fontFamily: 'monospace',
        backgroundColor: '#fafafa',
        padding: 8,
        borderRadius: 6,
        marginBottom: 10,
    },
    editInput: {
        borderWidth: 1,
        borderColor: '#e0e0e0',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
        color: '#212121',
        marginBottom: 8,
    },
    editRow: {
        flexDirection: 'row',
        gap: 8,
    },
    editField: {
        flex: 1,
    },
    editLabel: {
        fontSize: 11,
        color: '#9e9e9e',
        marginBottom: 4,
    },

    footerContent: { marginTop: 10 },
    footerRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 4,
    },
    footerLabel: {
        fontSize: 13,
        color: '#757575',
    },
    footerValue: {
        fontSize: 13,
        fontWeight: '600',
        color: '#212121',
    },

    emptyProducts: {
        alignItems: 'center',
        padding: 32,
        gap: 8,
    },
    emptyText: {
        fontSize: 14,
        color: '#9e9e9e',
    },

    saveButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: '#2e7d32',
        marginHorizontal: 16,
        marginTop: 24,
        paddingVertical: 14,
        borderRadius: 12,
    },
    saveText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '700',
    },
    chainRow: { flexDirection: 'row', alignItems: 'center' },
    productThumb: {
        width: 48,
        height: 48,
        borderRadius: 6,
        backgroundColor: '#fafafa',
        marginRight: 10,
    },

    modalBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    modalCard: {
        backgroundColor: 'white',
        borderRadius: 12,
        padding: 16,
        width: '100%',
        maxWidth: 480,
    },
    modalTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: '#212121',
        marginBottom: 4,
    },
    modalSubtitle: {
        fontSize: 12,
        color: '#9e9e9e',
        marginBottom: 12,
    },
    modalOption: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        borderTopWidth: 0.5,
        borderTopColor: '#e0e0e0',
    },
    modalThumb: {
        width: 44,
        height: 44,
        borderRadius: 6,
        backgroundColor: '#fafafa',
        marginRight: 12,
    },
    modalOptionName: {
        fontSize: 14,
        color: '#212121',
        fontWeight: '500',
    },
    modalOptionMeta: {
        fontSize: 11,
        color: '#9e9e9e',
        marginTop: 2,
    },
    modalCancel: {
        marginTop: 12,
        paddingVertical: 10,
        alignItems: 'center',
    },
    modalCancelText: {
        fontSize: 14,
        color: '#757575',
        fontWeight: '600',
    },
});