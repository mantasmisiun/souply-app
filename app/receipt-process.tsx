import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Image, ActivityIndicator, TextInput, Dimensions, Modal, DimensionValue } from 'react-native';
import { useState, useEffect, useRef } from 'react';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import { isRimiReceipt, parseRimiReceipt, parseRimiHeaderOnly, RimiProduct, RimiHeader, RimiFooter, Region, RimiLine } from '../utils/rimiParser';
import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';
import { useReceiptPickerState } from '../state/basketState';

interface ProductMatchOption {
    storeProductId: number;
    productId: number;
    categoryId: number;
    name: string;
    imageUrl: string | null;
    amount: number | null;
    unit: string | null;
    confidence: number;
}

interface ProductLine {
    name: string;
    matchedName: string | null;
    storeProductId: number | null;
    storeProductImageUrl: string | null;
    matchConfidence: number | null;
    matchConfirmed: boolean;
    altMatches: ProductMatchOption[];
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
    storeAddress: string;
    storeId: number | null;
    storeName: string | null;
    storeAddressMatched: string | null;
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
interface ComparisonChain {
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

interface ReceiptComparison {
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
    alternatives: ComparisonChain[];
    summary: {
        recognizedItems: number;
        excludedItems: number;
        note?: string;
    };
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const CARD_WIDTH = Dimensions.get('window').width - 32 - 32;

function RegionPreview({ imageUri, imageWidth, imageHeight, region, cardWidth }: RegionPreviewProps) {
    if (region.yBottom <= region.yTop || region.xRight <= region.xLeft) return null;

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

/**
 * Build the parsedData payload sent to the backend.
 * Mirrors the shape agreed on in receiptSaveService.ts on the API side.
 */
function buildParsedData(
    header: HeaderData,
    products: ProductLine[],
    footer: FooterData,
    imageMeta: { uri: string | null; width: number; height: number } | null,
    imageFilePath: string | null
): object {
    return {
        version: 1,
        image: imageMeta ? {
            filePath: imageFilePath,
            width: imageMeta.width,
            height: imageMeta.height,
        } : null,
        header,
        products,
        footer,
    };
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
    const { pendingPick, clearPendingPick } = useReceiptPickerState();

    // Save state
    const [receiptId, setReceiptId] = useState<number | null>(null);
    const [imageFilePath, setImageFilePath] = useState<string | null>(null);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
    const [comparison, setComparison] = useState<ReceiptComparison | null>(null);
    const [comparisonLoading, setComparisonLoading] = useState(false);
    const [comparisonError, setComparisonError] = useState<string | null>(null);

    const fetchComparison = async (id: number) => {
        try {
            setComparisonLoading(true);
            setComparisonError(null);

            const res = await fetch(`${API_BASE_URL}/api/receipts/${id}/comparison`);
            if (!res.ok) {
                const errBody = await res.json().catch(() => ({}));
                throw new Error(errBody?.error || 'Nepavyko gauti palyginimo');
            }

            const data = await res.json();
            setComparison(data);
        } catch (e: any) {
            console.warn('Comparison fetch failed:', e);
            setComparisonError(e?.message || 'Nepavyko gauti palyginimo');
        } finally {
            setComparisonLoading(false);
        }
    };
    useEffect(() => {
        if (!receiptId) return;
        if (saveStatus !== 'saved') return;
        fetchComparison(receiptId);
    }, [receiptId, saveStatus]);

    // Refs for debounced save machinery (no re-renders, live values for unmount cleanup)
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingSaveRef = useRef<object | null>(null);
    const receiptIdRef = useRef<number | null>(null);
    const userIdRef = useRef<string | null>(null);
    const hasPostedRef = useRef(false);  // guard against double POST from re-renders

    // Keep refs in sync with state
    useEffect(() => { receiptIdRef.current = receiptId; }, [receiptId]);

    // Cache userId on mount so unmount flush can use it synchronously
    useEffect(() => {
        (async () => {
            const id = await getUserId();
            userIdRef.current = id;
        })();
    }, []);

    // Kick off OCR when uri is provided
    useEffect(() => {
        if (uri) {
            const decoded = decodeURIComponent(uri);
            setImageUri(decoded);
            processReceipt(decoded);
        }
    }, [uri]);

    // Apply user's manual pick from the category browser
    useEffect(() => {
        if (!pendingPick) return;
        const { productIndex, storeProductId, storeProductName, imageUrl } = pendingPick;

        setProducts(prev => {
            if (productIndex < 0 || productIndex >= prev.length) return prev;
            const updated = [...prev];
            updated[productIndex] = {
                ...updated[productIndex],
                matchedName: storeProductName,
                storeProductId,
                storeProductImageUrl: imageUrl,
                matchConfidence: 1,
                matchConfirmed: true,
            };
            return updated;
        });

        clearPendingPick();
    }, [pendingPick, clearPendingPick]);

    // Step 1: POST receipt once OCR + store match + product match have all completed
    useEffect(() => {
        if (hasPostedRef.current) return;
        if (!header || !footer) return;         // parsing not done
        if (header.matchLoading) return;         // store match still running
        // products may be empty array (receipt with no recognized items), that's fine

        hasPostedRef.current = true;
        (async () => {
            try {
                const userId = userIdRef.current ?? await getUserId();
                userIdRef.current = userId;

                const parsedData = buildParsedData(header, products, footer, imageDims ? { uri: imageUri, ...imageDims } : null, imageFilePath);

                const res = await fetch(`${API_BASE_URL}/api/receipts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, filePath: '', parsedData }),
                });
                const data = await res.json();
                if (data?.id) {
                    setReceiptId(data.id);
                    setSaveStatus('saved');
                    fetchComparison(data.id); // immediate first fetch
                } else {
                    console.warn('Receipt POST returned no id:', data);
                    setSaveStatus('error');
                    hasPostedRef.current = false;  // allow retry on next state change
                }
            } catch (e) {
                console.warn('Receipt POST failed:', e);
                setSaveStatus('error');
                hasPostedRef.current = false;
            }
        })();
    }, [header, footer, products]);

    // Step 2: MinIO upload — runs in parallel with POST, PATCH filePath once done
    useEffect(() => {
        if (!imageUri || !receiptId || imageFilePath) return;

        (async () => {
            try {
                // Get presigned PUT URL
                const urlRes = await fetch(`${API_BASE_URL}/api/receipts/upload-url`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename: `receipt-${receiptId}.jpg`,
                        mimeType: 'image/jpeg',
                    }),
                });
                const { uploadUrl, filePath } = await urlRes.json();

                // Upload the image bytes (fetch(uri) returns a blob for local files)
                const imageBlob = await (await fetch(imageUri)).blob();
                await fetch(uploadUrl, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'image/jpeg' },
                    body: imageBlob,
                });

                // PATCH the receipt with the filePath
                await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/file-path`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filePath }),
                });

                setImageFilePath(filePath);
            } catch (e) {
                console.warn('MinIO upload failed:', e);
            }
        })();
    }, [imageUri, receiptId, imageFilePath]);

