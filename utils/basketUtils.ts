import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';

export const addProductToBasket = async (
    productId: number,
    draftBasketId: number | null,
    setDraftBasketId: (id: number) => void,
    quantity: number = 1   // ADD this parameter with default
) => {
    try {
        const userId = await getUserId();
        let basketId = draftBasketId;

        // Create draft basket if none exists
        if (!basketId) {
            const res = await fetch(`${API_BASE_URL}/api/baskets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            const data = await res.json();
            basketId = data.id;
            setDraftBasketId(data.id);
        }

        // Add item to basket
        const res = await fetch(`${API_BASE_URL}/api/basket-items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ basketId, productId, quantity }),
        });

        if (res.status === 409) {
            return { success: false, message: 'Produktas jau yra krepšelyje' };
        }

        return { success: true, message: 'Produktas pridėtas į krepšelį' };
    } catch (error) {
        return { success: false, message: 'Nepavyko pridėti produkto' };
    }
};