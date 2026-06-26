import {
    View,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../../../constants/theme';

/** Redirect: old split route → unified [id].tsx with basketId param */
export default function SplitShoppingListRedirect() {
    const { basketId } = useLocalSearchParams<{ basketId: string }>();
    const router = useRouter();
    const colors = useTheme();

    useEffect(() => {
        (async () => {
            const raw = await AsyncStorage.getItem(`split_lists_${basketId}`);
            if (raw) {
                const entries = JSON.parse(raw);
                if (entries.length > 0) {
                    router.replace(`/shopping-list/${entries[0].listId}?basketId=${basketId}` as any);
                    return;
                }
            }
            router.back();
        })();
    }, [basketId]);

    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <MaterialProgress color={colors.primary} />
        </View>
    );
}
