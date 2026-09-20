import type { VersionRecord } from './store';

/** The two user-facing layout scopes. Personal layouts are seeded from average. */
export type LayoutTrack = 'average' | 'personal';

export interface LayoutTracks {
    average: VersionRecord | null;
    personal: VersionRecord | null;
    selected: LayoutTrack;
}

/** New users always start on the aggregate layout. */
export function defaultLayoutTracks(
    average: VersionRecord | null
): LayoutTracks {
    return { average, personal: null, selected: 'average' };
}

/** First personal customization must branch from the average currently shown. */
export function personalParent(tracks: LayoutTracks): VersionRecord | null {
    return tracks.personal ?? tracks.average;
}

/**
 * Demo-safe personal seed: derive a new schema from the average while giving a new
 * browser its own immutable-looking branch to edit. Server persistence can
 * replace this without changing the renderer contract.
 */
export function createPersonalDraft(
    average: VersionRecord,
    stored?: VersionRecord | null
): VersionRecord {
    if (stored && stored.parentVersionId === average.id) return stored;
    return {
        ...average,
        id: `${average.id}-personal`,
        parentVersionId: average.id,
        schema: {
            ...average.schema,
            // Mock preference for the scaffold: make search the first control.
            components: [...average.schema.components]
                .sort((a, b) => {
                    const priority = (id: string) =>
                        id === 'customer-search' ? 0 : 1;
                    return priority(a.id) - priority(b.id) || a.order - b.order;
                })
                .map((component, order) => ({ ...component, order })),
        },
        reason: 'Personal layout seeded from average',
        createdAt: Date.now(),
    };
}
