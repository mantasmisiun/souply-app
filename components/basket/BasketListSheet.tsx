import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { AddOrStepper } from '@/components/AddOrStepper';
import { DockedGlassSheet, type DockedSheetControls } from '../DockedGlassSheet';
import { useTheme, useResolvedScheme, radius, spacing, type AppTheme } from '../../constants/theme';
import { API_BASE_URL } from '../../config/api';
import { useBasketSession, targetKey } from '../../state/basketSession';
import { getTemplate, patchTemplateItem, deleteTemplateItem } from '../../utils/basketTemplatesApi';

/**
 * BasketListSheet — the ACTIVE-session view ("collecting items"), rendered
 * ONCE at the app root (above the Stack) so it stays pinned and stable while
 * you navigate the shopping flow: Naršyti → L2 → Discounts → Search → Product.
 * A single DockedGlassSheet instance persists across those routes (no remount,
 * no reload). Its collapsed bar is the session header ([X] Prekės: N
 * [Krepšelis ›]); dragging up previews the basket's items (Find-My reveal).
 *
 * The tab-bar dock (BasketDockSheet) only starts sessions (the chooser); once
 * a basket is picked this takes over as the persistent indicator.
 */

const ROUTE_PREFIXES = ['/catalog', '/browse', '/search', '/discounts', '/product'];
const SESSION_H = 62;

interface PreviewItem {
    id: number;
    productId: number;
    quantity: number;
    name: string | null;
    imageUrl: string | null;
    isWeighable: boolean;
    canonicalUnit: string | null;
}

