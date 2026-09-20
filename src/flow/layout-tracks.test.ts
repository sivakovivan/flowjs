import { describe, expect, it } from 'vitest';
import { defaultLayoutTracks, personalParent } from './layout-tracks';
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
});
