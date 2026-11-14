import { Trans, useLingui } from '@lingui/react/macro';
import { ImageNotSupported } from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Link as MuiLink,
  Pagination,
  Stack,
  Typography,
} from '@mui/material';
import type { Ref } from 'react';
import type { YouTubeImportReviewModel } from '../../hooks/media-sources/useYouTubeImport.ts';
import { useGetArtworkUrl } from '../../hooks/useThumbnailUrl.ts';
import { Segmented } from '../ui/Segmented.tsx';

type SelectionActions = {
  toggle: (id: string, checked: boolean) => void;
  selectAll: () => void;
  clear: () => void;
  confirmPartial: (confirmed: boolean) => void;
};
type Props = {
  review: YouTubeImportReviewModel;
  selection?: SelectionActions;
  statusRef: Ref<HTMLDivElement>;
  onPageChange: (page: number) => void;
  view: 'list' | 'grid';
  onViewChange: (view: 'list' | 'grid') => void;
  failedArtwork: ReadonlySet<string>;
  onArtworkFailure: (url: string) => void;
};

export function YouTubeImportReview({
  review,
  selection,
  statusRef,
  onPageChange,
  view,
  onViewChange,
  failedArtwork,
  onArtworkFailure,
}: Props) {
  const { t } = useLingui();
  const getArtworkUrl = useGetArtworkUrl();
  const {
    result,
    rows,
    available,
    pendingCount,
    unavailableCount,
    requiresConfirmation,
    partialConfirmed,
    page,
  } = review;
  return (
    <>
      {result.imports.map((input) => (
        <Box key={input.inputIndex}>
          <Typography variant="h6">
            {input.kind === 'video' ? t`Video import` : input.title}
          </Typography>
          {input.message && (
            <Alert severity={input.status === 'failed' ? 'error' : 'warning'}>
              {input.status === 'failed' ? (
                <Trans>
                  Import failed. Retry when the source is available.
                </Trans>
              ) : input.status === 'duplicate' ? (
                <Trans>Repeated input was not imported twice.</Trans>
              ) : (
                <Trans>Import details</Trans>
              )}
              <Typography variant="body2">{input.message}</Typography>
            </Alert>
          )}
          {input.changes && (
            <Typography>
              <Trans>
                Added: {input.changes.added}; removed: {input.changes.removed}
              </Trans>
            </Typography>
          )}
        </Box>
      ))}
      <Typography component="div" role="status" ref={statusRef} tabIndex={-1}>
        <Trans>
          Eligible: {available.length}; pending: {pendingCount}; unavailable:{' '}
          {unavailableCount}
        </Trans>
      </Typography>
      {!rows.length && (
        <Alert severity="info">
          <Trans>No entries to add. Saved programming was not changed.</Trans>
        </Alert>
      )}
      {selection && (
        <Stack direction="row" spacing={1}>
          <Button onClick={selection.selectAll}>
            <Trans>Select all eligible</Trans>
          </Button>
          <Button onClick={selection.clear}>
            <Trans>Clear selection</Trans>
          </Button>
        </Stack>
      )}
      <Segmented
        value={view}
        onChange={onViewChange}
        aria-label={t`Collection view`}
        options={[
          { value: 'list', label: t`List` },
          { value: 'grid', label: t`Grid` },
        ]}
      />
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns:
            view === 'grid'
              ? { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }
              : '1fr',
          gap: 2,
        }}
      >
        {rows.slice((page - 1) * 50, page * 50).map((row) => {
          const { entry, selected, selectable } = row;
          const program = entry.program?.program;
          const artwork = program
            ? getArtworkUrl(program, ['thumbnail', 'poster'])
            : null;
          return (
            <Stack
              key={entry.id}
              spacing={1}
              sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}
            >
              {selection && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={selected}
                      disabled={!selectable}
                      onChange={(_, checked) =>
                        selection.toggle(entry.id, checked)
                      }
                    />
                  }
                  label={t`Select occurrence ${row.ordinal}`}
                />
              )}
              {artwork && !failedArtwork.has(artwork) ? (
                <Box
                  component="img"
                  src={artwork}
                  alt={program?.title ?? ''}
                  onError={() => onArtworkFailure(artwork)}
                  sx={{ maxWidth: '100%', height: 100, objectFit: 'contain' }}
                />
              ) : (
                <ImageNotSupported aria-label={t`No artwork available`} />
              )}
              <Typography variant="subtitle1">
                {program?.title ?? entry.videoId ?? t`Unavailable entry`}
              </Typography>
              {program?.type === 'other_video' &&
                program.youtubeMetadata?.creatorName && (
                  <Typography>{program.youtubeMetadata.creatorName}</Typography>
                )}
              {entry.program && (
                <Typography>
                  <Trans>
                    Duration: {Math.floor(entry.program.duration / 60000)} min{' '}
                    {Math.floor((entry.program.duration % 60000) / 1000)} sec
                  </Trans>
                </Typography>
              )}
              {program && 'summary' in program && program.summary && (
                <Typography variant="body2">{program.summary}</Typography>
              )}
              {entry.videoId && (
                <MuiLink
                  href={`https://www.youtube.com/watch?v=${encodeURIComponent(entry.videoId)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Trans>Open video on YouTube</Trans>
                </MuiLink>
              )}
              {entry.status !== 'available' && (
                <Alert severity="warning">
                  {entry.status === 'pending' ? (
                    <Trans>Pending metadata</Trans>
                  ) : (
                    <Trans>Unavailable</Trans>
                  )}
                  {entry.message && (
                    <Typography variant="body2">{entry.message}</Typography>
                  )}
                </Alert>
              )}
            </Stack>
          );
        })}
      </Box>
      {rows.length > 50 && (
        <Pagination
          count={Math.ceil(rows.length / 50)}
          page={page}
          onChange={(_, value) => onPageChange(value)}
          aria-label={t`Collection pages`}
        />
      )}
      {result.imports.some((input) => input.status === 'complete') ? (
        <Alert severity="success">
          <Trans>
            Imported into the library. Playback has not been verified.
          </Trans>
        </Alert>
      ) : (
        <Alert severity="info">
          <Trans>
            No new metadata was imported. Saved programming was not changed.
          </Trans>
        </Alert>
      )}
      <Alert severity="info">
        <Trans>
          Separate audio/video inputs require transcoding. ErsatzTV playback
          requires dynamic playout; static windows are not supported. Change
          incompatible profiles explicitly. Normal channels advance while
          unwatched; pause-on-idle is a separate channel setting.
        </Trans>
      </Alert>
      {selection && (
        <Typography variant="body2">
          <Trans>
            Add to the current draft, then use normal Save to persist
            programming.
          </Trans>
        </Typography>
      )}
      {selection && requiresConfirmation && (
        <FormControlLabel
          control={
            <Checkbox
              checked={partialConfirmed}
              onChange={(_, checked) => selection.confirmPartial(checked)}
            />
          }
          label={t`I understand that excluded entries will not be added`}
        />
      )}
    </>
  );
}
