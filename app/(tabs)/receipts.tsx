import { StyleSheet, View, Text, ScrollView } from 'react-native';

export default function ReceiptsScreen() {
    return (
        <View style={styles.container}>
            <Text style={styles.title}>Receipts</Text>
            <ScrollView>
                <Text style={styles.placeholder}>No receipts yet</Text>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
        backgroundColor: '#fff',
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 16,
    },
    placeholder: {
        fontSize: 16,
        color: '#999',
        textAlign: 'center',
        marginTop: 32,
    },
});