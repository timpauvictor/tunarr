import {
  calculateOmnirating,
  parseRatingFieldKey,
  ratingFieldKey,
} from '@tunarr/shared/util';
import type { RatingSnapshot } from '@tunarr/types/schemas';

export type RatingSearchFields = {
  numericRatings: Record<string, number>;
  ratingKeys: string[];
  omnirating: number | null;
};

export function ratingSearchFields(
  snapshot: RatingSnapshot | null | undefined,
): RatingSearchFields {
  const values = new Map<string, number>();
  for (const entry of snapshot?.entries ?? []) {
    const key = ratingFieldKey(entry.providerId, entry.kind);
    if (!values.has(key)) values.set(key, entry.value * 10);
  }
  return {
    numericRatings: Object.fromEntries(values),
    ratingKeys: [...values.keys()],
    omnirating: calculateOmnirating(snapshot),
  };
}

export function ratingIndexField(key: string): string {
  if (key.startsWith('score_v1_')) {
    if (!parseRatingFieldKey(key))
      throw new Error('Invalid rating field identity');
    return `numericRatings.${key}`;
  }
  return key;
}
