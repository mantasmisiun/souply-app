import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  GestureHandlerRootView,
  Gesture,
  GestureDetector,
} from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Image } from "expo-image";
import { ProductImage } from "../../components/ProductImage";
import { API_BASE_URL } from "../../config/api";
import { getUserId } from "../../config/user";
import { useTheme, type AppTheme } from "../../constants/theme";
import { useLevelStore } from "../../state/levelStore";

// ── Types ──────────────────────────────────────────────────────────────────

type Vote = "identical" | "similar" | "different";

interface SwipeCardSide {
  spId: number;
  productId: number;
  name: string;
  brandName: string | null;
  imageUrl: string | null;
  chainId: number;
  chainName: string;
  chainLogoUrl: string | null;
  categoryId: number;
  categoryName: string;
}

interface SwipeQueueCard {
  cardId: string;
  slot: 1 | 2 | 3;
  score: number;
  left: SwipeCardSide;
  right: SwipeCardSide;
  slot2Meta?: {
    sameChain: boolean;
    conflictDetected: boolean;
  };
}

interface SlotCounts {
  slot1: number;
  slot2: number;
  slot3: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const STAGE_H_PAD = 16;
const CARD_W = SCREEN_W - STAGE_H_PAD * 2;
const IMG_SIZE = Math.min(140, Math.floor((CARD_W - 24) / 2) - 8);

const SWIPE_THRESHOLD_X = SCREEN_W * 0.26;
const SWIPE_THRESHOLD_Y = SCREEN_H * 0.16;
const UNDO_DELAY_MS = 3000;
const MIN_DWELL_MS = 700;

// ── Sub-components ─────────────────────────────────────────────────────────

function ProgressDots({
  total,
  current,
  colors,
}: {
  total: number;
  current: number;
  colors: AppTheme;
}) {
  if (total === 0) return null;
  return (
    <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor:
              i < current
                ? colors.success
                : i === current
                ? colors.warning
                : colors.textMuted,
          }}
        />
      ))}
    </View>
  );
}

