/**
 * Protects credentials in media commands and diagnostics a user might share.
 *
 * Covers the query-string form ffmpeg sees in source URLs, the `Name: value`
 * header form, and the `Token="..."` field in Jellyfin's Authorization header.
 */
export function hasMediaBearerCredential(args: readonly string[]): boolean {
  return args.some((arg) => /\bAuthorization:\s*Bearer\s+/i.test(arg));
}

export function redactMediaServerSecrets(text: string): string {
  return text
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1REDACTED')
    .replace(/(X-Plex-Token[:=]\s*)[A-Za-z0-9_-]+/g, '$1REDACTED')
    .replace(/(X-Emby-Token[:=]\s*)[A-Za-z0-9_-]+/g, '$1REDACTED')
    .replace(/(api_key=)[A-Za-z0-9_-]+/g, '$1REDACTED')
    .replace(/(\bToken=\\?")[^"\\]*/g, '$1REDACTED');
}
