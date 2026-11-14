import type { HlsConfig } from 'hls.js';
import Hls from 'hls.js';
import { useCallback, useEffect, useRef, useState } from 'react';

export const useHls = (userConfig?: Partial<HlsConfig>) => {
  const playerRef = useRef<Hls | null>(null);
  const mountedRef = useRef(false);
  const [fatalError, setFatalError] = useState(false);

  const destroyPlayer = useCallback(() => {
    const player = playerRef.current;
    playerRef.current = null;
    player?.destroy();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      destroyPlayer();
    };
  }, [destroyPlayer]);

  const disposeHls = useCallback(() => {
    destroyPlayer();
    setFatalError(false);
  }, [destroyPlayer]);

  const resetHls = useCallback(() => {
    // A late diagnostic response must not acquire a new player after unmount.
    if (!mountedRef.current) return;
    disposeHls();
    if (!Hls.isSupported()) return;

    const player = new Hls({
      progressive: true,
      fragLoadingTimeOut: 30000,
      manifestLoadPolicy: {
        default: {
          ...Hls.DefaultConfig.manifestLoadPolicy.default,
          // The server permits 45s for preparation, renewal and initial segments.
          maxLoadTimeMs: 60000,
        },
      },
      initialLiveManifestSize: 3, // About 10 seconds of playback needed before playing
      enableWorker: true,
      lowLatencyMode: true,
      xhrSetup: (xhr) => {
        xhr.setRequestHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Accept, X-Requested-With',
        );
        xhr.setRequestHeader(
          'Access-Control-Allow-Origin',
          'http://localhost:5173',
        );
      },
      debug: import.meta.env.DEV,
      ...(userConfig ?? {}),
    });
    playerRef.current = player;

    player.on(Hls.Events.ERROR, (_, data) => {
      // HLS owns nonfatal recovery. A terminal error needs an explicit retry,
      // and an old player's late event must not stop its replacement.
      if (playerRef.current !== player || !data.fatal) return;
      destroyPlayer();
      setFatalError(true);
    });

    return player;
  }, [userConfig, disposeHls, destroyPlayer]);

  return { resetHls, disposeHls, fatalError };
};
