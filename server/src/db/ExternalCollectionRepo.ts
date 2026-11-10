import { and, asc, count, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { reconcileCollectionOccurrences } from './collectionOccurrences.ts';
import { MediaSourceLibrary } from './schema/MediaSourceLibrary.ts';
import { inject, injectable } from 'inversify';
import { KEYS } from '../types/inject.ts';
import type { MediaSourceId } from './schema/base.ts';
import type { NewExternalCollection } from './schema/ExternalCollection.ts';
import {
  ExternalCollection,
  ExternalCollectionPrograms,
} from './schema/ExternalCollection.ts';

export type YouTubeSnapshotEntry = {
  videoId: string | null;
  upstreamEntryId: string | null;
  programId: string | null;
  status: 'available' | 'pending' | 'unavailable';
  message: string | null;
};
import type { DrizzleDBAccess } from './schema/index.ts';

@injectable()
export class ExternalCollectionRepo {
  constructor(
    @inject(KEYS.DrizzleDB)
    private drizzleDB: DrizzleDBAccess,
  ) {}

  publishYouTubeSnapshot(
    collection: NewExternalCollection,
    incoming: readonly YouTubeSnapshotEntry[],
    signal: AbortSignal,
  ) {
    return this.drizzleDB.transaction((tx) => {
      signal.throwIfAborted();
      const library = tx
        .select()
        .from(MediaSourceLibrary)
        .where(eq(MediaSourceLibrary.uuid, collection.libraryId))
        .get();
      if (
        !library ||
        !library.enabled ||
        library.unavailableSince ||
        library.mediaSourceId !== collection.mediaSourceId
      ) {
        throw new Error('YouTube library is no longer available.');
      }
      const saved = tx
        .insert(ExternalCollection)
        .values({
          ...collection,
          snapshotId: randomUUID(),
          lastSuccessfulRefreshAt: new Date(),
          lastRefreshError: null,
        })
        .onConflictDoUpdate({
          target: [
            ExternalCollection.mediaSourceId,
            ExternalCollection.externalKey,
          ],
          set: {
            title: collection.title,
            kind: collection.kind,
            snapshotId: randomUUID(),
            lastSuccessfulRefreshAt: new Date(),
            lastRefreshError: null,
          },
        })
        .returning()
        .get();
      const previous = tx
        .select()
        .from(ExternalCollectionPrograms)
        .where(eq(ExternalCollectionPrograms.collectionId, saved.uuid))
        .orderBy(
          asc(ExternalCollectionPrograms.position),
          asc(ExternalCollectionPrograms.uuid),
        )
        .all();
      const entries = reconcileCollectionOccurrences(previous, incoming);
      tx.delete(ExternalCollectionPrograms)
        .where(eq(ExternalCollectionPrograms.collectionId, saved.uuid))
        .run();
      for (let start = 0; start < entries.length; start += 100) {
        tx.insert(ExternalCollectionPrograms)
          .values(
            entries
              .slice(start, start + 100)
              .map((entry) => ({ ...entry, collectionId: saved.uuid })),
          )
          .run();
      }
      signal.throwIfAborted();
      const previousIds = new Set(previous.map((entry) => entry.uuid));
      const nextIds = new Set(entries.map((entry) => entry.uuid));
      return {
        ...saved,
        refreshChanges: {
          added: entries.filter((entry) => !previousIds.has(entry.uuid)).length,
          removed: previous.filter((entry) => !nextIds.has(entry.uuid)).length,
        },
      };
    });
  }

  recordYouTubeRefreshFailure(
    mediaSourceId: MediaSourceId,
    externalKey: string,
    message: string,
  ) {
    return this.drizzleDB
      .update(ExternalCollection)
      .set({ lastRefreshError: message })
      .where(
        and(
          eq(ExternalCollection.mediaSourceId, mediaSourceId),
          eq(ExternalCollection.externalKey, externalKey),
        ),
      )
      .execute();
  }

  getOccurrencePage(
    collectionId: string,
    offset: number,
    limit: number,
    reverse: boolean,
  ) {
    return this.drizzleDB.query.externalCollectionPrograms
      .findMany({
        where: (fields, { eq }) => eq(fields.collectionId, collectionId),
        orderBy: reverse
          ? [
              desc(ExternalCollectionPrograms.position),
              desc(ExternalCollectionPrograms.uuid),
            ]
          : [
              asc(ExternalCollectionPrograms.position),
              asc(ExternalCollectionPrograms.uuid),
            ],
        offset,
        limit,
        with: {
          program: {
            with: {
              artwork: true,
              externalIds: true,
              genres: { with: { genre: true } },
            },
          },
        },
      })
      .execute();
  }

  async getOccurrenceCount(collectionId: string) {
    const result = await this.drizzleDB
      .select({ count: count() })
      .from(ExternalCollectionPrograms)
      .where(eq(ExternalCollectionPrograms.collectionId, collectionId));
    return result[0]?.count ?? 0;
  }

  insertCollection(coll: NewExternalCollection) {
    return this.drizzleDB.insert(ExternalCollection).values(coll).execute();
  }

  getById(id: string) {
    return this.drizzleDB.query.externalCollections
      .findFirst({
        where: (fields, { eq }) => eq(fields.uuid, id),
        with: {
          groupings: {
            columns: {},
            with: {
              grouping: true,
            },
          },
          programs: {
            columns: {},
            with: {
              program: true,
            },
          },
        },
      })
      .execute();
  }

  deleteCollection(id: string) {
    return this.drizzleDB
      .delete(ExternalCollection)
      .where(eq(ExternalCollection.uuid, id))
      .execute();
  }

  getByMediaSourceId(mediaSourceId: MediaSourceId) {
    return this.drizzleDB.query.externalCollections
      .findMany({
        where: (fields, operators) =>
          operators.eq(fields.mediaSourceId, mediaSourceId),
      })
      .execute();
  }

  getByLibraryId(libraryId: string) {
    return this.drizzleDB.query.externalCollections
      .findMany({
        where: (fields, { eq }) => eq(fields.libraryId, libraryId),
      })
      .execute();
  }

  getCollectionByExternalId(mediaSourceId: MediaSourceId, externalKey: string) {
    return this.drizzleDB.query.externalCollections
      .findFirst({
        where: (fields, { eq, and }) =>
          and(
            eq(fields.externalKey, externalKey),
            eq(fields.mediaSourceId, mediaSourceId),
          ),
      })
      .execute();
  }

  async getCollectionPrograms(collectionId: string) {
    const joins =
      await this.drizzleDB.query.externalCollectionPrograms.findMany({
        where: (fields, { eq }) => eq(fields.collectionId, collectionId),
        columns: {},
        with: {
          program: {
            with: {
              externalIds: true,
            },
          },
        },
      });
    return joins.map((j) => j.program);
  }

  async getCollectionProgramGroupings(collectionId: string) {
    const joins =
      await this.drizzleDB.query.externalCollectionPrograms.findMany({
        where: (fields, { eq }) => eq(fields.collectionId, collectionId),
        columns: {},
        with: {
          grouping: {
            with: {
              externalIds: true,
            },
          },
        },
      });
    return joins.map((j) => j.grouping);
  }
}
