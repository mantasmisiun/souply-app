import { patchTemplate, type TemplateCoverImage } from './basketTemplatesApi';

/** The identity slice of a template the edit pane can change — name + cover.
 *  (The sourceUrl is deliberately absent: it can never be edited.) */
export interface TemplateIdentity {
    name: string;
    coverColor: string | null;
    coverImage: TemplateCoverImage | null;
}

/**
 * Optimistically save a recipe's edited identity: `apply(next)` NOW (the
 * screen repaints before the network round-trip), then PATCH; a failed PATCH
 * applies `prev` back, so the screen can never keep showing an identity the
 * server refused. Returns whether the save stuck — the caller surfaces the
 * error (this util stays UI-free so the revert contract is unit-testable).
 *
 * The old inline call sites swallowed the failure (`.catch(() => {})`),
 * leaving a phantom name/cover on screen — this helper exists so every
 * identity save shares the revert.
 */
export async function saveTemplateIdentity(
    templateId: number,
    prev: TemplateIdentity,
    next: TemplateIdentity,
    apply: (identity: TemplateIdentity) => void,
): Promise<boolean> {
    apply(next);
    try {
        await patchTemplate(templateId, {
            name: next.name, coverColor: next.coverColor, coverImage: next.coverImage,
        });
        return true;
    } catch {
        apply(prev);
        return false;
    }
}
