import { describe, expect, test } from 'vitest';
import { releaseArchiveEntries } from './releaseArchive.ts';

describe('releaseArchiveEntries', () => {
  test('puts unversioned Windows binaries in a versioned folder', () => {
    const entries = releaseArchiveEntries('tunarr-v2026.11.1-win-x64', true, {
      tunarr: './bin/tunarr-v2026.11.1-win-x64.exe',
      meilisearch: './bin/meilisearch-win-x64',
      etvNext: '/tmp/etv/ersatztv-channel.exe',
      etvNextCompanions: ['/tmp/etv/libvpl.dll', '/tmp/etv/LICENSE-libvpl'],
      additionalFiles: [
        { source: './bin/yt-dlp-win-x64.exe', name: 'yt-dlp.exe' },
        { source: './bin/yt-dlp-LICENSE.txt', name: 'yt-dlp-LICENSE.txt' },
        {
          source: './bin/yt-dlp-THIRD_PARTY_LICENSES.txt',
          name: 'yt-dlp-THIRD_PARTY_LICENSES.txt',
        },
      ],
    });

    expect(entries).toEqual([
      {
        source: './bin/tunarr-v2026.11.1-win-x64.exe',
        name: 'tunarr-v2026.11.1-win-x64/tunarr.exe',
      },
      {
        source: './bin/meilisearch-win-x64',
        name: 'tunarr-v2026.11.1-win-x64/meilisearch.exe',
      },
      {
        source: '/tmp/etv/ersatztv-channel.exe',
        name: 'tunarr-v2026.11.1-win-x64/ersatztv-channel.exe',
      },
      {
        source: './bin/yt-dlp-win-x64.exe',
        name: 'tunarr-v2026.11.1-win-x64/yt-dlp.exe',
      },
      {
        source: './bin/yt-dlp-LICENSE.txt',
        name: 'tunarr-v2026.11.1-win-x64/yt-dlp-LICENSE.txt',
      },
      {
        source: './bin/yt-dlp-THIRD_PARTY_LICENSES.txt',
        name: 'tunarr-v2026.11.1-win-x64/yt-dlp-THIRD_PARTY_LICENSES.txt',
      },
      {
        source: '/tmp/etv/libvpl.dll',
        name: 'tunarr-v2026.11.1-win-x64/libvpl.dll',
      },
      {
        source: '/tmp/etv/LICENSE-libvpl',
        name: 'tunarr-v2026.11.1-win-x64/LICENSE-libvpl',
      },
    ]);
  });

  test('omits the .exe suffix on Linux', () => {
    const entries = releaseArchiveEntries(
      'tunarr-v2026.11.1-linux-x64',
      false,
      {
        tunarr: './bin/tunarr-v2026.11.1-linux-x64',
        meilisearch: './bin/meilisearch-linux-x64',
        etvNext: '/tmp/etv/ersatztv-channel',
        etvNextCompanions: [],
        additionalFiles: [{ source: './bin/yt-dlp-linux-x64', name: 'yt-dlp' }],
      },
    );

    expect(entries.map((e) => e.name)).toEqual([
      'tunarr-v2026.11.1-linux-x64/tunarr',
      'tunarr-v2026.11.1-linux-x64/meilisearch',
      'tunarr-v2026.11.1-linux-x64/ersatztv-channel',
      'tunarr-v2026.11.1-linux-x64/yt-dlp',
    ]);
  });
});