export function BasketListSheet() {
    const colors = useTheme();
    const isDark = useResolvedScheme() === 'dark';
    const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);
    const { t } = useTranslation();
    const router = useRouter();
    const pathname = usePathname();

    const target = useBasketSession(s => s.target);
    const barVisible = useBasketSession(s => s.barVisible);
    const itemCount = useBasketSession(s => s.itemCount);
    const dismissBar = useBasketSession(s => s.dismissBar);
    const setCount = useBasketSession(s => s.setCount);
    const browseListRef = useBasketSession(s => s.browseListRef);
    const basketRev = useBasketSession(s => s.basketRev);
    const setCollapseDock = useBasketSession(s => s.setCollapseDock);

    const onSurface = ROUTE_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`));
    const onTabRoot = pathname === '/catalog';
    const sessionActive = target != null && barVisible;
    const visible = onSurface && sessionActive;

    const controls = useRef<DockedSheetControls | null>(null);

    // Items load only when the BASKET changes — never on navigation, so the
    // sheet stays visually stable as you move between shopping screens.
    const [items, setItems] = useState<PreviewItem[] | null>(null);
    const tKey = target ? targetKey(target) : null;
    const loadItems = useCallback(async () => {
        if (!target) return;
        try {
            let raw: any[];
            if (target.kind === 'template') {
                const tpl = await getTemplate(target.templateId);
                raw = Array.isArray(tpl.items) ? tpl.items : [];
            } else {
                const res = await fetch(`${API_BASE_URL}/api/baskets/${target.basketId}/items`);
                const data = await res.json();
                raw = Array.isArray(data) ? data : [];
            }
            const rows: PreviewItem[] = raw.map((it: any) => ({
                id: it.id,
                productId: it.productId,
                quantity: Number(it.quantity) || 1,
                name: it.productName ?? it.name ?? null,
                imageUrl: Array.isArray(it.imageUrls) ? it.imageUrls.find(Boolean) ?? null : null,
                isWeighable: !!it.isWeighable,
                canonicalUnit: it.canonicalUnit ?? null,
            }));
            setItems(rows);
            setCount(rows.length);
        } catch { setItems([]); }
    }, [target, setCount]);
    useEffect(() => { if (target != null) loadItems(); else setItems(null); }, [tKey]); // eslint-disable-line react-hooks/exhaustive-deps
    // An add from a product/search/L2 "Add" button bumps basketRev — re-fetch so
    // the new item actually appears (the counter alone was updating).
    const firstRev = useRef(basketRev);
    useEffect(() => {
        if (basketRev !== firstRev.current && target != null && visible) loadItems();
        firstRev.current = basketRev;
    }, [basketRev]); // eslint-disable-line react-hooks/exhaustive-deps

    // While the session view owns the bottom, page scrolls collapse it.
    useEffect(() => {
        if (!visible) return;
        setCollapseDock(() => controls.current?.collapse());
        return () => setCollapseDock(null);
    }, [visible, setCollapseDock]);

    // Navigating to a new screen (e.g. tapping a product to open its detail)
    // collapses the sheet so it doesn't cover the destination — the header
    // stays pinned, the expanded list drops away.
    const prevPath = useRef(pathname);
    useEffect(() => {
        if (pathname !== prevPath.current) {
            prevPath.current = pathname;
            controls.current?.collapse();
        }
    }, [pathname]);

    // A freshly-picked basket opens expanded (showing its items); re-entry after
    // navigation keeps whatever state the sheet was in.
    const prevBasket = useRef<string | null>(null);
    useEffect(() => {
        if (tKey != null && tKey !== prevBasket.current) {
            prevBasket.current = tKey;
            const id = setTimeout(() => controls.current?.expand(), 60);
            return () => clearTimeout(id);
        }
        if (tKey == null) prevBasket.current = null;
    }, [tKey]);  

    // Remove the whole line (the trash icon) — from the basket or the template.
    const removeItem = useCallback((item: PreviewItem) => {
        setItems(prev => prev?.filter(i => i.id !== item.id) ?? null);
        useBasketSession.getState().bumpCount(-1);
        const t = useBasketSession.getState().target;
        if (t?.kind === 'template') deleteTemplateItem(t.templateId, item.id).catch(() => {});
        else fetch(`${API_BASE_URL}/api/basket-items/${item.id}`, { method: 'DELETE' }).catch(() => {});
    }, []);

    // Persist a new quantity for a line (AddOrStepper does the canonical
    // stepping; 0 = remove) — basket item PUT or template item PATCH.
    const commitItem = useCallback((item: PreviewItem, qty: number) => {
        if (qty <= 0) { removeItem(item); return; }
        setItems(prev => prev?.map(i => (i.id === item.id ? { ...i, quantity: qty } : i)) ?? null);
        const t = useBasketSession.getState().target;
        if (t?.kind === 'template') {
            patchTemplateItem(t.templateId, item.id, { quantity: qty }).catch(() => {});
        } else {
            fetch(`${API_BASE_URL}/api/basket-items/${item.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: qty }),
            }).catch(() => {});
        }
    }, [removeItem]);

    const sessionHeader = (
        <View style={styles.header}>
            <TouchableOpacity onPress={() => dismissBar()} hitSlop={8} style={styles.xBtn}>
                <Ionicons name="close" size={26} color={colors.textSecondary} />
            </TouchableOpacity>
            <Text style={styles.headerText} numberOfLines={1}>
                {t('basketSession.itemsCount', { count: itemCount })}
            </Text>
            <TouchableOpacity
                style={styles.basketBtn}
                onPress={() => {
                    if (!target) return;
                    router.push((target.kind === 'template'
                        ? `/template/${target.templateId}`
                        : `/basket/${target.basketId}`) as any);
                }}
                activeOpacity={0.85}
            >
                <Text style={styles.basketBtnText}>
                    {t(target?.kind === 'template' ? 'basketSession.openTemplate' : 'basketSession.openBasket')}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={colors.onPrimary} />
            </TouchableOpacity>
        </View>
    );

    const listContent = (
        <View style={styles.bodyScroll}>
            {items == null ? (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                    <MaterialProgress size="large" color={colors.primary} />
                </View>
            ) : (
                <View style={styles.card}>
                    <View style={styles.cardHeader}>
                        <Ionicons
                            name={target?.kind === 'template' ? 'bookmark-outline' : 'cart-outline'}
                            size={24}
                            color={colors.primary}
                        />
                        <Text style={styles.cardHeaderText}>
                            {t(target?.kind === 'template'
                                ? 'basketSession.templateItemsSection'
                                : 'basketSession.itemsSection')}
                        </Text>
                    </View>
                    {items.length === 0 ? (
                        <Text style={styles.emptyText}>
                            {t(target?.kind === 'template'
                                ? 'basketSession.templateEmpty'
                                : 'basketSession.empty')}
                        </Text>
                    ) : items.map((item, i) => (
                        <React.Fragment key={item.id}>
                            <View style={styles.sep} />
                            <View style={styles.item}>
                                <View style={styles.itemTop}>
                                    {item.imageUrl
                                        ? <Image source={{ uri: item.imageUrl }} style={styles.itemImage} />
                                        : <View style={[styles.itemImage, styles.itemImageFallback]}><Text style={{ opacity: 0.5 }}>🫜</Text></View>}
                                    <Text style={styles.itemName} numberOfLines={2}>{item.name ?? `#${item.productId}`}</Text>
                                    <TouchableOpacity onPress={() => removeItem(item)} hitSlop={8} style={styles.trashBtn}>
                                        <Ionicons name="trash-outline" size={20} color={colors.textMuted} />
                                    </TouchableOpacity>
                                </View>
                                <AddOrStepper
                                    product={item}
                                    quantity={item.quantity}
                                    onCommit={(qty) => commitItem(item, qty)}
                                    noPicker
                                    style={styles.stepper}
                                />
                            </View>
                        </React.Fragment>
                    ))}
                </View>
            )}
        </View>
    );

    if (!visible) return null;

    return (
        <DockedGlassSheet
            ref={controls}
            colors={colors}
            barRow={sessionHeader}
            barRowHeight={SESSION_H}
            blockScrollRef={onTabRoot ? browseListRef : null}
            sheet={{ content: listContent, maxStage: 2, contentContainerStyle: { paddingBottom: spacing.lg } }}
        />
    );
}

