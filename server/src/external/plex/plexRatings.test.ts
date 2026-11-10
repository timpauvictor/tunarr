import { extractPlexRatings } from './plexRatings.js';

describe('extractPlexRatings', () => {
  test('keeps unknown provider/type identities without persisting URL credentials', () => {
    const result = extractPlexRatings({
      Rating: [
        {
          image:
            'https://user:private@reviews.example/badge.svg?token=private#secret',
          type: 'community rating',
          value: 7.5,
        },
      ],
    });
    expect(result.snapshot?.entries).toEqual([
      {
        providerId: 'https://reviews.example',
        kind: 'community rating',
        value: 7.5,
        scale: 10,
        score: 75,
        source: 'https://reviews.example/badge.svg',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  test('normalizes detailed entries, ignores non-rating metadata, and aliases an unattributed scalar', () => {
    const result = extractPlexRatings(
      {
        Rating: [
          { image: 'imdb://image', type: 'audience', value: 6 },
          { image: 'rottentomatoes://fresh', type: 'critic', value: 3.6 },
        ],
        rating: 6,
        ratingCount: 10537,
        contentRating: 'PG-13',
      },
      123,
    );
    expect(result).toEqual({
      snapshot: {
        version: 1,
        observedAt: 123,
        entries: [
          {
            providerId: 'imdb',
            kind: 'audience',
            value: 6,
            scale: 10,
            score: 60,
            source: 'imdb://image',
          },
          {
            providerId: 'rottentomatoes',
            kind: 'critic',
            value: 3.6,
            scale: 10,
            score: 36,
            source: 'rottentomatoes://fresh',
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
      },
    });
  });

  test('supports scalar audience, personal zero, personal reset, empty and unknown sources', () => {
    expect(
      extractPlexRatings({
        audienceRating: 6.9,
        userRating: 0,
        ratingCount: 10537,
      }).snapshot?.entries,
    ).toEqual([
      {
        providerId: 'plex',
        kind: 'audience',
        value: 6.9,
        scale: 10,
        score: 69,
      },
      { providerId: 'plex', kind: 'personal', value: 0, scale: 10, score: 0 },
    ]);
    expect(extractPlexRatings({ userRating: -1 }).snapshot?.entries).toEqual(
      [],
    );
    expect(
      extractPlexRatings({ rating: 7, ratingImage: 'newprovider://badge' })
        .snapshot?.entries[0]?.providerId,
    ).toBe('newprovider');
    expect(extractPlexRatings({}).snapshot?.entries).toEqual([]);
  });

  test('normalizes RT badge aliases and rejects malformed rating data without throwing', () => {
    for (const [badge, kind] of [
      ['ripe', 'critic'],
      ['rotten', 'critic'],
      ['upright', 'audience'],
      ['spilled', 'audience'],
    ]) {
      const result = extractPlexRatings({
        rating: 8,
        ratingImage: `rottentomatoes://image.rating.${badge}`,
      });
      expect(result.snapshot?.entries.map((entry) => entry.kind)).toEqual([
        kind,
      ]);
    }
    expect(
      extractPlexRatings({
        rating: 8,
        ratingImage: 'rottentomatoes://upright',
        audienceRating: 4,
        audienceRatingImage: 'rottentomatoes://rotten',
      }).error,
    ).toBe('Conflicting Plex ratings');
    expect(extractPlexRatings({ rating: 'not-a-score' })).toEqual({
      error: 'Invalid Plex scalar rating',
    });
    expect(
      extractPlexRatings({
        Rating: [{ image: 'x', type: 'critic', value: 11 }],
      }),
    ).toEqual({ error: 'Invalid Plex rating entry' });
    expect(extractPlexRatings(null).error).toBeDefined();
  });
});