    // Step 3: debounced PUT on any parsedData change
    useEffect(() => {
        if (!receiptId) return;        // POST hasn't completed yet
        if (!header || !footer) return;

        const parsedData = buildParsedData(
            header, products, footer,
            imageDims ? { uri: imageUri, ...imageDims } : null,
            imageFilePath
        );
        scheduleDebouncedSave(parsedData);
    }, [header, products, footer, receiptId, imageFilePath]);

    // Unmount flush
    useEffect(() => {
        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            const id = receiptIdRef.current;
            const userId = userIdRef.current;
            const snapshot = pendingSaveRef.current;
            if (id && userId && snapshot) {
                // Fire and forget — component is tearing down, can't await
                fetch(`${API_BASE_URL}/api/receipts/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, parsedData: snapshot }),
                }).catch(err => console.warn('Unmount flush failed:', err));
                pendingSaveRef.current = null;
            }
        };
    }, []);

    const saveNow = async (id: number, data: object) => {
        try {
            setSaveStatus('saving');
            const userId = userIdRef.current ?? await getUserId();
            userIdRef.current = userId;

            await fetch(`${API_BASE_URL}/api/receipts/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, parsedData: data }),
            });
            setSaveStatus('saved');
            await fetch(`${API_BASE_URL}/api/receipts/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, parsedData: data }),
            });
            setSaveStatus('saved');
            fetchComparison(id);
            } catch (e) {
            console.warn('Save failed:', e);
            setSaveStatus('error');
        }
    };

    const scheduleDebouncedSave = (data: object) => {
        pendingSaveRef.current = data;

        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

        saveTimerRef.current = setTimeout(() => {
            const id = receiptIdRef.current;
            const snapshot = pendingSaveRef.current;
            if (id && snapshot) {
                saveNow(id, snapshot);
                pendingSaveRef.current = null;
            }
            saveTimerRef.current = null;
        }, 1500);
    };

    const handleBrowseCategories = async () => {
        if (pickerState === null) return;
        const idx = pickerState.productIndex;
        const product = products[idx];
        const topMatch = product.altMatches[0];

        let preselectL1: string | undefined;
        let preselectL2: string | undefined;
        let preselectL3: string | undefined;

        if (topMatch) {
            try {
                const res = await fetch(`${API_BASE_URL}/api/categories/${topMatch.categoryId}/ancestors`);
                const data = await res.json();
                if (data?.l1) preselectL1 = String(data.l1.id);
                if (data?.l2) preselectL2 = String(data.l2.id);
                if (data?.l3) preselectL3 = String(data.l3.id);
            } catch (e) {
                console.warn('Ancestor lookup failed:', e);
            }
        }

        const chainId = header?.chainId ?? 2;
        setPickerState(null);

        if (preselectL1 && preselectL2) {
            router.push({
                pathname: '/receipt/browse',
                params: { chainId: String(chainId), productIndex: String(idx), preselectL1 },
            });
            setTimeout(() => {
                router.push({
                    pathname: '/receipt/browse/[categoryId]',
                    params: {
                        categoryId: preselectL2!,
                        name: '',
                        chainId: String(chainId),
                        productIndex: String(idx),
                        ...(preselectL3 ? { preselectL3 } : {}),
                    },
                });
            }, 50);
        } else {
            router.push({
                pathname: '/receipt/browse',
                params: { chainId: String(chainId), productIndex: String(idx) },
            });
        }
    };

    const processReceipt = async (imageUri: string) => {
        try {
            setLoading(true);
            setLoadingMessage('Atpažįstamas tekstas...');

            const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
                Image.getSize(imageUri, (width, height) => resolve({ width, height }), reject);
            });
            setImageDims(dims);

            const result = await TextRecognition.recognize(imageUri);

            let mlkitMaxX = 0, mlkitMaxY = 0;
            for (const block of result.blocks) {
                for (const line of block.lines) {
                    if (line.frame) {
                        mlkitMaxX = Math.max(mlkitMaxX, line.frame.left + line.frame.width);
                        mlkitMaxY = Math.max(mlkitMaxY, line.frame.top + line.frame.height);
                    }
                }
            }

            const scaleX = dims.width / mlkitMaxX;
            const scaleY = dims.height / mlkitMaxY;
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

    const applyRimiResult = async (rHeader: RimiHeader, rProducts: RimiProduct[], rFooter: RimiFooter) => {
        const chainId = 2;

        let storeId: number | null = null;
        let storeName: string | null = null;
        let storeAddressMatched: string | null = null;
        let matchConfidence: number | null = null;

        if (rHeader.storeAddress) {
            try {
                const url = `${API_BASE_URL}/api/stores/match?chainId=${chainId}&address=${encodeURIComponent(rHeader.storeAddress)}`;
                const res = await fetch(url);
                const data = await res.json();
                if (data?.match) {
                    storeId = data.match.storeId;
                    storeName = data.match.storeName;
                    storeAddressMatched = data.match.address;
                    matchConfidence = data.match.confidence;
                }
            } catch (e) {
                console.warn('Store match failed:', e);
            }
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

        const AUTO_APPLY_THRESHOLD = 0.85;

        const matchPromises = rProducts.map(async (rp) => {
            let altMatches: ProductMatchOption[] = [];

            try {
                const params = new URLSearchParams({
                    chainId: String(chainId),
                    name: rp.name,
                });
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

    if (loading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#2e7d32" />
                <Text style={styles.loadingText}>{loadingMessage}</Text>
            </View>
        );
    }

    // Save status badge (under the title, pill-style)
    const renderStatusBadge = () => {
        if (saveStatus === 'idle') return null;
        const config = {
            saving: { bg: '#e3f2fd', color: '#1565c0', text: 'Saugoma…' },
            saved:  { bg: '#e8f5e9', color: '#2e7d32', text: 'Išsaugota' },
            error:  { bg: '#ffebee', color: '#c62828', text: 'Nepavyko išsaugoti' },
        }[saveStatus];
        return (
            <View style={[styles.statusBadgeWrap]}>
                <View style={[styles.statusBadge, { backgroundColor: config.bg }]}>
                    <Text style={[styles.statusBadgeText, { color: config.color }]}>
                        {config.text}
                    </Text>
                </View>
            </View>
        );
    };

    return (
        <>
            <Stack.Screen options={{ title: 'Kvito peržiūra' }} />
            <ScrollView style={styles.container}>
                {renderStatusBadge()}
                {comparisonLoading && (
                    <View style={styles.sectionCard}>
                        <Text style={styles.sectionTitle}>Kainų palyginimas</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                            <ActivityIndicator size="small" color="#2e7d32" />
                            <Text style={styles.sectionSubvalue}>Skaičiuojama...</Text>
                        </View>
                    </View>
                )}

                {!!comparisonError && (
                    <View style={styles.sectionCard}>
                        <Text style={styles.sectionTitle}>Kainų palyginimas</Text>
                        <Text style={[styles.sectionSubvalue, { color: '#c62828', marginTop: 6 }]}>
                            {comparisonError}
                        </Text>
                    </View>
                )}

                {comparison && (() => {
                    const bestAlt = comparison.alternatives[0];
                    const hasSavings = !!bestAlt && bestAlt.savings > 0;

                    const totals = [
                        comparison.currentChain.total,
                        ...comparison.alternatives.map(a => a.total),
                    ].filter(n => Number.isFinite(n) && n >= 0);

                    const maxTotal = totals.length ? Math.max(...totals) : 1;
                    const barWidth = (total: number): DimensionValue => {
                        const pct = Math.max(8, (total / Math.max(maxTotal, 1)) * 100);
                        return `${pct}%` as `${number}%`;
                    };

                    return (
                        <View style={[styles.sectionCard, hasSavings && styles.savingsCard]}>
                            <Text style={styles.sectionTitle}>Kainų palyginimas</Text>

                            {hasSavings ? (
                                <Text style={styles.savingsText}>
                                    Sutaupytumėte €{bestAlt.savings.toFixed(2)} pasirinkę {bestAlt.chainName}
                                </Text>
                            ) : (
                                <Text style={styles.sectionSubvalue}>Pigiau nerasta pagal turimus duomenis</Text>
                            )}

                            <Text style={[styles.sectionSubvalue, { marginTop: 8 }]}>
                                Lyginta pagal {comparison.summary.recognizedItems} atpažintas prekes
                                {comparison.summary.excludedItems > 0 ? `, neįtraukta: ${comparison.summary.excludedItems}` : ''}
                            </Text>
                            {!!comparison.summary.note && (
                                <Text style={styles.warningText}>{comparison.summary.note}</Text>
                            )}

                            <View style={{ marginTop: 12, gap: 10 }}>
                                <View>
                                    <Text style={styles.footerLabel}>
                                        Jūsų parduotuvė: {comparison.currentChain.chainName} ({comparison.currentChain.storeName})
                                    </Text>
                                    <View style={styles.compareBarTrack}>
                                        <View style={[styles.compareBarFillCurrent, { width: barWidth(comparison.currentChain.total) }]} />
                                    </View>
                                    <Text style={styles.footerValue}>€{comparison.currentChain.total.toFixed(2)}</Text>
                                </View>

                                {comparison.alternatives.map((alt) => (
                                    <View key={`${alt.chainId}-${alt.storeId}`}>
                                        <Text style={styles.footerLabel}>
                                            {alt.chainName} ({alt.storeName}) • {alt.distanceKm.toFixed(1)} km
                                        </Text>
                                        <View style={styles.compareBarTrack}>
                                            <View style={[styles.compareBarFillAlt, { width: barWidth(alt.total) }]} />
                                        </View>
                                        <Text style={styles.footerValue}>
                                            €{alt.total.toFixed(2)}
                                            {alt.savings > 0 ? `  (−€${alt.savings.toFixed(2)})` : ''}
                                        </Text>
                                        {!!alt.note && <Text style={styles.warningText}>{alt.note}</Text>}
                                    </View>
                                ))}
                            </View>
                        </View>
                    );
                })()}

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
                                    e.stopPropagation?.();
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
                                style={styles.browseButton}
                                onPress={handleBrowseCategories}
                            >
                                <Ionicons name="grid-outline" size={18} color="white" />
                                <Text style={styles.browseButtonText}>Naršyti kategorijas</Text>
                            </TouchableOpacity>
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

    statusBadgeWrap: {
        alignItems: 'center',
        marginTop: 12,
    },
    statusBadge: {
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: 12,
    },
    statusBadgeText: {
        fontSize: 12,
        fontWeight: '600',
    },

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
    sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    sectionTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: '#212121' },
    sectionContent: { marginTop: 10 },
    chainBadge: { fontSize: 18, fontWeight: '700', color: '#212121' },
    storeName: { fontSize: 14, color: '#424242', marginTop: 4 },
    sectionSubvalue: { fontSize: 13, color: '#757575', marginTop: 2 },
    warningText: { fontSize: 12, color: '#f57c00', marginTop: 4 },

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

    editSection: {
        marginTop: 12,
        paddingTop: 12,
        borderTopWidth: 0.5,
        borderTopColor: '#e0e0e0',
    },
    rawTextLabel: { fontSize: 11, color: '#9e9e9e', marginBottom: 4 },
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
    editRow: { flexDirection: 'row', gap: 8 },
    editField: { flex: 1 },
    editLabel: { fontSize: 11, color: '#9e9e9e', marginBottom: 4 },

    footerContent: { marginTop: 10 },
    footerRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
    footerLabel: { fontSize: 13, color: '#757575' },
    footerValue: { fontSize: 13, fontWeight: '600', color: '#212121' },

    emptyProducts: { alignItems: 'center', padding: 32, gap: 8 },
    emptyText: { fontSize: 14, color: '#9e9e9e' },

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
    modalTitle: { fontSize: 16, fontWeight: '700', color: '#212121', marginBottom: 4 },
    modalSubtitle: { fontSize: 12, color: '#9e9e9e', marginBottom: 12 },
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
    modalOptionName: { fontSize: 14, color: '#212121', fontWeight: '500' },
    modalOptionMeta: { fontSize: 11, color: '#9e9e9e', marginTop: 2 },
    modalCancel: { marginTop: 12, paddingVertical: 10, alignItems: 'center' },
    modalCancelText: { fontSize: 14, color: '#757575', fontWeight: '600' },
    browseButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: '#2e7d32',
        borderRadius: 8,
        paddingVertical: 10,
        marginTop: 12,
    },
    browseButtonText: { color: 'white', fontSize: 14, fontWeight: '600' },
    savingsCard: {
        borderWidth: 1,
        borderColor: '#a5d6a7',
        backgroundColor: '#e8f5e9',
    },
    savingsText: {
        marginTop: 6,
        fontSize: 14,
        fontWeight: '700',
        color: '#1b5e20',
    },
    compareBarTrack: {
        marginTop: 6,
        height: 8,
        borderRadius: 999,
        backgroundColor: '#eeeeee',
        overflow: 'hidden',
    },
    compareBarFillCurrent: {
        height: '100%',
        backgroundColor: '#1565c0',
        borderRadius: 999,
    },
    compareBarFillAlt: {
        height: '100%',
        backgroundColor: '#2e7d32',
        borderRadius: 999,
    },
});