const makeStyles = (c: AppTheme, isDark: boolean) => StyleSheet.create({
    header: {
        flex: 1,
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingHorizontal: spacing.md,
    },
    xBtn: {
        width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.surfaceMuted,
    },
    headerText: { flex: 1, fontSize: 16, fontWeight: '700', color: c.textPrimary },
    basketBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 2,
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingLeft: 16, paddingRight: 12, paddingVertical: 10,
    },
    basketBtnText: { color: c.onPrimary, fontSize: 15, fontWeight: '800' },

    bodyScroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
    // Section holding the basket items: SAME transparency as the glass sheet,
    // just a lighter tint (a low-alpha light overlay lightens the dark glass
    // without adding opacity or its own blur). No border/shadow.
    card: {
        backgroundColor: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.45)',
        borderRadius: radius.lg,
        paddingHorizontal: spacing.lg,
        paddingBottom: spacing.sm,
    },
    cardHeader: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingVertical: spacing.md,
    },
    cardHeaderText: { fontSize: 20, fontWeight: '800', color: c.textPrimary },
    sep: { height: 1.5, backgroundColor: c.outlineVariant },
    emptyText: { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 20 },

    item: { paddingVertical: spacing.md, gap: spacing.sm },
    itemTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    itemImage: { width: 44, height: 44, borderRadius: 8, backgroundColor: c.surfaceMuted },
    itemImageFallback: { alignItems: 'center', justifyContent: 'center' },
    itemName: { flex: 1, fontSize: 14, fontWeight: '600', color: c.textPrimary },
    trashBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    // Wider stepper: more space between −/+ and the amount/unit (space-between
    // spreads them across the wider container).
    stepper: { alignSelf: 'flex-start', minWidth: 150 },
});
