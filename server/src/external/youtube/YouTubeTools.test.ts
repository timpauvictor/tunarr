import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  YouTubeArtifacts,
  YouTubeNotices,
  youtubeExecutable,
  youtubeTarget,
} from './YouTubeTools.ts';

test('maps all current distributions to exact upstream assets, with a distinct musl artifact', () => {
  const expected = {
    'linux-x64': 'yt-dlp_linux',
    'linux-arm64': 'yt-dlp_linux_aarch64',
    'alpine-x64': 'yt-dlp_musllinux',
    'macos-x64': 'yt-dlp_macos',
    'macos-arm64': 'yt-dlp_macos',
    'win-x64': 'yt-dlp.exe',
  };
  expect(Object.keys(YouTubeArtifacts).sort()).toEqual(
    Object.keys(expected).sort(),
  );
  for (const [target, name] of Object.entries(expected)) {
    const artifact = YouTubeArtifacts[target];
    if (!artifact) throw new Error(`Missing artifact ${target}`);
    expect(artifact.url).toBe(
      `https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/${name}`,
    );
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(YouTubeArtifacts['alpine-x64']?.sha256).not.toBe(
    YouTubeArtifacts['linux-x64']?.sha256,
  );
  expect(youtubeTarget('win32', 'x64')).toBe('win-x64');
  expect(youtubeTarget('darwin', 'arm64')).toBe('macos-arm64');
  expect(Object.keys(YouTubeNotices)).toEqual([
    'yt-dlp-LICENSE.txt',
    'yt-dlp-THIRD_PARTY_LICENSES.txt',
  ]);
});

test('finds source/container tools, release siblings regardless of working directory and explicit overrides', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'tunarr-youtube-paths-'),
  );
  try {
    const cwd = path.join(directory, 'data');
    const release = path.join(directory, 'release');
    await fs.mkdir(release);
    const tool = path.join(release, 'yt-dlp.exe');
    await fs.writeFile(tool, 'fixture');
    expect(
      youtubeExecutable(
        '',
        cwd,
        path.join(release, 'tunarr.exe'),
        'win32',
        'x64',
      ),
    ).toBe(tool);
    expect(
      youtubeExecutable(
        'admin-tool',
        cwd,
        path.join(release, 'tunarr.exe'),
        'win32',
        'x64',
      ),
    ).toBe('admin-tool');
    await fs.mkdir(path.join(cwd, 'bin'), { recursive: true });
    const sourceTool = path.join(cwd, 'bin', 'yt-dlp-linux-x64');
    await fs.writeFile(sourceTool, 'fixture');
    expect(
      youtubeExecutable('', cwd, path.join(release, 'tunarr'), 'linux', 'x64'),
    ).toBe(sourceTool);
    const muslTool = path.join(release, 'yt-dlp-alpine-x64');
    await fs.writeFile(muslTool, 'musl fixture');
    expect(
      youtubeExecutable(
        '',
        cwd,
        path.join(release, 'tunarr-test-alpine-x64'),
        'linux',
        'x64',
      ),
    ).toBe(muslTool);
    await fs.rm(sourceTool);
    expect(
      youtubeExecutable('', cwd, path.join(release, 'tunarr'), 'linux', 'x64'),
    ).toBe('yt-dlp');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
