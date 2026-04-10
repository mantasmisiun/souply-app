import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const USER_ID_KEY = 'userId';

// export const getUserId = async (): Promise<string> => {
//     let userId = await AsyncStorage.getItem(USER_ID_KEY);
//     if (!userId) {
//         userId = Crypto.randomUUID();
//         await AsyncStorage.setItem(USER_ID_KEY, userId);
//     }
//     return userId;
// };

//default user for testing purposes, replace with above code for production
export const getUserId = async (): Promise<string> => {
    return '00000000-0000-0000-0000-000000000000';
};