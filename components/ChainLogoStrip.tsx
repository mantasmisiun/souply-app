import { useMemo } from 'react';
import { View, Image, Text, StyleSheet } from 'react-native';
import { useTheme, AppTheme } from '../constants/theme';
import { chainBrandColorById } from '../utils/chainBrandName';

interface ChainLogo {
    chainId: number;
    logoUrl: string | null;
}

interface Props {
    chainLogos: ChainLogo[] | string | null | undefined;
    style?: object;
}

function parse(raw: ChainLogo[] | string | null | undefined): ChainLogo[] {
    if (!raw) return [];
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return []; }
    }
    return raw;
}

const LOGO_SIZE = 13;
const WRAPPER_SIZE = LOGO_SIZE + 4; // white ring padding around each logo

export function ChainLogoStrip({ chainLogos, style }: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const logos = parse(chainLogos);
    if (logos.length === 0) return null;

    const shown = logos.slice(0, 2);
    const overflow = logos.length - 2;

    return (
        <View style={[styles.pill, style]}>
            <View style={styles.logoRow}>
                {shown.map(({ chainId, logoUrl }, index) => (
                    <View
                        key={chainId}
                        style={[
                            styles.logoWrapper,
                            { backgroundColor: chainBrandColorById(chainId) },
                            index > 0 && styles.secondLogo,
                        ]}
                    >
                        {logoUrl ? (
                            <Image source={{ uri: logoUrl }} style={styles.logo} resizeMode="contain" />
                        ) : (
                            <Text style={styles.fallbackText}>{chainId}</Text>
                        )}
                    </View>
                ))}
            </View>
            {overflow > 0 && (
                <Text style={styles.overflow}>+{overflow}</Text>
            )}
        </View>
    );
}

function makeStyles(c: AppTheme) {
    return StyleSheet.create({
        pill: {
            flexDirection: 'row',
            alignItems: 'center',
            alignSelf: 'flex-start',
        },
        logoRow: {
            flexDirection: 'row',
            alignItems: 'center',
        },
        logoWrapper: {
            width: WRAPPER_SIZE,
            height: WRAPPER_SIZE,
            borderRadius: 4,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
        },
        secondLogo: {
            marginLeft: -8,
            transform: [{ rotate: '12deg' }],
        },
        logo: {
            width: LOGO_SIZE,
            height: LOGO_SIZE,
        },
        fallbackText: {
            fontSize: 7,
            fontWeight: '700',
            color: '#FFFFFF',
        },
        overflow: {
            fontSize: 9,
            fontWeight: '700',
            color: c.textPrimary,
            marginLeft: 2,
        },
    });
}
