import { Trans } from '@lingui/react/macro';
import { Route } from '@/routes/channels_/$channelId/watch.tsx';
import { PlayArrow, Replay } from '@mui/icons-material';
import { Alert, Box } from '@mui/material';
import Button from '@mui/material/Button';
import Hls from 'hls.js';
import { useEffect, useRef, useState } from 'react';
import { useChannelTranscodeConfig } from '../hooks/settingsHooks.ts';
import { useHls } from '../hooks/useHls.ts';
import { useSettings } from '../store/settings/selectors.ts';

type VideoProps = {
  channelId: string;
};

export default function Video({ channelId }: VideoProps) {
  // Manual-start intent and the player belong to this channel, not the route's
  // next channel when React reuses the same Video component.
  return <ChannelVideo key={channelId} channelId={channelId} />;
}

function ChannelVideo({ channelId }: VideoProps) {
  const { backendUri } = useSettings();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { resetHls, disposeHls, fatalError } = useHls();
  const hlsSupported = Hls.isSupported();
  const { data: transcodeConfig } = useChannelTranscodeConfig(channelId);
  const { noAutoPlay } = Route.useSearch();
  const [playbackRequest, setPlaybackRequest] = useState(0);
  const requested = !noAutoPlay || playbackRequest > 0;
  const shouldPlay =
    requested &&
    hlsSupported &&
    !!transcodeConfig &&
    transcodeConfig.audioFormat !== 'ac3';

  useEffect(() => {
    const video = videoRef.current;
    if (!shouldPlay || !video) return;
    const player = resetHls();
    if (!player) return;
    player.loadSource(`${backendUri}/stream/channels/${channelId}.m3u8`);
    player.attachMedia(video);
    return () => {
      video.pause();
      disposeHls();
    };
  }, [
    shouldPlay,
    resetHls,
    disposeHls,
    backendUri,
    channelId,
    playbackRequest,
  ]);

  if (!hlsSupported) {
    return (
      <Alert severity="error" sx={{ my: 2 }}>
        <Trans>HLS not supported in this browser!</Trans>
      </Alert>
    );
  }

  if (transcodeConfig?.audioFormat === 'ac3') {
    return (
      <Alert severity="warning" sx={{ my: 2 }}>
        <Trans>
          Tunarr is currently configured to use the AC3 audio encoder. This
          audio format is not supported by browsers. The resultant stream will
          likely not have audio or will not play at all.
        </Trans>
      </Alert>
    );
  }

  return (
    <Box sx={{ mb: 2 }}>
      {fatalError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <Trans>Stream playback failed. Reload the stream to try again.</Trans>
        </Alert>
      )}
      <Box sx={{ width: '100%' }}>
        <video
          style={{ width: '100%' }}
          controls
          autoPlay={shouldPlay}
          ref={videoRef}
        />
      </Box>
      <Button
        variant="contained"
        onClick={() => setPlaybackRequest((request) => request + 1)}
        startIcon={shouldPlay ? <Replay /> : <PlayArrow />}
      >
        {shouldPlay ? <Trans>Reload Stream</Trans> : <Trans>Load Stream</Trans>}
      </Button>
    </Box>
  );
}
