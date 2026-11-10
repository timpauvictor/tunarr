import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { serverOptions } from '../../globals.ts';
import { EtvNextDossierFolderName } from '../../util/constants.ts';
import { redactMediaServerSecrets } from '../../util/redactSecrets.ts';

/**
 * How many dossiers a channel keeps.
 *
 * A channel that fails every item writes one per failure, so the directory is
 * unbounded without a cap. Five is enough to see whether a failure repeats and
 * small enough that the zip stays attachable to a bug report.
 */
export const DossierRetentionCount = 5;

export type Dossier = {
  /** The directory the worker wrote, `<channelNumber>_<timestamp>`. */
  name: string;
  capturedAt: Date;
  sizeBytes: number;
};

/** Where a channel's dossiers accumulate, across sessions. */
export function dossierDirectory(
  channelUuid: string,
  rootDirectory: string = path.join(
    serverOptions().databaseDirectory,
    EtvNextDossierFolderName,
  ),
): string {
  return path.join(rootDirectory, channelUuid);
}

/**
 * Lists a channel's dossiers, newest first.
 *
 * Ordered by write time rather than by name. The names carry a timestamp, but
 * nothing in the contract says it sorts.
 */
export async function listDossiers(directory: string): Promise<Dossier[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    // No directory means no failures yet, which is the common case.
    return [];
  }

  const dossiers = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const full = path.join(directory, entry.name);
        const stat = await fs.stat(full);
        return {
          name: entry.name,
          capturedAt: stat.mtime,
          sizeBytes: await directorySize(full),
        };
      }),
  );

  return dossiers.sort(
    (a, b) => b.capturedAt.getTime() - a.capturedAt.getTime(),
  );
}

/**
 * Drops all but the newest `keep` dossiers.
 *
 * Run before a session spawns its worker rather than after each failure. The
 * worker writes these itself and tells Tunarr nothing, so there is no moment
 * to prune on, and the cap is about disk over time rather than during one
 * session.
 */
export async function pruneDossiers(
  directory: string,
  keep: number = DossierRetentionCount,
): Promise<void> {
  const dossiers = await listDossiers(directory);

  await Promise.all(
    dossiers.slice(keep).map((dossier) =>
      fs.rm(path.join(directory, dossier.name), {
        recursive: true,
        force: true,
      }),
    ),
  );
}

async function directorySize(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return directorySize(full);
      }
      if (!entry.isFile()) {
        return 0;
      }
      return (await fs.stat(full)).size;
    }),
  );

  return sizes.reduce((total, size) => total + size, 0);
}

/** Lists every file in a dossier as a path relative to the dossier. */
export async function listDossierFiles(dossierPath: string): Promise<string[]> {
  const entries = await fs.readdir(dossierPath, {
    withFileTypes: true,
    recursive: true,
  });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(dossierPath, path.join(entry.parentPath, entry.name)),
    );
}

/** Publishes only redacted, bounded copies outside the live private workspace. */
export async function retainRedactedDossiers(
  source: string,
  destination: string,
): Promise<void> {
  const dossiers = (await listDossiers(source)).slice(0, DossierRetentionCount);
  for (const dossier of dossiers) {
    const sourceDirectory = path.join(source, dossier.name);
    for (const file of await listDossierFiles(sourceDirectory)) {
      const original = path.join(sourceDirectory, file);
      const target = path.join(destination, dossier.name, file);
      const stat = await fs.stat(original);
      const retained = await fs.stat(target).catch(() => undefined);
      if (retained && retained.mtimeMs >= stat.mtimeMs) {
        continue;
      }
      // Reports are diagnostic data, not a media archive. Do not load an
      // arbitrarily large native artifact into the server or retain its body.
      const content =
        stat.size <= 4 * 1024 * 1024
          ? redactDossierFile(await fs.readFile(original))
          : 'Diagnostic file omitted because it exceeded the 4 MiB retention limit.\n';
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = target + '.tmp';
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, target);
      await fs.utimes(target, stat.atime, stat.mtime);
    }
  }
  await pruneDossiers(destination);
}

/**
 * Prepares one dossier file for the diagnostics zip.
 *
 * The ffmpeg report and the playout item quote HTTP source URLs and headers,
 * which carry media-server tokens, and users attach this zip to public bug
 * reports. Text is redacted. A file with a NUL byte is treated as binary and
 * passed through unchanged.
 */
export function redactDossierFile(content: Buffer): Buffer | string {
  if (content.includes(0)) {
    return content;
  }
  return redactMediaServerSecrets(content.toString('utf8'));
}
