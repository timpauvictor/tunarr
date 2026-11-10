import { randomUUID } from 'node:crypto';

export type CollectionOccurrence = {
  uuid: string;
  videoId: string | null;
  upstreamEntryId: string | null;
};

/** Upstream IDs win when present. Otherwise retain the nth occurrence of a
 * video; positional listing data cannot distinguish identical repeats. */
export function reconcileCollectionOccurrences<
  T extends Omit<CollectionOccurrence, 'uuid'>,
>(
  previous: readonly CollectionOccurrence[],
  incoming: readonly T[],
): Array<T & { uuid: string; position: number }> {
  const retained = new Map<string, string[]>();
  const key = (entry: Omit<CollectionOccurrence, 'uuid'>) =>
    entry.upstreamEntryId
      ? `entry:${entry.upstreamEntryId}`
      : `video:${entry.videoId ?? 'unknown'}`;
  for (const entry of previous) {
    const identity = key(entry);
    const ids = retained.get(identity) ?? [];
    ids.push(entry.uuid);
    retained.set(identity, ids);
  }
  return incoming.map((entry, position) => ({
    ...entry,
    uuid: retained.get(key(entry))?.shift() ?? randomUUID(),
    position,
  }));
}