function CardSide({
  side,
  styles,
}: {
  side: SwipeCardSide;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.half}>
      <View style={styles.chainRow}>
        {side.chainLogoUrl ? (
          <Image
            source={{ uri: side.chainLogoUrl }}
            style={styles.chainLogo}
            contentFit="contain"
          />
        ) : null}
        <Text style={styles.chainName} numberOfLines={1}>
          {side.chainName}
        </Text>
      </View>

      <ProductImage
        uris={side.imageUrl ? [side.imageUrl] : []}
        imageStyle={styles.productImg}
        placeholderStyle={styles.productImgPlaceholder}
        emojiStyle={styles.productImgEmoji}
        resizeMode="contain"
      />

      <Text style={styles.productName} numberOfLines={5}>
        {side.name}
      </Text>
    </View>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────

export default function SwipeQueueScreen() {
  const router = useRouter();
  // `standalone=1` is passed by the optional button inside receipt-process so
  // it cannot accidentally inherit a receiptId from the parent route's URL.
  const { receiptId: receiptIdParam, standalone } = useLocalSearchParams<{
    receiptId?: string;
    standalone?: string;
  }>();
  const receiptId =
    standalone === "1" ? null : (receiptIdParam ?? null);

  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const stashLevel = useLevelStore((s) => s.stashLevel);
  const triggerIfNewLevel = useLevelStore((s) => s.triggerIfNewLevel);
  const checkCandidate = useLevelStore((s) => s.checkCandidate);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<SwipeQueueCard[]>([]);
  const [slotCounts, setSlotCounts] = useState<SlotCounts>({
    slot1: 0,
    slot2: 0,
    slot3: 0,
  });
  const [idx, setIdx] = useState(0);
  const [sessionNum, setSessionNum] = useState(0);
  const [undoLabel, setUndoLabel] = useState<string | null>(null);

  const userIdRef = useRef<string | null>(null);
  const cardShownAtRef = useRef(Date.now());
  const pendingVoteRef = useRef<{
    item: SwipeQueueCard;
    vote: Vote;
    dwell: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  // ── Load queue ─────────────────────────────────────────────────────────

  const loadQueue = async () => {
    try {
      setLoading(true);
      setError(null);
      const userId = userIdRef.current ?? (await getUserId());
      userIdRef.current = userId;
      const qs = receiptId ? `?receiptId=${encodeURIComponent(receiptId)}` : "";
      const res = await fetch(
        `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-queue${qs}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(Array.isArray(data?.items) ? data.items : []);
      setSlotCounts(data?.slotCounts ?? { slot1: 0, slot2: 0, slot3: 0 });
      setIdx(0);
      cardShownAtRef.current = Date.now();
    } catch (e: any) {
      setError(e?.message ?? "Nepavyko gauti eilės");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      userIdRef.current = await getUserId();
    })();
  }, []);

  useEffect(() => {
    loadQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionNum]);

  // ── Vote dispatch ──────────────────────────────────────────────────────

  const sendVote = async (vote: Vote, item: SwipeQueueCard, dwell: number) => {
    const userId = userIdRef.current!;
    try {
      let res: Response;
      if (item.slot === 2) {
        res = await fetch(
          `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-vote/slot2`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orphanSpId: item.left.spId,
              candidateSpId: item.right.spId,
              vote,
              dwellMs: dwell,
              conflictDetected: item.slot2Meta?.conflictDetected ?? false,
              sameChain: item.slot2Meta?.sameChain ?? false,
            }),
          }
        );
      } else {
        res = await fetch(
          `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-vote`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              spIdA: item.left.spId,
              spIdB: item.right.spId,
              vote,
              dwellMs: dwell,
            }),
          }
        );
      }
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.level) stashLevel(data.level).catch(() => {});
      }
    } catch (e) {
      console.warn("[SwipeQueue] vote POST failed:", e);
    }
  };

  // ── Advance / undo ─────────────────────────────────────────────────────

  const advance = (vote: Vote | null) => {
    const item = cappedItems[idx];
    if (!item) return;

    const dwell = Date.now() - cardShownAtRef.current;

    if (pendingVoteRef.current) {
      const prev = pendingVoteRef.current;
      clearTimeout(prev.timer);
      pendingVoteRef.current = null;
      sendVote(prev.vote, prev.item, prev.dwell).catch(() => {});
    }

    translateX.value = 0;
    translateY.value = 0;
    setIdx((i) => i + 1);
    cardShownAtRef.current = Date.now();

    if (vote === null) {
      setUndoLabel(null);
      return;
    }

    if (dwell < MIN_DWELL_MS) {
      setUndoLabel(null);
      sendVote(vote, item, dwell).catch(() => {});
      return;
    }

    const label =
      vote === "identical" ? "Identiška" : vote === "similar" ? "Panaši" : "Skirtinga";
    setUndoLabel(label);

    const timer = setTimeout(() => {
      pendingVoteRef.current = null;
      setUndoLabel(null);
      sendVote(vote, item, dwell).catch(() => {});
    }, UNDO_DELAY_MS);

    pendingVoteRef.current = { item, vote, dwell, timer };
  };

  const handleUndo = () => {
    if (!pendingVoteRef.current) return;
    clearTimeout(pendingVoteRef.current.timer);
    pendingVoteRef.current = null;
    setUndoLabel(null);
    setIdx((i) => Math.max(0, i - 1));
    cardShownAtRef.current = Date.now();
  };

  // Animate card off in the given direction then call advance.
  const advanceTap = (vote: Vote | null) => {
    if (vote === "different") {
      translateX.value = withTiming(-SCREEN_W, { duration: 200 }, () =>
        runOnJS(advance)(vote)
      );
    } else if (vote === "identical") {
      translateX.value = withTiming(SCREEN_W, { duration: 200 }, () =>
        runOnJS(advance)(vote)
      );
    } else if (vote === "similar") {
      translateY.value = withTiming(-SCREEN_H, { duration: 200 }, () =>
        runOnJS(advance)(vote)
      );
    } else {
      translateY.value = withTiming(SCREEN_H, { duration: 200 }, () =>
        runOnJS(advance)(null)
      );
    }
  };

  // ── Gesture ────────────────────────────────────────────────────────────

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      translateX.value = e.translationX;
      translateY.value = e.translationY;
    })
    .onEnd((e) => {
      const up = e.translationY < -SWIPE_THRESHOLD_Y;
      const down = e.translationY > SWIPE_THRESHOLD_Y;
      const right = e.translationX > SWIPE_THRESHOLD_X;
      const left = e.translationX < -SWIPE_THRESHOLD_X;

      if (up) {
        translateY.value = withTiming(-SCREEN_H, { duration: 220 }, () =>
          runOnJS(advance)("similar")
        );
      } else if (right) {
        translateX.value = withTiming(SCREEN_W, { duration: 220 }, () =>
          runOnJS(advance)("identical")
        );
      } else if (left) {
        translateX.value = withTiming(-SCREEN_W, { duration: 220 }, () =>
          runOnJS(advance)("different")
        );
      } else if (down) {
        translateY.value = withTiming(SCREEN_H, { duration: 220 }, () =>
          runOnJS(advance)(null)
        );
      } else {
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
      }
    });

  const cardStyle = useAnimatedStyle(() => {
    const rotate = interpolate(
      translateX.value,
      [-SCREEN_W, 0, SCREEN_W],
      [-10, 0, 10]
    );
    return {
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { rotate: `${rotate}deg` },
      ],
    };
  });

  const tintStyle = useAnimatedStyle(() => {
    const dxAbs = Math.min(1, Math.abs(translateX.value) / SWIPE_THRESHOLD_X);
    const upAbs =
      translateY.value < 0 ? Math.min(1, -translateY.value / SWIPE_THRESHOLD_Y) : 0;
    const downAbs =
      translateY.value > 0 ? Math.min(1, translateY.value / SWIPE_THRESHOLD_Y) : 0;
    const dominantY = Math.max(upAbs, downAbs);
    let bg = "transparent";
    let opacity = 0;
    if (dominantY > dxAbs) {
      if (upAbs >= downAbs) { bg = colors.info; opacity = upAbs * 0.35; }
      else { bg = colors.surfaceMuted; opacity = downAbs * 0.3; }
    } else if (translateX.value > 0) {
      bg = colors.primary; opacity = dxAbs * 0.35;
    } else if (translateX.value < 0) {
      bg = colors.error; opacity = dxAbs * 0.35;
    }
    return { backgroundColor: bg, opacity };
  });

  // ── Derived ────────────────────────────────────────────────────────────

  const cappedItems = useMemo(() => {
    if (receiptId) {
      // Receipt context: fill up to 3 cards in priority order (slot2 → slot1 → slot3).
      // Take more from a slot when earlier slots are empty so we always reach 3.
      const MANDATORY = 3;
      const bySlot = [
        items.filter((i) => i.slot === 2),
        items.filter((i) => i.slot === 1),
        items.filter((i) => i.slot === 3),
      ];
      const result: SwipeQueueCard[] = [];
      for (const pool of bySlot) {
        for (const card of pool) {
          if (result.length >= MANDATORY) break;
          result.push(card);
        }
        if (result.length >= MANDATORY) break;
      }
      return result;
    }
    // Standalone: up to 3 per slot (S2→S1→S3), fill overflow to 10.
    const CAP = 10;
    const PER_SLOT = 3;
    const s2 = items.filter((i) => i.slot === 2).slice(0, PER_SLOT);
    const s1 = items.filter((i) => i.slot === 1).slice(0, PER_SLOT);
    const s3 = items.filter((i) => i.slot === 3).slice(0, PER_SLOT);
    const picked = new Set([...s2, ...s1, ...s3].map((i) => i.cardId));
    const firstRound = [...s2, ...s1, ...s3];
    if (firstRound.length >= CAP) return firstRound.slice(0, CAP);
    const overflow = items
      .filter((i) => !picked.has(i.cardId))
      .slice(0, CAP - firstRound.length);
    return [...firstRound, ...overflow];
  }, [items, receiptId]);

  const currentItem = cappedItems[idx];
  const done =
    !loading && !error && (cappedItems.length === 0 || idx >= cappedItems.length);

  // Pre-results: mark mandatory swipes complete, stash level, then navigate.
  // receipt-process has checkCandidate on focus so the modal fires there.
  useEffect(() => {
    if (done && receiptId) {
      (async () => {
        await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/complete-swipes`, {
          method: "POST",
        }).catch(() => {});
        // Ensure the last pending vote (undo timer) is counted before reading
        // level — wait briefly so the DB write is likely committed.
        await new Promise((r) => setTimeout(r, 400));
        const userId = userIdRef.current;
        if (userId) {
          try {
            const r = await fetch(
              `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/profile`
            );
            const d = await r.json();
            if (d?.level) await stashLevel(d.level);
          } catch {}
        }
        router.replace({
          pathname: "/receipt-process",
          params: { receiptId, swipeDone: "1" },
        } as any);
      })();
    }
  }, [done, receiptId]);

  // Standalone: trigger modal directly on the done screen.
  useEffect(() => {
    if (done && !receiptId && !loading) {
      (async () => {
        const userId = userIdRef.current;
        if (!userId) return;
        try {
          const r = await fetch(
            `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/profile`
          );
          const d = await r.json();
          if (d?.level) await triggerIfNewLevel(d.level);
        } catch {}
      })();
    }
  }, [done, receiptId, loading]);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <GestureHandlerRootView
      style={{ flex: 1, backgroundColor: colors.pageBackground }}
    >
      <Stack.Screen options={{ title: "Padėk atpažinti" }} />

      {/* ── Loading ── */}
      {loading && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      )}

      {/* ── Error ── */}
      {!loading && error && (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.btn} onPress={() => router.back()}>
            <Text style={styles.btnText}>Grįžti</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Done / empty (standalone only — receipt mode auto-navigates) ── */}
      {!loading && !error && done && !receiptId && (
        <View style={styles.centered}>
          <Ionicons name="checkmark-circle" size={72} color={colors.primary} />
          <Text style={styles.doneTitle}>Ačiū!</Text>
          <Text style={styles.doneSubtitle}>
            {cappedItems.length === 0
              ? "Šiuo metu nėra kortelių peržiūrai. Užsukite vėliau."
              : "Peržiūrėjote visas korteles šioje sesijoje."}
          </Text>
          <View style={styles.btnRow}>
            {cappedItems.length > 0 && (
              <TouchableOpacity
                style={styles.btnOutline}
                onPress={() => setSessionNum((n) => n + 1)}
              >
                <Text style={styles.btnOutlineText}>Gal dar?</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.btn} onPress={() => router.back()}>
              <Text style={styles.btnText}>Grįžti</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Progress dots — just below nav bar ── */}
      {!loading && !error && !done && currentItem && (
        <View style={styles.dotsBar}>
          <ProgressDots
            total={cappedItems.length}
            current={idx}
            colors={colors}
          />
        </View>
      )}

      {/* ── Active card ── */}
      {!loading && !error && !done && currentItem && (
        <View style={styles.stage}>
          <GestureDetector gesture={pan}>
            <Animated.View style={[styles.card, cardStyle]}>
              <Animated.View
                style={[StyleSheet.absoluteFill, styles.cardTint, tintStyle]}
              />
              <View style={styles.cardInner}>
                <CardSide side={currentItem.left} styles={styles} />
                <View style={styles.verticalDivider} />
                <CardSide side={currentItem.right} styles={styles} />
              </View>
            </Animated.View>
          </GestureDetector>

          {/* Tap buttons */}
          <View style={styles.tapRow}>
            <TouchableOpacity
              style={styles.tapBtn}
              onPress={() => advanceTap("different")}
            >
              <Text style={styles.tapBtnArrow}>←</Text>
              <Text style={styles.tapBtnLabel}>Skirtinga</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.tapBtn}
              onPress={() => advanceTap("similar")}
            >
              <Text style={styles.tapBtnArrow}>↑</Text>
              <Text style={styles.tapBtnLabel}>Panaši</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.tapBtn}
              onPress={() => advanceTap(null)}
            >
              <Text style={styles.tapBtnArrow}>↓</Text>
              <Text style={styles.tapBtnLabel}>Praleisti</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.tapBtn}
              onPress={() => advanceTap("identical")}
            >
              <Text style={styles.tapBtnArrow}>→</Text>
              <Text style={styles.tapBtnLabel}>Identiška</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Undo toast ── */}
      {undoLabel !== null && (
        <View style={styles.undoToast}>
          <Text style={styles.undoText}>{undoLabel}</Text>
          <TouchableOpacity onPress={handleUndo} style={styles.undoBtn}>
            <Text style={styles.undoBtnText}>Atšaukti</Text>
          </TouchableOpacity>
        </View>
      )}
    </GestureHandlerRootView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const makeStyles = (c: AppTheme) =>
  StyleSheet.create({
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },

    // ── Done state ──
    doneTitle: {
      fontSize: 24,
      fontWeight: "700",
      color: c.textPrimary,
      marginTop: 12,
    },
    doneSubtitle: {
      color: c.textSecondary,
      textAlign: "center",
      marginTop: 8,
      marginBottom: 20,
      fontSize: 14,
    },
    btnRow: { flexDirection: "row", gap: 12 },
    btn: {
      backgroundColor: c.primary,
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: 12,
    },
    btnText: { color: c.onPrimary, fontWeight: "600", fontSize: 15 },
    btnOutline: {
      backgroundColor: c.cardBackground,
      borderWidth: 1,
      borderColor: c.primary,
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: 12,
    },
    btnOutlineText: { color: c.primary, fontWeight: "600", fontSize: 15 },
    errorText: {
      color: c.error,
      textAlign: "center",
      marginBottom: 16,
      fontSize: 16,
    },

    // ── Dots bar ──
    dotsBar: {
      alignItems: "center",
      paddingTop: 10,
      paddingBottom: 4,
    },

    // ── Stage ──
    stage: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: STAGE_H_PAD,
      paddingBottom: 8,
    },

    // ── Card ──
    card: {
      width: CARD_W,
      backgroundColor: c.cardBackground,
      borderRadius: 20,
      overflow: "hidden",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 10,
      elevation: 6,
    },
    cardTint: { borderRadius: 20 },
    cardInner: {
      flexDirection: "row",
      paddingHorizontal: 10,
      paddingVertical: 14,
    },
    verticalDivider: {
      width: 1,
      backgroundColor: c.border,
      marginHorizontal: 6,
      alignSelf: "stretch",
    },

    // ── Card half ──
    half: {
      flex: 1,
      alignItems: "center",
      paddingHorizontal: 2,
    },
    chainRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginBottom: 6,
      width: "100%",
      justifyContent: "center",
    },
    chainLogo: {
      width: 16,
      height: 16,
    },
    chainName: {
      fontSize: 10,
      fontWeight: "700",
      color: c.textMuted,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      flexShrink: 1,
    },
    productImg: {
      width: IMG_SIZE,
      height: IMG_SIZE,
    },
    productImgPlaceholder: {
      width: IMG_SIZE,
      height: IMG_SIZE,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceMuted,
      borderRadius: 8,
    },
    productImgEmoji: {
      fontSize: IMG_SIZE * 0.55,
      opacity: 0.4,
    },
    productName: {
      fontSize: 12,
      fontWeight: "600",
      color: c.textPrimary,
      textAlign: "center",
      marginTop: 8,
      lineHeight: 17,
    },

    // ── Tap buttons ──
    tapRow: {
      flexDirection: "row",
      marginTop: 14,
      gap: 8,
      width: "100%",
      justifyContent: "space-between",
    },
    tapBtn: {
      flex: 1,
      alignItems: "center",
      paddingVertical: 10,
      borderRadius: 12,
      backgroundColor: c.cardBackground,
      borderWidth: 1,
      borderColor: c.border,
      gap: 2,
    },
    tapBtnArrow: {
      fontSize: 16,
      color: c.textSecondary,
    },
    tapBtnLabel: {
      fontSize: 9,
      fontWeight: "600",
      color: c.textMuted,
      textAlign: "center",
    },

    // ── Undo toast ──
    undoToast: {
      position: "absolute",
      bottom: 100,
      left: 20,
      right: 20,
      backgroundColor: c.cardBackground,
      borderRadius: 14,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 12,
      paddingHorizontal: 16,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.12,
      shadowRadius: 8,
      elevation: 5,
    },
    undoText: {
      fontSize: 14,
      color: c.textSecondary,
    },
    undoBtn: {
      backgroundColor: c.primaryMuted,
      paddingVertical: 6,
      paddingHorizontal: 14,
      borderRadius: 8,
    },
    undoBtnText: {
      fontSize: 13,
      fontWeight: "700",
      color: c.primary,
    },
  });
