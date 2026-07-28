import { Stack } from 'expo-router';
import { Platform, StyleSheet } from 'react-native';
import { BlurTargetView } from 'expo-blur';
import { useTheme } from '../../../constants/theme';
import { tabStackOptions } from '../../../constants/navHeader';
import { tabBlurTargets } from '../../../state/tabBlurTargets';

export default function MenuLayout() {
    const colors = useTheme();
    const stack = <Stack screenOptions={tabStackOptions(colors)} />;
    if (Platform.OS !== 'android') return stack;
    // ANDROID: the tab tree is a BlurTargetView so the floating tab dock (an
    // overlay OUTSIDE it) can blur this tab's content — see state/tabBlurTargets.
    return (
        <BlurTargetView ref={tabBlurTargets.menu} style={styles.blurTarget}>
            {stack}
        </BlurTargetView>
    );
}

const styles = StyleSheet.create({ blurTarget: { flex: 1 } });
