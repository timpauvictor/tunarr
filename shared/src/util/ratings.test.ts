import {
  calculateOmnirating,
  parseRatingFieldKey,
  ratingFieldKey,
  ratingFieldLabel,
} from './ratings.js';
import type { RatingSnapshot } from '@tunarr/types/schemas';

describe('rating utilities', () => {
  test('calculates a deduplicated public average and excludes aliases and personal ratings', () => {
    const snapshot: RatingSnapshot = {
      version: 1,
      observedAt: 0,
      entries: [
        {
          providerId: 'imdb',
          kind: 'audience',
          value: 6,
          scale: 10,
          score: 60,
        },
        {
          providerId: 'rottentomatoes',
          kind: 'critic',
          value: 3.6,
          scale: 10,
          score: 36,
        },
        {
          providerId: 'rottentomatoes',
          kind: 'audience',
          value: 5,
          scale: 10,
          score: 50,
        },
        {
          providerId: 'themoviedb',
          kind: 'audience',
          value: 6.5,
          scale: 10,
          score: 65,
        },
        {
          providerId: 'plex',
          kind: 'personal',
          value: 8,
          scale: 10,
          score: 80,
        },
        {
          providerId: 'plex',
          kind: 'primary',
          value: 6,
          scale: 10,
          score: 60,
          isAlias: true,
        },
      ],
    };
    expect(calculateOmnirating(snapshot)).toBe(52.75);
    expect(calculateOmnirating(undefined)).toBeNull();
    expect(calculateOmnirating({ ...snapshot, entries: [] })).toBeNull();
  });

  test.each([
    [7.8, 8.6, 7.2, 8.2, 79.5],
    [0, 10, 50],
  ])('averages normalized values', (...values: number[]) => {
    const expected = values.pop();
    const entries = values.map((value, index) => ({
      providerId: `source${index}`,
      kind: 'audience',
      value,
      scale: 10 as const,
      score: value * 10,
    }));
    expect(calculateOmnirating({ version: 1, observedAt: 0, entries })).toBe(
      expected,
    );
  });

  test('encodes identity without exposing provider text and rejects malformed keys', () => {
    const key = ratingFieldKey('provider: 🚀/x', 'audience');
    expect(key).toMatch(/^score_v1_[0-9a-f]+$/);
    expect(parseRatingFieldKey(key)).toEqual({
      providerId: 'provider: 🚀/x',
      kind: 'audience',
    });
    expect(parseRatingFieldKey('score_v1_c0af')).toBeUndefined();
    expect(parseRatingFieldKey('score_v1_0')).toBeUndefined();
    expect(parseRatingFieldKey('score_v1_5B5D')).toBeUndefined();
    expect(ratingFieldLabel({ providerId: 'imdb', kind: 'audience' })).toBe(
      'IMDb audience',
    );
  });
});
