import axios from 'axios';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  YouTubeArtifacts,
  YouTubeExtractorVersion,
  YouTubeNotices,
  youtubeTarget,
} from '../src/external/youtube/YouTubeTools.ts';

export async function grabYouTube(
  targetPath = `./bin/yt-dlp${os.platform() === 'win32' ? '.exe' : ''}`,
  platform: string = os.platform(),
  arch: string = os.arch(),
): Promise<{ binaryPath: string; noticePaths: string[] }> {
  const target = youtubeTarget(platform, arch);
  const binary = Object.hasOwn(YouTubeArtifacts, target)
    ? YouTubeArtifacts[target]
    : undefined;
  if (!binary) {
    throw new Error(`No pinned YouTube extractor for ${target}`);
  }
  const files = [
    ...Object.entries(YouTubeNotices).map(([name, artifact]) => ({
      path: path.join(path.dirname(targetPath), name),
      artifact,
    })),
    { path: targetPath, artifact: binary },
  ];
  const prepared: { path: string; data: Buffer }[] = [];
  // Verify the entire set before changing an existing install. Cache checks do
  // not execute the target, so cross-architecture packaging is safe.
  for (const file of files) {
    const cached = await fs.readFile(file.path).catch(() => undefined);
    if (cached && digest(cached) === file.artifact.sha256) {
      continue;
    }
    const response = await axios.get<ArrayBuffer>(file.artifact.url, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxContentLength: 128 * 1024 * 1024,
      maxRedirects: 5,
    });
    const data = Buffer.from(response.data);
    if (digest(data) !== file.artifact.sha256) {
      throw new Error(
        `YouTube ${path.basename(file.path)} checksum does not match ${YouTubeExtractorVersion}`,
      );
    }
    prepared.push({ path: file.path, data });
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  for (const file of prepared) {
    const temporary = `${file.path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, file.data, {
        flag: 'wx',
        mode: file.path === targetPath ? 0o755 : 0o644,
      });
      await fs.rename(temporary, file.path);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  await fs.chmod(targetPath, 0o755);
  return {
    binaryPath: targetPath,
    noticePaths: files.slice(0, -1).map((file) => file.path),
  };
}

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const args = await yargs(hideBin(process.argv))
    .option('platform', { type: 'string', default: os.platform() })
    .option('arch', { type: 'string', default: os.arch() })
    .option('outPath', { type: 'string' })
    .option('optional', { type: 'boolean', default: false })
    .parseAsync();
  try {
    const installed = await grabYouTube(args.outPath, args.platform, args.arch);
    console.log(`yt-dlp ${YouTubeExtractorVersion}: ${installed.binaryPath}`);
  } catch (error) {
    console.error('Could not provision YouTube tools.', error);
    if (!args.optional) {
      process.exitCode = 1;
    } else {
      console.warn(
        'Continuing without YouTube. Run pnpm download-youtube in server/ to retry; other sources are unaffected.',
      );
    }
  }
}
