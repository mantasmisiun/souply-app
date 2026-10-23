import { API_BASE_URL } from '../config/api';

/**
 * The category tree fetch, as a query function.
 *
 * The rule this file exists to hold: a FAILED load must THROW. When this ran
 * inline it caught its own error and fell through to an empty list, so "the
 * server is down" and "the catalogue is empty" looked identical — the screen
 * cleared its spinner, showed nothing, and (being a mounted tab) never tried
 * again until the app restarted. Throwing lets the query layer do its job:
 * retry with backoff, keep the last good tree, and surface an error state.
 */

export interface CategoryNode {
    id: number;
    name: string;
    nameKey?: string;
    parentCategoryId: number | null;
}

export interface CategoryTree {
    l1: CategoryNode[];
    /** parentCategoryId → its L2 children. */
    l2Map: Record<number, CategoryNode[]>;
}

export const categoriesQueryKey = (language: string) => ['categories', language] as const;

export async function fetchCategoryTree(signal?: AbortSignal): Promise<CategoryTree> {
    // L1 + ALL L2 in two parallel requests (was 1 + N: one subcategory call per
    // L1). Grouping client-side means every L1 already has its children, so
    // expanding one is instant instead of a spinner.
    const [l1Res, l2Res] = await Promise.all([
        fetch(`${API_BASE_URL}/api/categories`, { signal }),
        fetch(`${API_BASE_URL}/api/categories/l2`, { signal }),
    ]);
    if (!l1Res.ok || !l2Res.ok) throw new Error(`categories ${l1Res.status}/${l2Res.status}`);

    const [l1, l2] = await Promise.all([l1Res.json(), l2Res.json()]) as [CategoryNode[], CategoryNode[]];
    const l2Map: Record<number, CategoryNode[]> = {};
    (Array.isArray(l2) ? l2 : []).forEach(cat => {
        if (cat?.parentCategoryId == null) return;
        (l2Map[cat.parentCategoryId] ??= []).push(cat);
    });
    return { l1: Array.isArray(l1) ? l1 : [], l2Map };
}
