import { useLingui } from '@lingui/react/macro';
import { MenuItem, Stack, TextField, Typography } from '@mui/material';
import { parseRatingFieldKey, ratingFieldLabel } from '@tunarr/shared/util';
import { useRatingFields } from '../../hooks/useRatingFields.ts';
import useStore from '../../store/index.ts';
import { setSearchSort } from '../../store/programmingSelector/actions.ts';

export function RatingSortControl() {
  const { t } = useLingui();
  const ratings = useRatingFields();
  const selected = useStore((state) => state.currentSearchRequest?.sort?.[0]);
  const key = selected?.field ?? '';
  const identity = parseRatingFieldKey(key);
  const fields = [...(ratings.data?.fields ?? [])];
  if (identity && !fields.some((field) => field.key === key)) {
    fields.push({
      ...identity,
      key,
      label: ratingFieldLabel(identity),
      ready: false,
    });
  }
  return (
    <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
      <TextField
        select
        size="small"
        label={t`Sort by`}
        value={key}
        sx={{ minWidth: 210 }}
        onChange={(event) =>
          setSearchSort(
            event.target.value
              ? [
                  {
                    field: event.target.value,
                    direction: selected?.direction ?? 'desc',
                  },
                ]
              : undefined,
          )
        }
      >
        <MenuItem value="">{t`Default order`}</MenuItem>
        <MenuItem value="omnirating">{t`Omnirating (0-100)`}</MenuItem>
        {fields.map((field) => (
          <MenuItem key={field.key} value={field.key} disabled={!field.ready}>
            {field.label} (0-100)
          </MenuItem>
        ))}
        {key && key !== 'omnirating' && !identity && (
          <MenuItem value={key}>{key}</MenuItem>
        )}
      </TextField>
      <TextField
        select
        size="small"
        label={t`Direction`}
        value={selected?.direction ?? 'desc'}
        disabled={!key}
        onChange={(event) => {
          const direction = event.target.value;
          if (key && (direction === 'asc' || direction === 'desc'))
            setSearchSort([{ field: key, direction }]);
        }}
      >
        <MenuItem value="desc">{t`Highest first`}</MenuItem>
        <MenuItem value="asc">{t`Lowest first`}</MenuItem>
      </TextField>
      {ratings.isError && (
        <Typography
          color="error"
          variant="caption"
        >{t`Could not load Plex rating fields.`}</Typography>
      )}
    </Stack>
  );
}
