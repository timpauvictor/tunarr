import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  DBAccess,
  MigrationTableName,
  MigrationLockTableName,
} from '../../db/DBAccess.ts';

// Exercise the actual file-copy migration, not only fresh-database creation.
test('YouTube migration preserves all legacy rows, ratings and media versions', async () => {
  const directory = await fs.mkdtemp(
    path.resolve('.test-cache', 'youtube-migration-'),
  );
  const database = path.join(directory, 'legacy.db');
  const access = DBAccess.instance;
  try {
    const connection = access.getOrCreateConnection(database);
    await connection.syncMigrationTablesIfNecessary();
    await connection.runDBMigrations('migration1794256505');
    expect(
      (await connection.pendingDatabaseMigrations()).map(
        (migration) => migration.name,
      ),
    ).toEqual(['migration1794315861']);
    const sqlite = connection.sqlite;
    const snapshot = JSON.stringify({
      version: 1,
      observedAt: 1794256505000,
      entries: [
        {
          providerId: 'imdb',
          kind: 'critic',
          value: 8.2,
          scale: 10,
          score: 82,
        },
      ],
    });
    const legacySources = ['plex', 'jellyfin', 'emby', 'local'] as const;
    for (const [index, type] of legacySources.entries()) {
      const source = randomUUID(),
        library = randomUUID(),
        program = randomUUID(),
        version = randomUUID();
      sqlite
        .prepare(
          'INSERT INTO media_source (uuid,"index",name,type,uri,access_token) VALUES (?,?,?,?,?,?)',
        )
        .run(
          source,
          index,
          'Legacy ' + type,
          type,
          type === 'local' ? '' : 'http://127.0.0.1:9',
          type === 'local' ? '' : 'fixture-token',
        );
      sqlite
        .prepare(
          'INSERT INTO media_source_library (uuid,name,media_type,media_source_id,external_key,enabled,last_scanned_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          library,
          'Existing movies',
          'movies',
          source,
          'library-' + index,
          1,
          1794256505000,
        );
      sqlite
        .prepare(
          'INSERT INTO program (uuid,title,type,duration,external_key,external_source_id,source_type,media_source_id,library_id,canonical_id,ratings) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          program,
          'Existing ' + type,
          'movie',
          60000,
          'movie-' + index,
          'Legacy ' + type,
          type,
          source,
          library,
          'unchanged:' + program,
          snapshot,
        );
      const collection = randomUUID(),
        grouping = randomUUID();
      sqlite
        .prepare(
          'INSERT INTO program_grouping (uuid,title,type,source_type,media_source_id,library_id,external_key,ratings) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          grouping,
          'Existing group ' + type,
          'show',
          type,
          source,
          library,
          'group-' + index,
          snapshot,
        );
      sqlite
        .prepare(
          'INSERT INTO external_collections (uuid,media_source_id,library_id,external_key,source_type,title) VALUES (?,?,?,?,?,?)',
        )
        .run(
          collection,
          source,
          library,
          'collection-' + index,
          type,
          'Existing collection ' + type,
        );
      sqlite
        .prepare(
          'INSERT INTO external_collection_programs (collection_id,program_id,grouping_id) VALUES (?,?,NULL)',
        )
        .run(collection, program);
      sqlite
        .prepare(
          'INSERT INTO external_collection_programs (collection_id,program_id,grouping_id) VALUES (?,NULL,?)',
        )
        .run(collection, grouping);
      sqlite
        .prepare(
          'INSERT INTO program_version (uuid,created_at,updated_at,duration,scan_kind,width,height,program_id) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          version,
          1794256505000,
          1794256505000,
          60000,
          'progressive',
          640,
          360,
          program,
        );
      sqlite
        .prepare(
          'INSERT INTO program_media_file (uuid,path,program_version_id) VALUES (?,?,?)',
        )
        .run(randomUUID(), '/fixture/existing-' + type + '.mp4', version);
    }
    const tables = (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>
    ).filter(
      (table) =>
        ![MigrationTableName, MigrationLockTableName].includes(table.name),
    );
    const before = tables.map(({ name }) => {
      const columns = (
        sqlite.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);
      const select = `SELECT ${columns.map((column) => '"' + column + '"').join(',')} FROM "${name}"`;
      return {
        name,
        select,
        rows: sqlite
          .prepare(select)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      };
    });
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    await access.migrateExistingDatabase(database);
    const migrated = access.getOrCreateConnection(database);
    expect(await migrated.pendingDatabaseMigrations()).toEqual([]);
    for (const table of before)
      expect(
        migrated.sqlite
          .prepare(table.select)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
        table.name,
      ).toEqual(table.rows);
    expect(migrated.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(
      migrated.sqlite.prepare('SELECT youtube_metadata FROM program').all(),
    ).toEqual(
      Array.from({ length: legacySources.length }, () => ({
        youtube_metadata: null,
      })),
    );
    // The new provider is accepted only after the actual old-to-new migration.
    const source = randomUUID(),
      program = randomUUID();
    migrated.sqlite
      .prepare(
        'INSERT INTO media_source (uuid,"index",name,type,uri,access_token) VALUES (?,?,?,?,?,?)',
      )
      .run(source, legacySources.length, 'YouTube', 'youtube', '', '');
    migrated.sqlite
      .prepare(
        'INSERT INTO program (uuid,title,type,duration,external_key,external_source_id,source_type,media_source_id,youtube_metadata) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        program,
        'Recorded video',
        'other_video',
        10000,
        'aqz-KE-bpKQ',
        source,
        'youtube',
        source,
        JSON.stringify({ creatorName: 'Fixture creator' }),
      );
    expect(migrated.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(
      migrated.sqlite
        .prepare('SELECT count(*) AS count FROM program_media_file')
        .get(),
    ).toEqual({ count: legacySources.length });
  } finally {
    await access.closeConnection(database);
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 30000);
