import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Image,
    KeyboardAvoidingView,
    Modal,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { API_BASE_URL } from "../../config/api";

interface L3CategoryOption {
  id: number;
  name: string;
  path: string;
}

export interface CreatedStoreProductPayload {
  productId: number;
  storeProductId: number;
  storeProductName: string;
  imageUrl: string | null;
}

interface CreateStoreProductModalProps {
  visible: boolean;
  onClose: () => void;
  chainId: number;
  initialName: string;
  initialCategoryId: number | null;
  onCreated: (payload: CreatedStoreProductPayload) => Promise<void> | void;
}

export default function CreateStoreProductModal({
  visible,
  onClose,
  chainId,
  initialName,
  initialCategoryId,
  onCreated,
}: CreateStoreProductModalProps) {
  const [draftName, setDraftName] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(
    null,
  );
  const [categoryInput, setCategoryInput] = useState("");
  const [selectedCategoryPath, setSelectedCategoryPath] = useState("");
  const [categoryOptions, setCategoryOptions] = useState<L3CategoryOption[]>(
    [],
  );
  const [searchingCategories, setSearchingCategories] = useState(false);
  const [createImageUri, setCreateImageUri] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!visible) return;

    setDraftName(initialName.trim());
    setCreateImageUri(null);
    setCategoryOptions([]);
    setSearchingCategories(false);
    setSubmitting(false);

    if (Number.isFinite(initialCategoryId) && Number(initialCategoryId) > 0) {
      const id = Number(initialCategoryId);
      setSelectedCategoryId(id);
      (async () => {
        try {
          const res = await fetch(`${API_BASE_URL}/api/categories/${id}/path`);
          const data = await res.json();
          const path = typeof data?.path === "string" ? data.path : "";
          setSelectedCategoryPath(path);
          setCategoryInput(path);
        } catch {
          setSelectedCategoryPath("");
          setCategoryInput("");
        }
      })();
      return;
    }

    setSelectedCategoryId(null);
    setSelectedCategoryPath("");
    setCategoryInput("");
  }, [visible, initialName, initialCategoryId]);

  useEffect(() => {
    if (!visible) return;
    const q = categoryInput.trim();

    if (q.length < 2 || (selectedCategoryPath && q === selectedCategoryPath)) {
      setCategoryOptions([]);
      setSearchingCategories(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        setSearchingCategories(true);
        const res = await fetch(
          `${API_BASE_URL}/api/categories/l3/search?q=${encodeURIComponent(q)}`,
        );
        const data = await res.json();
        if (!cancelled) {
          setCategoryOptions(Array.isArray(data) ? data : []);
        }
      } catch {
        if (!cancelled) {
          setCategoryOptions([]);
        }
      } finally {
        if (!cancelled) setSearchingCategories(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [categoryInput, selectedCategoryPath, visible]);

  const pickCreateImage = () => {
    Alert.alert("Pridėti paveiksliuką", "Pasirinkite būdą", [
      {
        text: "Fotografuoti",
        onPress: async () => {
          const r = await ImagePicker.launchCameraAsync({
            mediaTypes: ["images"],
            quality: 0.8,
          });
          if (!r.canceled && r.assets[0]) setCreateImageUri(r.assets[0].uri);
        },
      },
      {
        text: "Iš galerijos",
        onPress: async () => {
          const r = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images"],
            quality: 0.8,
          });
          if (!r.canceled && r.assets[0]) setCreateImageUri(r.assets[0].uri);
        },
      },
      { text: "Atšaukti", style: "cancel" },
    ]);
  };

  const compressForProductImage = async (uri: string) => {
    let out = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 900 } }],
      { compress: 0.35, format: ImageManipulator.SaveFormat.JPEG },
    );

    const size = (await (await fetch(out.uri)).blob()).size;
    if (size > 350_000) {
      out = await ImageManipulator.manipulateAsync(
        out.uri,
        [{ resize: { width: 640 } }],
        { compress: 0.25, format: ImageManipulator.SaveFormat.JPEG },
      );
    }
    return out.uri;
  };

  const uploadCreateImage = async (uri: string) => {
    const compressedUri = await compressForProductImage(uri);

    const urlRes = await fetch(
      `${API_BASE_URL}/api/store-products/upload-url`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: `product-${Date.now()}.jpg`,
          mimeType: "image/jpeg",
        }),
      },
    );
    const urlData = await urlRes.json();
    if (!urlRes.ok || !urlData?.uploadUrl || !urlData?.filePath) {
      throw new Error(urlData?.error || "Nepavyko gauti įkėlimo URL");
    }

    const blob = await (await fetch(compressedUri)).blob();
    const putRes = await fetch(urlData.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    });
    if (!putRes.ok) {
      throw new Error("Nepavyko įkelti paveiksliuko");
    }

    return urlData.filePath as string;
  };

  const submit = async () => {
    const trimmedName = draftName.trim();
    if (!trimmedName) {
      Alert.alert("Trūksta pavadinimo", "Įveskite produkto pavadinimą.");
      return;
    }
    if (!Number.isFinite(chainId) || chainId <= 0) {
      Alert.alert("Klaida", "Nerasta parduotuvių tinklo informacija.");
      return;
    }
    if (
      !Number.isFinite(selectedCategoryId) ||
      Number(selectedCategoryId) <= 0
    ) {
      Alert.alert("Trūksta kategorijos", "Pasirinkite L3 kategoriją.");
      return;
    }

    try {
      setSubmitting(true);

      const uploadedImageUrl = createImageUri
        ? await uploadCreateImage(createImageUri)
        : null;

      const pRes = await fetch(`${API_BASE_URL}/api/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: Number(selectedCategoryId),
          name: trimmedName,
          imageUrl: uploadedImageUrl,
        }),
      });
      const pData = await pRes.json();
      if (!pRes.ok || !pData?.id) {
        throw new Error(pData?.error || "Nepavyko sukurti produkto");
      }

      const spRes = await fetch(`${API_BASE_URL}/api/store-products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: pData.id,
          chainId: Number(chainId),
          storeProductName: trimmedName,
          imageUrl: uploadedImageUrl,
        }),
      });
      const spData = await spRes.json();
      if (!spRes.ok || !spData?.id) {
        throw new Error(
          spData?.error || "Nepavyko sukurti parduotuvės produkto",
        );
      }

      await onCreated({
        productId: pData.id,
        storeProductId: spData.id,
        storeProductName: trimmedName,
        imageUrl: uploadedImageUrl,
      });
      onClose();
    } catch (e: any) {
      Alert.alert("Klaida", e?.message || "Nepavyko sukurti produkto");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.card}>
          <Text style={styles.title}>Kurti naują produktą</Text>

          <Text style={styles.label}>Pavadinimas</Text>
          <TextInput
            value={draftName}
            onChangeText={setDraftName}
            style={styles.input}
            placeholder="Įveskite produkto pavadinimą"
            placeholderTextColor="#9e9e9e"
          />

          <Text style={styles.label}>Kategorija (L3)</Text>
          <TextInput
            value={categoryInput}
            onChangeText={(v) => {
              setCategoryInput(v);
              setSelectedCategoryId(null);
              setSelectedCategoryPath("");
            }}
            style={styles.input}
            placeholder="Rašykite kategorijos pavadinimą"
            placeholderTextColor="#9e9e9e"
          />

          {searchingCategories && (
            <ActivityIndicator
              size="small"
              color="#2e7d32"
              style={{ marginTop: 6 }}
            />
          )}

          {categoryOptions.length > 0 && (
            <ScrollView style={styles.dropdown}>
              {categoryOptions.map((opt) => (
                <TouchableOpacity
                  key={opt.id}
                  style={styles.dropdownItem}
                  onPress={() => {
                    setSelectedCategoryId(opt.id);
                    setSelectedCategoryPath(opt.path);
                    setCategoryInput(opt.path);
                    setCategoryOptions([]);
                  }}
                >
                  <Text style={styles.dropdownText}>{opt.path}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          <Text style={styles.categoryHint}>
            {selectedCategoryId
              ? "Kategorija pasirinkta"
              : "Pasirinkite L3 kategoriją"}
          </Text>

          <TouchableOpacity
            onPress={pickCreateImage}
            style={styles.imageButton}
            activeOpacity={0.8}
          >
            <Text style={styles.imageButtonText}>
              {createImageUri
                ? "Pakeisti paveiksliuką"
                : "Pridėti paveiksliuką"}
            </Text>
          </TouchableOpacity>

          {createImageUri && (
            <Image
              source={{ uri: createImageUri }}
              style={styles.previewImage}
            />
          )}

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.cancelBtn]}
              onPress={onClose}
              disabled={submitting}
            >
              <Text style={styles.cancelText}>Atšaukti</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.confirmBtn]}
              onPress={submit}
              disabled={submitting}
            >
              <Text style={styles.confirmText}>
                {submitting ? "Kuriama..." : "Pridėti"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    padding: 20,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: "#212121",
    marginBottom: 10,
  },
  label: {
    fontSize: 13,
    color: "#616161",
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: "#e0e0e0",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
    color: "#212121",
    backgroundColor: "#fff",
  },
  dropdown: {
    marginTop: 6,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: "#eceff1",
    borderRadius: 8,
    backgroundColor: "#fff",
  },
  dropdownItem: {
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: "#f3f3f3",
  },
  dropdownText: {
    fontSize: 13,
    color: "#37474f",
  },
  categoryHint: {
    marginTop: 6,
    fontSize: 12,
    color: "#757575",
  },
  imageButton: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#cfd8dc",
    alignSelf: "flex-start",
  },
  imageButtonText: {
    fontSize: 12,
    color: "#455a64",
    fontWeight: "600",
  },
  previewImage: {
    marginTop: 10,
    width: 110,
    height: 110,
    borderRadius: 10,
    backgroundColor: "#f5f5f5",
    alignSelf: "flex-start",
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 14,
  },
  actionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
  },
  cancelBtn: {
    backgroundColor: "#f3f3f3",
  },
  confirmBtn: {
    backgroundColor: "#2e7d32",
  },
  cancelText: {
    color: "#424242",
    fontWeight: "600",
    fontSize: 13,
  },
  confirmText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 13,
  },
});
