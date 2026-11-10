import { ratingFieldKey } from '@tunarr/shared/util';
import type { RatingSnapshot } from '@tunarr/types/schemas';
import type { BaseDrizzleDBAccess } from '../schema/index.ts';
import { RatingField } from '../schema/RatingField.ts';

export function registerRatingFields(
  db: Pick<BaseDrizzleDBAccess, 'insert'>,
  snapshots: Iterable<RatingSnapshot | null | undefined>,
): void {
  const fields = new Map<string, typeof RatingField.$inferInsert>();
  for (const snapshot of snapshots) {
    for (const entry of snapshot?.entries ?? []) {
      const key = ratingFieldKey(entry.providerId, entry.kind);
      fields.set(key, { key, providerId: entry.providerId, kind: entry.kind });
    }
  }
  // Keep SQLite parameter counts bounded without capping the provider set.
  const rows = [...fields.values()];
  for (let offset = 0; offset < rows.length; offset += 100) {
    db.insert(RatingField)
      .values(rows.slice(offset, offset + 100))
      .onConflictDoNothing()
      .run();
  }
}
