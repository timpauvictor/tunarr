import z from 'zod';

export const RatingIdentitySchema = z.object({
  providerId: z
    .string()
    .min(1)
    .max(256)
    .refine(
      (value) =>
        Array.from(value).every(
          (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
        ),
      'Rating provider must not contain control characters',
    ),
  kind: z
    .string()
    .min(1)
    .max(64)
    .refine(
      (value) =>
        Array.from(value).every(
          (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
        ),
      'Rating type must not contain control characters',
    ),
});

export const RatingEntrySchema = RatingIdentitySchema.extend({
  value: z.number().min(0).max(10),
  scale: z.literal(10),
  score: z.number().min(0).max(100),
  source: z.string().max(2048).optional(),
  // An unattributed scalar can alias a detailed score. Keep it searchable,
  // but do not invent an additional independent vote in the composite.
  isAlias: z.boolean().optional(),
});

export const RatingSnapshotSchema = z.object({
  version: z.literal(1),
  observedAt: z.number().int().nonnegative(),
  entries: z.array(RatingEntrySchema),
});

export type RatingIdentity = z.infer<typeof RatingIdentitySchema>;
export type RatingEntry = z.infer<typeof RatingEntrySchema>;
export type RatingSnapshot = z.infer<typeof RatingSnapshotSchema>;

// This encoding is a persistent public search identifier. Keep it independent
// of any provider list and never use provider strings as index paths.
export function ratingFieldKey(providerId: string, kind: string): string {
  const identity = RatingIdentitySchema.parse({ providerId, kind });
  // URI encoding exposes UTF-8 bytes without Node or DOM dependencies.
  const encoded = encodeURIComponent(
    JSON.stringify([identity.providerId, identity.kind]),
  );
  let hex = '';
  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] === '%') {
      hex += encoded.slice(index + 1, index + 3).toLowerCase();
      index += 2;
    } else {
      hex += encoded.charCodeAt(index).toString(16).padStart(2, '0');
    }
  }
  return `score_v1_${hex}`;
}

export function parseRatingFieldKey(key: string): RatingIdentity | undefined {
  const prefix = 'score_v1_';
  if (!key.startsWith(prefix) || key.length > 4096) return;
  const hex = key.slice(prefix.length);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex))
    return;
  try {
    const encoded =
      hex
        .match(/.{2}/g)
        ?.map((byte) => `%${byte}`)
        .join('') ?? '';
    const tuple: unknown = JSON.parse(decodeURIComponent(encoded));
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 2 ||
      typeof tuple[0] !== 'string' ||
      typeof tuple[1] !== 'string'
    )
      return;
    const identity = RatingIdentitySchema.safeParse({
      providerId: tuple[0],
      kind: tuple[1],
    });
    if (
      !identity.success ||
      ratingFieldKey(identity.data.providerId, identity.data.kind) !== key
    )
      return;
    return identity.data;
  } catch {
    return;
  }
}

export const RatingFieldKeySchema = z
  .string()
  .max(4096)
  .regex(/^score_v1_(?:[0-9a-f]{2})+$/)
  .refine((key) => !!parseRatingFieldKey(key), 'Invalid rating field identity');
export const RatingFieldDescriptorSchema = RatingIdentitySchema.extend({
  key: RatingFieldKeySchema,
  label: z.string(),
  ready: z.boolean(),
});
export const RatingFieldsResponseSchema = z.object({
  fields: z.array(RatingFieldDescriptorSchema),
});
export type RatingFieldDescriptor = z.infer<typeof RatingFieldDescriptorSchema>;

export const PlexRatingsRefreshStatusSchema = z.object({
  jobId: z.uuid(),
  libraryId: z.uuid(),
  mediaSourceId: z.uuid(),
  state: z.enum([
    'queued',
    'in_progress',
    'completed',
    'partial',
    'cancelled',
    'failed',
  ]),
  cancelRequested: z.boolean(),
  total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  refreshed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  indexFailed: z.number().int().nonnegative(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  lastError: z
    .enum([
      'auth',
      'denied',
      'not_found',
      'timeout',
      'invalid_metadata',
      'source_changed',
      'identity_changed',
      'database',
      'index',
    ])
    .nullable(),
});
export type PlexRatingsRefreshStatus = z.infer<
  typeof PlexRatingsRefreshStatusSchema
>;
