import { describe, expect, it } from 'vitest';
import {
    createPersonalDraft,
    defaultLayoutTracks,
    personalParent,
} from './layout-tracks';
import type { VersionRecord } from './store';

const average = { id: 'v1' } as VersionRecord;

describe('layout tracks', () => {
    it('defaults a new user to the aggregate average layout', () => {
        expect(defaultLayoutTracks(average)).toEqual({
            average,
            personal: null,
            selected: 'average',
        });
    });

    it('seeds a personal branch from the average until one exists', () => {
        const tracks = defaultLayoutTracks(average);
        expect(personalParent(tracks)).toBe(average);
        const personal = { id: 'personal-v1' } as VersionRecord;
        expect(personalParent({ ...tracks, personal })).toBe(personal);
    });

    it('creates a distinct personal draft without changing the average', () => {
        const personal = createPersonalDraft(average);
        expect(personal.id).toBe('v1-personal');
        expect(personal.parentVersionId).toBe('v1');
        expect(personal.schema).not.toBe(average.schema);
        expect(average.id).toBe('v1');
    });
});
