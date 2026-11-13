import axios from 'axios';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type * as YouTubeTools from '../src/external/youtube/YouTubeTools.ts';
import { grabYouTube } from './download-youtube.ts';

vi.mock('axios');
vi.mock('../src/external/youtube/YouTubeTools.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof YouTubeTools>();
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update('verified fixture').digest('hex');
  const fixtures = (artifacts: typeof actual.YouTubeArtifacts) =>
    Object.fromEntries(
      Object.entries(artifacts).map(([name, artifact]) => [
        name,
        { ...artifact, sha256 },
      ]),
    );
  return {
    ...actual,
    YouTubeArtifacts: fixtures(actual.YouTubeArtifacts),
    YouTubeNotices: fixtures(actual.YouTubeNotices),
  };
});
let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tunarr-youtube-'));
  vi.mocked(axios.get).mockResolvedValue({
    data: Buffer.from('verified fixture'),
  });
});
afterEach(async () => {
  vi.resetAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

test('provisions verified bytes and both notices, reuses checksum-valid cache without executing it', async () => {
  const target = path.join(directory, 'bin', 'yt-dlp');
  const installed = await grabYouTube(target, 'alpine', 'x64');
  expect(await fs.readFile(installed.binaryPath, 'utf8')).toBe(
    'verified fixture',
  );
  expect(installed.noticePaths.map((file) => path.basename(file))).toEqual([
    'yt-dlp-LICENSE.txt',
    'yt-dlp-THIRD_PARTY_LICENSES.txt',
  ]);
  for (const file of installed.noticePaths)
    expect(await fs.readFile(file, 'utf8')).toBe('verified fixture');
  expect(axios.get).toHaveBeenLastCalledWith(
    expect.stringContaining('/2026.10.26/yt-dlp_musllinux'),
    expect.objectContaining({ timeout: 60_000, maxContentLength: 134217728 }),
  );
  expect(axios.get).toHaveBeenCalledTimes(3);
  await grabYouTube(target, 'alpine', 'x64');
  expect(axios.get).toHaveBeenCalledTimes(3);
});

test('rejects a bad digest before changing any existing binary or notice', async () => {
  const target = path.join(directory, 'yt-dlp');
  const notice = path.join(directory, 'yt-dlp-LICENSE.txt');
  await fs.writeFile(target, 'old binary');
  await fs.writeFile(notice, 'old notice');
  vi.mocked(axios.get)
    .mockResolvedValueOnce({ data: Buffer.from('verified fixture') })
    .mockResolvedValueOnce({ data: Buffer.from('verified fixture') })
    .mockResolvedValueOnce({ data: Buffer.from('bad binary') });
  await expect(grabYouTube(target, 'linux', 'x64')).rejects.toThrow('checksum');
  expect(await fs.readFile(target, 'utf8')).toBe('old binary');
  expect(await fs.readFile(notice, 'utf8')).toBe('old notice');
  expect((await fs.readdir(directory)).sort()).toEqual([
    'yt-dlp',
    'yt-dlp-LICENSE.txt',
  ]);
});

test('unsupported targets and download failures do not install partial tools', async () => {
  const target = path.join(directory, 'yt-dlp');
  await expect(grabYouTube(target, 'freebsd', 'x64')).rejects.toThrow(
    'No pinned',
  );
  expect(axios.get).not.toHaveBeenCalled();
  vi.mocked(axios.get).mockRejectedValue(new Error('offline'));
  await expect(grabYouTube(target, 'win', 'x64')).rejects.toThrow('offline');
  expect(await fs.readdir(directory)).toEqual([]);
});
