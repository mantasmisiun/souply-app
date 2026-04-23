/**
 * Cross-chain orphan swipe feed ("Gal dar?"). Reached from the end-of-
 * receipt-queue screen; also safe to navigate to directly — no receipt is
 * needed. Each card shows two Products from different chains side-by-side;
 * the user decides whether they are the same product, similar, or different.
 *
 * No price is shown on the card by design — identity judgment only.
 * Dwell filter is 700ms (stricter than receipt swipes) because cross-chain
 * cards pair two unfamiliar Products and need more reading time.
 */

import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { GestureHandlerRootView, Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { API_BASE_URL } from "../../config/api";
import { getUserId } from "../../config/user";
import { useTheme, type AppTheme } from "../../constants/theme";

type Vote = "identical" | "similar" | "different";

interface Side {
  name: string;
  brandName: string | null;
  amount: number | null;
  unit: string | null;
  imageUrl: string | null;
  chainName: string;
  chainLogoUrl: string | null;
}

interface ExtraQueueItem {
  candidateId: number;
  orphanProductId: number;
  candidateProductId: number;
  orphanSpId: number;
  candidateSpId: number;
  similarityScore: number;
  tier: number;
  orphan: Side;
  candidate: Side;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const SWIPE_THRESHOLD_X = SCREEN_W * 0.28;
const SWIPE_THRESHOLD_Y = SCREEN_H * 0.18;

const SESSION_LIMIT = 30;
/** Client-side dwell gate. Server independently enforces the same cutoff,
 *  but filtering here avoids a wasted POST round-trip on thumb-bumps. */
const MIN_DWELL_MS = 700;

function formatAmount(amount: number | null, unit: string | null) {
  if (amount == null) return unit ?? "";
  if (!Number.isFinite(amount)) return "";
  return `${Number.isInteger(amount) ? amount : amount.toFixed(amount < 10 ? 2 : 0)} ${unit ?? ""}`.trim();
}

export default function ExtraSwipeScreen() {
  const router = useRouter();
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ExtraQueueItem[]>([]);
  const [itemIdx, setItemIdx] = useState(0);
  const [sessionNum, setSessionNum] = useState(0);
  const cardShownAtRef = useRef<number>(Date.now());
  const userIdRef = useRef<string | null>(null);

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  useEffect(() => {
    (async () => {
      userIdRef.current = await getUserId();
    })();
  }, []);

  const loadQueue = async () => {
    try {
      setLoading(true);
      setError(null);
      const userId = userIdRef.current ?? (await getUserId());
      userIdRef.current = userId;
      const res = await fetch(
        `${API_BASE_URL}/api/swipe/extra-queue?userId=${encodeURIComponent(userId)}&limit=${SESSION_LIMIT}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(Array.isArray(data?.items) ? data.items : []);
      setItemIdx(0);
      cardShownAtRef.current = Date.now();
    } catch (e: any) {
      setError(e?.message || "Nepavyko gauti eilės");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadQueue();
    // Re-fetch on every session increment (Gal dar? after Atlikta!).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionNum]);

  const currentItem = items[itemIdx];
  const done = !loading && !error && (items.length === 0 || itemIdx >= items.length);

  const sendVote = async (vote: Vote, item: ExtraQueueItem, dwellMs: number) => {
    if (dwellMs < MIN_DWELL_MS) {
      // Burst swipe — drop silently. Server would drop too, but skipping
      // saves a round-trip and keeps the aggregate clean.
      return;
    }
    const userId = userIdRef.current ?? (await getUserId());
    userIdRef.current = userId;
    try {
      await fetch(`${API_BASE_URL}/api/swipe/orphan-vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          candidateId: item.candidateId,
          vote,
          dwellMs,
        }),
      });
    } catch (e) {
      console.warn("Orphan swipe vote POST failed:", e);
    }
  };

  const advance = (vote: Vote) => {
    const item = currentItem;
    if (!item) return;

    const dwell = Date.now() - cardShownAtRef.current;
    sendVote(vote, item, dwell);

    setItemIdx(itemIdx + 1);
    translateX.value = 0;
    translateY.value = 0;
    cardShownAtRef.current = Date.now();
  };

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      translateX.value = e.translationX;
      translateY.value = Math.min(0, e.translationY);
    })
    .onEnd((e) => {
      const up = e.translationY < -SWIPE_THRESHOLD_Y;
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
      } else {
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
      }
    });

  const cardStyle = useAnimatedStyle(() => {
    const rotate = interpolate(translateX.value, [-SCREEN_W, 0, SCREEN_W], [-10, 0, 10]);
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
    const dyAbs = translateY.value < 0 ? Math.min(1, -translateY.value / SWIPE_THRESHOLD_Y) : 0;
    let bg = "transparent";
    let opacity = 0;
    if (dyAbs > dxAbs) {
      bg = colors.info;
      opacity = dyAbs * 0.35;
    } else if (translateX.value > 0) {
      bg = colors.primary;
      opacity = dxAbs * 0.35;
    } else if (translateX.value < 0) {
      bg = colors.error;
      opacity = dxAbs * 0.35;
    }
    return { backgroundColor: bg, opacity };
  });

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.pageBackground }}>
      <Stack.Screen options={{ title: "Padėk atpažinti" }} />

      {loading && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      )}

      {!loading && error && (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
            <Text style={styles.closeBtnText}>Grįžti</Text>
          </TouchableOpacity>
        </View>
      )}

      {!loading && !error && done && (
        <View style={styles.centered}>
          <Ionicons name="checkmark-circle" size={72} color={colors.primary} />
          <Text style={styles.doneTitle}>Ačiū!</Text>
          <Text style={styles.doneSubtitle}>
            {items.length === 0
              ? "Šiuo metu nėra kortelių peržiūrai. Užsukite vėliau."
              : "Peržiūrėjote visas korteles šioje sesijoje."}
          </Text>
          <View style={styles.buttonRow}>
            {items.length > 0 && (
              <TouchableOpacity
                style={[styles.closeBtn, styles.secondaryBtn]}
                onPress={() => setSessionNum(sessionNum + 1)}
              >
                <Text style={styles.secondaryBtnText}>Gal dar?</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
              <Text style={styles.closeBtnText}>Grįžti</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {!loading && !error && !done && currentItem && (
        <View style={styles.stage}>
          <GestureDetector gesture={pan}>
            <Animated.View style={[styles.card, cardStyle]}>
              <Animated.View style={[StyleSheet.absoluteFill, styles.cardTint, tintStyle]} />

              <ProductHalf side={currentItem.orphan} styles={styles} />
              <View style={styles.divider} />
              <ProductHalf side={currentItem.candidate} styles={styles} />
            </Animated.View>
          </GestureDetector>

          <View style={styles.legend}>
            <View style={styles.legendItem}>
              <Ionicons name="arrow-back" size={18} color={colors.error} />
              <Text style={styles.legendText}>Skirtingi</Text>
            </View>
            <View style={styles.legendItem}>
              <Ionicons name="arrow-up" size={18} color={colors.info} />
              <Text style={styles.legendText}>Panašūs</Text>
            </View>
            <View style={styles.legendItem}>
              <Ionicons name="arrow-forward" size={18} color={colors.primary} />
              <Text style={styles.legendText}>Identiški</Text>
            </View>
          </View>

          <Text style={styles.progress}>
            {Math.min(itemIdx + 1, items.length)} / {items.length}
          </Text>
        </View>
      )}
    </GestureHandlerRootView>
  );
}

function ProductHalf({ side, styles }: { side: Side; styles: ReturnType<typeof makeStyles> }) {
  return (
    <View style={styles.half}>
      <View style={styles.chainRow}>
        {side.chainLogoUrl && (
          <Image source={{ uri: side.chainLogoUrl }} style={styles.chainLogo} resizeMode="contain" />
        )}
        <Text style={styles.sideLabel}>{side.chainName}</Text>
      </View>
      {side.imageUrl && (
        <Image source={{ uri: side.imageUrl }} style={styles.image} resizeMode="contain" />
      )}
      <Text style={styles.candName} numberOfLines={3}>
        {side.name}
      </Text>
      {side.brandName && <Text style={styles.subtle}>{side.brandName}</Text>}
      <Text style={styles.subtle}>{formatAmount(side.amount, side.unit)}</Text>
    </View>
  );
}

const makeStyles = (c: AppTheme) =>
  StyleSheet.create({
    centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
    errorText: { color: c.error, textAlign: "center", marginBottom: 16, fontSize: 16 },
    doneTitle: { fontSize: 24, fontWeight: "700", color: c.textPrimary, marginTop: 12 },
    doneSubtitle: {
      color: c.textSecondary,
      textAlign: "center",
      marginTop: 8,
      marginBottom: 20,
      fontSize: 14,
    },
    buttonRow: { flexDirection: "row", gap: 12 },
    closeBtn: {
      backgroundColor: c.primary,
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: 12,
    },
    closeBtnText: { color: c.onPrimary, fontWeight: "600", fontSize: 15 },
    secondaryBtn: {
      backgroundColor: c.cardBackground,
      borderWidth: 1,
      borderColor: c.primary,
    },
    secondaryBtnText: { color: c.primary, fontWeight: "600", fontSize: 15 },

    stage: { flex: 1, padding: 16, alignItems: "center", justifyContent: "center" },

    card: {
      width: SCREEN_W - 32,
      maxHeight: SCREEN_H * 0.72,
      backgroundColor: c.cardBackground,
      borderRadius: 20,
      padding: 20,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 10,
      elevation: 6,
    },
    cardTint: { borderRadius: 20 },

    half: { paddingVertical: 12, alignItems: "center" },
    sideLabel: {
      fontSize: 11,
      fontWeight: "700",
      color: c.textMuted,
      letterSpacing: 1.2,
    },
    candName: {
      fontSize: 16,
      fontWeight: "600",
      color: c.textPrimary,
      textAlign: "center",
      marginTop: 6,
    },
    subtle: { fontSize: 13, color: c.textSecondary, marginTop: 4 },

    image: { width: 96, height: 96, marginVertical: 6 },

    chainRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginBottom: 4,
    },
    chainLogo: { width: 18, height: 18 },

    divider: { height: 1, backgroundColor: c.border, marginVertical: 8 },

    legend: {
      flexDirection: "row",
      justifyContent: "space-around",
      width: "100%",
      marginTop: 18,
      paddingHorizontal: 24,
    },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
    legendText: { fontSize: 12, color: c.textSecondary },

    progress: {
      marginTop: 14,
      fontSize: 13,
      color: c.textMuted,
      fontWeight: "600",
    },
  });
