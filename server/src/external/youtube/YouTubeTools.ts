import { statSync } from 'node:fs';
import path from 'node:path';

export const YouTubeExtractorVersion = '2026.10.26';
const release = `https://github.com/yt-dlp/yt-dlp/releases/download/${YouTubeExtractorVersion}`;
const source = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${YouTubeExtractorVersion}`;

type Artifact = { url: string; sha256: string };
const artifact = (name: string, sha256: string): Artifact => ({
  url: `${release}/${name}`,
  sha256,
});
const macOS = artifact(
  'yt-dlp_macos',
  '0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa',
);

// Official release asset digests, not checksums fetched alongside untrusted bytes.
export const YouTubeArtifacts: Readonly<Record<string, Artifact>> = {
  'linux-x64': artifact(
    'yt-dlp_linux',
    '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795',
  ),
  'linux-arm64': artifact(
    'yt-dlp_linux_aarch64',
    'e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483',
  ),
  'alpine-x64': artifact(
    'yt-dlp_musllinux',
    'e97a4dd919221d233e7720e18fa3f66db60fbd1d8c0846bf6deb8e88e04475a8',
  ),
  'macos-x64': macOS,
  'macos-arm64': macOS,
  'win-x64': artifact(
    'yt-dlp.exe',
    'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d',
  ),
};
export const YouTubeNotices: Readonly<Record<string, Artifact>> = {
  'yt-dlp-LICENSE.txt': {
    url: `${source}/LICENSE`,
    sha256: '7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c',
  },
  'yt-dlp-THIRD_PARTY_LICENSES.txt': {
    url: `${source}/THIRD_PARTY_LICENSES.txt`,
    sha256: '472aefe951c7db35e1657c1d13fd337140511ed6f2b329205105ad441c5a02b7',
  },
};

export function youtubeTarget(platform: string, arch: string): string {
  const os =
    platform === 'win32' ? 'win' : platform === 'darwin' ? 'macos' : platform;
  return `${os}-${arch}`;
}

export function youtubeExecutable(
  configured = process.env.TUNARR_YTDLP_PATH,
  cwd = process.cwd(),
  owningExecutable = process.execPath,
  platform = process.platform,
  arch = process.arch,
): string {
  if (configured) {
    return configured;
  }
  const suffix = platform === 'win32' ? '.exe' : '';
  // Raw make-bin artifacts encode the target in the owning filename. In
  // particular, Node reports linux on Alpine too; do not select glibc there.
  const builtTarget = Object.keys(YouTubeArtifacts).find((target) =>
    path.basename(owningExecutable).endsWith(`-${target}${suffix}`),
  );
  const names = [
    `yt-dlp${suffix}`,
    `yt-dlp-${builtTarget ?? youtubeTarget(platform, arch)}${suffix}`,
  ];
  const candidates = [
    path.join(cwd, 'bin'),
    path.dirname(owningExecutable),
    cwd,
  ].flatMap((directory) => names.map((name) => path.join(directory, name)));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // A missing bundled tool can still be supplied on the administrator's PATH.
    }
  }
  return 'yt-dlp';
}
