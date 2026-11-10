import {
  ratingFieldKey,
  type RatingIdentity,
  type RatingSnapshot,
} from '@tunarr/types/schemas';

export { ratingFieldKey, parseRatingFieldKey } from '@tunarr/types/schemas';

export function calculateOmnirating(
  snapshot: RatingSnapshot | null | undefined,
): number | null {
  if (!snapshot) return null;
  const scores = new Map<string, number>();
  for (const entry of snapshot.entries) {
    if (entry.kind === 'personal' || entry.isAlias) continue;
    const key = ratingFieldKey(entry.providerId, entry.kind);
    if (!scores.has(key)) scores.set(key, entry.value * 10);
  }
  if (scores.size === 0) return null;
  return (
    [...scores.values()].reduce((sum, score) => sum + score, 0) / scores.size
  );
}

const providerLabels = new Map([
  ['imdb', 'IMDb'],
  ['rottentomatoes', 'Rotten Tomatoes'],
  ['themoviedb', 'TMDb'],
  ['plex', 'Plex'],
]);

export function ratingFieldLabel(identity: RatingIdentity): string {
  return `${providerLabels.get(identity.providerId) ?? identity.providerId} ${identity.kind}`;
}
