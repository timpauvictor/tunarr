import { describe, expect, test } from 'vitest';
import { ratingFieldKey } from '@tunarr/shared/util';
import type { SearchFilter, SearchRequest } from '@tunarr/types/schemas';
import { librarySearchQuery } from './librarySearchQuery.ts';
import { ratingSearchFieldSpecs } from './ratingSearchFields.ts';

const scoreKey = ratingFieldKey('unknown-provider', 'audience');
const filter: SearchFilter = {
  type: 'value',
  fieldSpec: { key: scoreKey, type: 'numeric', op: '>', value: 70.5 },
};

describe('ratings search UI boundaries', () => {
  test('uses decimal 0-100 fields, including retained identities while the catalog loads', () => {
    const specs = ratingSearchFieldSpecs([], scoreKey);
    const score = specs.find((spec) => spec.key === scoreKey);
    expect(score?.displayName).toBe('unknown-provider audience (0-100)');
    expect(score?.disabled).toBe(true);
    expect(score?.uiBijection?.from('70.5')).toBe(70.5);
    expect(score?.uiBijection?.from('')).toBeNaN();
    expect(
      specs.find((spec) => spec.key === 'omnirating')?.valueBounds,
    ).toEqual({ min: 0, max: 100 });
    expect(
      ratingSearchFieldSpecs([
        {
          key: scoreKey,
          providerId: 'unknown-provider',
          kind: 'audience',
          label: 'Unknown audience',
          ready: true,
        },
      ]).find((spec) => spec.key === scoreKey)?.disabled,
    ).toBe(false);
  });

  test('forwards explicit score sort and filters at root and in parent navigation', () => {
    const request: SearchRequest = {
      query: 'example',
      restrictSearchTo: ['title'],
      filter,
      sort: [{ field: scoreKey, direction: 'desc' }],
    };
    const child: SearchFilter = {
      type: 'value',
      fieldSpec: {
        key: 'parent.id',
        type: 'string',
        op: '=',
        value: ['parent-fixture'],
      },
    };
    expect(librarySearchQuery(request)).toEqual(request);
    expect(
      librarySearchQuery(request, undefined, child, [
        { field: 'index', direction: 'asc' },
      ]),
    ).toEqual({
      ...request,
      filter: { type: 'op', op: 'and', children: [child, filter] },
    });
    expect(
      librarySearchQuery(undefined, undefined, child, [
        { field: 'index', direction: 'asc' },
      ]),
    ).toEqual({ filter: child, sort: [{ field: 'index', direction: 'asc' }] });
    expect(librarySearchQuery(undefined, filter)).toEqual({ filter });
  });
});
