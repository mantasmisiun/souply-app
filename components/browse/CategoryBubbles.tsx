import { memo, useMemo } from 'react';
import { ScrollView, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useTheme, type AppTheme } from '../../constants/theme';

interface Category {
    id: number;
    name: string;
}

interface Props {
    categories: Category[];
    selectedId: number | null;
    onSelect: (id: number | null) => void;
    allLabel: string;
}

function CategoryBubbles({ categories, selectedId, onSelect, allLabel }: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    if (categories.length === 0) return null;

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.container}
            style={styles.row}
        >
            <TouchableOpacity
                style={[styles.bubble, selectedId === null && styles.bubbleActive]}
                onPress={() => onSelect(null)}
            >
                <Text style={[styles.bubbleText, selectedId === null && styles.bubbleTextActive]}>
                    {allLabel}
                </Text>
            </TouchableOpacity>
            {categories.map(cat => (
                <TouchableOpacity
                    key={cat.id}
                    style={[styles.bubble, selectedId === cat.id && styles.bubbleActive]}
                    onPress={() => onSelect(cat.id)}
                >
                    <Text style={[styles.bubbleText, selectedId === cat.id && styles.bubbleTextActive]}>
                        {cat.name}
                    </Text>
                </TouchableOpacity>
            ))}
        </ScrollView>
    );
}

export default memo(CategoryBubbles);

const makeStyles = (c: AppTheme) => StyleSheet.create({
    row: {
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
        flexGrow: 0,
        flexShrink: 0,
    },
    container: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 8,
    },
    bubble: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.cardBackground,
    },
    bubbleActive: {
        backgroundColor: c.primary,
        borderColor: c.primary,
    },
    bubbleText: {
        fontSize: 13,
        color: c.textPrimary,
    },
    bubbleTextActive: {
        color: c.onPrimary,
        fontWeight: '600',
    },
});
