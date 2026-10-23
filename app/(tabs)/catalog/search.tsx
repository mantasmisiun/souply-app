/**
 * Catalog-tab search route. Renders the SAME screen as the root-level
 * `/search` (used by the receipt-matching flow) — one component, two mounts —
 * so catalog product search lives INSIDE the Catalog tab and keeps the nav
 * tab bar visible, while receipt matching keeps its own root-level `/search`.
 * The screen reads its behaviour (mode/source) from the route params, so no
 * props are needed here.
 */
export { default } from '@/app/search';
