import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { API_BASE_URL } from "../../config/api";
import { getUserId } from "../../config/user";

interface Receipt {
  id: number;
  filePath: string;
  fileType: string;
  processingStatus: string;
  receiptDate: string | null;
  receiptNo: string | null;
}

export default function ReceiptsScreen() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [lastUploadedId, setLastUploadedId] = useState<number | null>(null);

  const fetchReceipts = async (removePlaceholder = false) => {
    try {
      const userId = await getUserId();
      const response = await fetch(
        `${API_BASE_URL}/api/users/${userId}/receipts`,
      );
      const data = await response.json();
      setReceipts((prev) => {
        const hasPlaceholder = prev.some((r) => r.id === -1);
        if (hasPlaceholder && !removePlaceholder) {
          return [prev.find((r) => r.id === -1)!, ...data];
        }
        return data;
      });
    } catch (error) {
      console.error("Failed to fetch receipts:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const hasProcessing = receipts.some(
      (r) =>
        r.processingStatus === "processing" || r.processingStatus === "pending",
    );
    if (!hasProcessing && !lastUploadedId) return;

    const interval = setInterval(async () => {
      await fetchReceipts();
      if (lastUploadedId) {
        setReceipts((prev) => {
          const stillExists = prev.some((r) => r.id === lastUploadedId);
          if (!stillExists) {
            Alert.alert("Dublikatas", "Šis kvitas jau buvo įkeltas anksčiau");
            setLastUploadedId(null);
          }
          return prev;
        });
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [receipts, lastUploadedId]);
  useFocusEffect(
    useCallback(() => {
      fetchReceipts();
    }, []),
  );

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "#2e7d32";
      case "processing":
        return "#f57c00";
      case "failed":
        return "#c62828";
      default:
        return "#757575";
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case "completed":
        return "Apdorotas";
      case "processing":
        return "Apdorojama";
      case "failed":
        return "Nepavyko";
      default:
        return "Laukiama";
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2e7d32" />
      </View>
    );
  }
  const handleUpload = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      base64: true,
      quality: 1,
    });

    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    const filename = asset.fileName || "receipt.jpg";
    const mimeType = asset.mimeType || "image/jpeg";
    const imageBase64 = asset.base64;
    const userId = await getUserId();

    const placeholder = {
      id: -1,
      filePath: "",
      fileType: "",
      processingStatus: "uploading",
      receiptDate: null,
      receiptNo: null,
    };
    setReceipts((prev) => [placeholder, ...prev]);

    try {
      const response = await fetch(`${API_BASE_URL}/api/receipts/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64, filename, mimeType, userId }),
      });
      const data = await response.json();
      if (data.receiptId) {
        setLastUploadedId(data.receiptId);
        await fetchReceipts(true);
      }
    } catch (error) {
      console.error("Upload failed:", error);
      Alert.alert("Klaida", "Nepavyko įkelti kvito");
      setReceipts((prev) => prev.filter((r) => r.id !== -1));
    }
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={receipts}
        keyExtractor={(item) => item.id.toString()}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={styles.emptyText}>Kvitų nėra</Text>
          </View>
        }
        renderItem={({ item }) => {
          if (item.id === -1) {
            return (
              <View style={[styles.card, styles.placeholderCard]}>
                <ActivityIndicator
                  size="small"
                  color="#2e7d32"
                  style={{ marginRight: 12 }}
                />
                <Text style={styles.placeholderText}>Kvitas įkeliamas...</Text>
              </View>
            );
          }
          return (
            <TouchableOpacity
              style={styles.card}
              onPress={() => {
                router.push(`/receipt-process?receiptId=${item.id}`);
              }}
            >
              <View style={styles.cardLeft}>
                <Ionicons name="receipt-outline" size={28} color="#2e7d32" />
              </View>
              <View style={styles.cardContent}>
                <Text style={styles.cardTitle}>
                  {item.receiptNo ? `Kvitas Nr. ${item.receiptNo}` : "Kvitas"}
                </Text>
                <Text style={styles.cardDate}>
                  {item.receiptDate
                    ? new Date(item.receiptDate).toLocaleDateString("lt-LT")
                    : "Data nenurodyta"}
                </Text>
              </View>
              <View
                style={[
                  styles.statusBadge,
                  { backgroundColor: getStatusColor(item.processingStatus) },
                ]}
              >
                <Text style={styles.statusText}>
                  {getStatusText(item.processingStatus)}
                </Text>
              </View>
            </TouchableOpacity>
          );
        }}
      />
      <TouchableOpacity
        style={styles.fab}
        onPress={() => {
          Alert.alert("Kvito įkėlimas", "Pasirinkite būdą", [
            {
              text: "Fotografuoti",
              onPress: () => router.push("/receipt/capture" as any),
            },
            {
              text: "Iš galerijos",
              onPress: async () => {
                const result = await ImagePicker.launchImageLibraryAsync({
                  mediaTypes: ["images"],
                  quality: 0.8,
                });
                if (!result.canceled && result.assets[0]) {
                  router.push(
                    `/receipt-process?uri=${encodeURIComponent(result.assets[0].uri)}` as any,
                  );
                }
              },
            },
            { text: "Atšaukti", style: "cancel" },
          ]);
        }}
      >
        <Ionicons name="add" size={28} color="white" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f5f5f5" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, paddingBottom: 80 },
  card: {
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  cardLeft: { marginRight: 12 },
  cardContent: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: "600", color: "#212121" },
  cardDate: { fontSize: 13, color: "#757575", marginTop: 2 },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusText: { fontSize: 11, color: "white", fontWeight: "600" },
  emptyText: { fontSize: 16, color: "#757575" },
  fab: {
    position: "absolute",
    bottom: 24,
    right: 24,
    backgroundColor: "#2e7d32",
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
  },
  placeholderCard: {
    flexDirection: "row",
    alignItems: "center",
    opacity: 0.7,
  },
  placeholderText: {
    fontSize: 14,
    color: "#757575",
  },
});
