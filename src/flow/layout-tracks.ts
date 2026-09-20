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
 * Demo-safe personal seed: keep the average schema intact while giving a new
 * browser its own immutable-looking branch to edit. Server persistence can
 * replace this without changing the renderer contract.
 */
export function createPersonalDraft(
    average: VersionRecord,
    stored?: VersionRecord | null
): VersionRecord {
    if (stored) return stored;
    return {
        ...average,
        id: `${average.id}-personal`,
        parentVersionId: average.id,
        reason: 'Personal layout seeded from average',
        createdAt: Date.now(),
    };
}
