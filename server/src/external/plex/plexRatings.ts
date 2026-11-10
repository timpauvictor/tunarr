import {
  RatingIdentitySchema,
  type RatingEntry,
  type RatingSnapshot,
} from '@tunarr/types/schemas';

type Extracted =
  | { snapshot: RatingSnapshot; error?: never }
  | { snapshot?: never; error: string };
type Candidate = RatingEntry & { detailed: boolean };

export function extractPlexRatings(
  input: unknown,
  observedAt: number = Date.now(),
): Extracted {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { error: 'Invalid Plex rating data' };
    }
    const data = input as Record<string, unknown>;
    const detailed: Candidate[] = [];
    if (data.Rating !== undefined && data.Rating !== null) {
      if (!Array.isArray(data.Rating)) {
        return { error: 'Invalid Plex rating entries' };
      }
      for (const item of data.Rating) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return { error: 'Invalid Plex rating entry' };
        }
        const row = item as Record<string, unknown>;
        if (row.value === undefined || row.value === null) {
          continue;
        }
        if (typeof row.value !== 'number' && typeof row.value !== 'string') {
          return { error: 'Invalid Plex rating value' };
        }
        const value = parseValue(row.value);
        if (
          value === undefined ||
          typeof row.image !== 'string' ||
          typeof row.type !== 'string'
        ) {
          return { error: 'Invalid Plex rating entry' };
        }
        const providerId = providerFromImage(row.image);
        const kind = kindFromType(row.type);
        const identity = RatingIdentitySchema.safeParse({ providerId, kind });
        if (!identity.success) {
          return { error: 'Invalid Plex rating identity' };
        }
        detailed.push(
          entry(
            identity.data.providerId,
            identity.data.kind,
            value,
            row.image,
            false,
            true,
          ),
        );
      }
    }

    const candidates = [...detailed];
    const scalars: Array<[string, unknown, unknown]> = [
      ['rating', data.rating, data.ratingImage],
      ['audienceRating', data.audienceRating, data.audienceRatingImage],
      ['userRating', data.userRating, undefined],
    ];
    for (const [field, raw, rawImage] of scalars) {
      if (
        raw === undefined ||
        raw === null ||
        (field === 'userRating' && (raw === -1 || raw === '-1'))
      ) {
        continue;
      }
      if (typeof raw !== 'number' && typeof raw !== 'string') {
        return { error: 'Invalid Plex scalar rating' };
      }
      const value = parseValue(raw);
      if (value === undefined) {
        return { error: 'Invalid Plex scalar rating' };
      }
      if (rawImage !== undefined && typeof rawImage !== 'string') {
        return { error: 'Invalid Plex rating source' };
      }
      const image = typeof rawImage === 'string' ? rawImage : undefined;
      const providerId = image ? providerFromImage(image) : 'plex';
      const kind =
        field === 'userRating'
          ? 'personal'
          : image
            ? kindFromScalar(field, providerId, image)
            : field === 'audienceRating'
              ? 'audience'
              : 'primary';
      const identity = RatingIdentitySchema.safeParse({ providerId, kind });
      if (!identity.success) {
        return { error: 'Invalid Plex rating identity' };
      }
      const matching = detailed.filter(
        (candidate) =>
          candidate.providerId === providerId && candidate.kind === kind,
      );
      if (matching.length > 0) {
        // Full metadata wins over its potentially stale scalar aliases.
        continue;
      }
      const alias = field !== 'userRating' && !image && detailed.length > 0;
      candidates.push(entry(providerId, kind, value, image, alias, false));
    }

    const chosen = new Map<string, Candidate>();
    for (const candidate of candidates) {
      const key = `${candidate.providerId}\u0000${candidate.kind}`;
      const previous = chosen.get(key);
      if (previous && previous.value !== candidate.value) {
        return { error: 'Conflicting Plex ratings' };
      }
      if (!previous || (candidate.detailed && !previous.detailed)) {
        chosen.set(key, candidate);
      }
    }
    const snapshot: RatingSnapshot = {
      version: 1,
      observedAt,
      entries: [...chosen.values()].map(
        ({ detailed: _detailed, ...rating }) => rating,
      ),
    };
    return { snapshot };
  } catch {
    return { error: 'Invalid Plex rating data' };
  }
}

function parseValue(raw: number | string): number | undefined {
  if (typeof raw === 'string' && !/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 10
    ? value
    : undefined;
}

function providerFromImage(image: string): string {
  if (image.length > 2048) {
    throw new Error('Invalid source');
  }
  if (/^https?:\/\//i.test(image)) {
    try {
      return new URL(image).origin.toLowerCase();
    } catch {
      throw new Error('Invalid source');
    }
  }
  const scheme = image.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  const source = scheme ?? image.toLowerCase();
  if (source === 'tmdb' || source === 'themoviedb') return 'themoviedb';
  if (source === 'rottentomatoes') return source;
  return source;
}

function kindFromType(type: string): string {
  const normalized = type.toLowerCase();
  return normalized;
}

function kindFromScalar(
  field: string,
  provider: string,
  image: string,
): string {
  if (field === 'audienceRating') return 'audience';
  if (provider === 'imdb' || provider === 'themoviedb') return 'audience';
  if (provider === 'rottentomatoes') {
    const marker = image.slice(image.indexOf(':') + 1).toLowerCase();
    if (/upright|spilled/.test(marker)) return 'audience';
    if (/ripe|rotten|fresh/.test(marker)) return 'critic';
  }
  return 'primary';
}

function sanitizeRatingSource(source: string): string {
  try {
    const url = new URL(source);
    // Badges identify provenance, not a reason to persist credentials or
    // signed query strings from an untrusted metadata response.
    return `${url.protocol}${url.host ? `//${url.host}` : ''}${url.pathname}`;
  } catch {
    return source.split(/[?#]/, 1)[0] ?? '';
  }
}

function entry(
  providerId: string,
  kind: string,
  value: number,
  source: string | undefined,
  isAlias: boolean,
  detailed: boolean,
): Candidate {
  const validated = RatingIdentitySchema.parse({ providerId, kind });
  return {
    ...validated,
    value,
    scale: 10,
    score: value * 10,
    ...(source === undefined ? {} : { source: sanitizeRatingSource(source) }),
    ...(isAlias ? { isAlias: true } : {}),
    detailed,
  };
}
