import { useLingui } from '@lingui/react/macro';
import { Stack, Tooltip, Typography } from '@mui/material';
import {
  calculateOmnirating,
  ratingFieldKey,
  ratingFieldLabel,
} from '@tunarr/shared/util';
import type { ProgramOrFolder } from '@tunarr/types';
import type { RatingEntry } from '@tunarr/types/schemas';

export function ProgramRatings({ program }: { program: ProgramOrFolder }) {
  const { t } = useLingui();
  if (program.sourceType !== 'plex' || !('ratings' in program)) return null;
  const snapshot = program.ratings;
  const value = calculateOmnirating(snapshot);
  const unique = new Map<string, RatingEntry>();
  for (const entry of snapshot?.entries ?? []) {
    const key = ratingFieldKey(entry.providerId, entry.kind);
    if (!unique.has(key)) unique.set(key, entry);
  }
  const entries = [...unique.values()];
  const contributions = entries.filter(
    (entry) => entry.kind !== 'personal' && !entry.isAlias,
  ).length;
  return (
    <Tooltip
      title={
        <Stack gap={0.5}>
          <Typography variant="caption">{t`Omnirating is the equal average of available public scores, normalized to 0-100. Critics and audience count separately; personal stars do not count.`}</Typography>
          <Typography variant="caption">{t`Contributing scores: ${contributions}`}</Typography>
          {entries.map((entry) => (
            <Typography
              key={ratingFieldKey(entry.providerId, entry.kind)}
              variant="caption"
            >
              {entry.kind === 'personal'
                ? t`Personal: ${entry.value / 2}/5 stars (${entry.value}/10), excluded from Omnirating.`
                : `${ratingFieldLabel(entry)}: ${entry.value}/10 (${entry.score}/100)${entry.isAlias ? ` - ${t`Possible scalar alias; excluded from Omnirating.`}` : ''}`}
            </Typography>
          ))}
          {snapshot && (
            <Typography variant="caption">{t`Last fetched: ${new Date(snapshot.observedAt).toLocaleString()}`}</Typography>
          )}
          {!snapshot && (
            <Typography variant="caption">{t`Ratings have not been refreshed yet.`}</Typography>
          )}
          {snapshot && entries.length === 0 && (
            <Typography variant="caption">{t`Plex supplied no scores for this item.`}</Typography>
          )}
        </Stack>
      }
    >
      <Typography
        component="span"
        variant="caption"
        tabIndex={0}
        sx={{ display: 'block', cursor: 'help' }}
      >
        {t`Omnirating`}:{' '}
        {value === null ? t`Unknown` : `${value.toFixed(2)}/100`}
      </Typography>
    </Tooltip>
  );
}
