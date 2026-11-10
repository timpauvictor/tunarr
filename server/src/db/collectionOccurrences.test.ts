import { describe, expect, test } from 'vitest';
import { reconcileCollectionOccurrences } from './collectionOccurrences.ts';

describe('ordered collection occurrence identity', () => {
  test('keeps repeated programme occurrences distinct across insert/remove/reorder', () => {
    const previous = [
      { uuid: 'a-first', videoId: 'a', upstreamEntryId: null },
      { uuid: 'b-first', videoId: 'b', upstreamEntryId: null },
      { uuid: 'a-second', videoId: 'a', upstreamEntryId: null },
    ];
    const entries = reconcileCollectionOccurrences(previous, [
      { videoId: 'b', upstreamEntryId: null },
      { videoId: 'a', upstreamEntryId: null },
      { videoId: 'c', upstreamEntryId: null },
      { videoId: 'a', upstreamEntryId: null },
    ]);
    expect(entries.map((entry) => entry.uuid)).toEqual([
      'b-first',
      'a-first',
      expect.any(String),
      'a-second',
    ]);
    expect(entries.map((entry) => entry.position)).toEqual([0, 1, 2, 3]);
    expect(new Set(entries.map((entry) => entry.uuid)).size).toBe(4);
    expect(
      reconcileCollectionOccurrences(entries, [
        { videoId: 'a', upstreamEntryId: null },
      ])[0]?.uuid,
    ).toBe('a-first');
  });

  test('uses an upstream occurrence ID when supplied and retains unidentified exclusions', () => {
    const entries = reconcileCollectionOccurrences(
      [
        { uuid: 'two', videoId: 'a', upstreamEntryId: 'entry-two' },
        { uuid: 'one', videoId: 'a', upstreamEntryId: 'entry-one' },
        { uuid: 'unknown', videoId: null, upstreamEntryId: null },
      ],
      [
        { videoId: 'a', upstreamEntryId: 'entry-one' },
        { videoId: null, upstreamEntryId: null },
        { videoId: 'a', upstreamEntryId: 'entry-two' },
      ],
    );
    expect(entries.map((entry) => entry.uuid)).toEqual([
      'one',
      'unknown',
      'two',
    ]);
  });
});
