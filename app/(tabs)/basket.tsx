import { StyleSheet, Text, View } from 'react-native';

export default function BasketScreen() {
    return (
        <View style={styles.container}>
            <Text style={styles.title}>Basket</Text>
            <Text style={styles.subtitle}>Placeholder screen</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
    },
    title: {
        fontSize: 24,
        fontWeight: '700',
    },
    subtitle: {
        marginTop: 8,
        fontSize: 14,
        opacity: 0.7,
    },
});