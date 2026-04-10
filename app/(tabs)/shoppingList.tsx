import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export default function ShoppingListScreen() {
    return (
        <View style={styles.container}>
            <Text style={styles.title}>Shopping List</Text>
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
        fontWeight: '600',
        marginBottom: 8,
    },
    subtitle: {
        fontSize: 16,
        color: '#666',
    },
});