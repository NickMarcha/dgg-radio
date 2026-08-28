import { AlertTriangle, Pause, Play, Volume2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { captureClientEvent, captureClientException } from '../client/analytics';
import type { QueueItem } from '../shared/contracts';

interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  setVolume(volume: number): void;
  destroy(): void;
}

interface YouTubePlayerEvent {
  target: YouTubePlayer;
  data?: number;
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        element: HTMLElement,
        options: {
          videoId: string;
          playerVars: Record<string, number | string>;
          events: {
            onReady: (event: YouTubePlayerEvent) => void;
            onError: (event: YouTubePlayerEvent) => void;
          };
        },
      ) => YouTubePlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface PlaybackController {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  position(): Promise<number>;
  setVolume(volume: number): void;
  destroy(): void;
}

let youtubeApiPromise: Promise<void> | undefined;
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  youtubeApiPromise ??= new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => reject(new Error('YouTube player failed to load.'));
    document.head.append(script);
  });
  return youtubeApiPromise;
}

let soundCloudApiPromise: Promise<void> | undefined;
function loadSoundCloudApi(): Promise<void> {
  if (window.SC?.Widget) return Promise.resolve();
  soundCloudApiPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://w.soundcloud.com/player/api.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('SoundCloud player failed to load.'));
    document.head.append(script);
  });
  return soundCloudApiPromise;
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

interface MediaPlayerProps {
  current: QueueItem | null;
  serverTime: string | null;
}

export default function MediaPlayer({ current, serverTime }: MediaPlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<PlaybackController | null>(null);
  const [listening, setListening] = useState(false);
  const [volume, setVolume] = useState(80);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [playerError, setPlayerError] = useState<string | null>(null);

  const serverOffset = useMemo(
    () => (serverTime ? new Date(serverTime).getTime() - Date.now() : 0),
    [serverTime],
  );

  const desiredPosition = () => {
    if (!current?.startedAt) return 0;
    return Math.max(0, (Date.now() + serverOffset - new Date(current.startedAt).getTime()) / 1_000);
  };

  const reportPlayerError = (message: string, errorCode?: number) => {
    setPlayerError(message);
    captureClientException(new Error(message), {
      area: 'media_player',
      provider: current?.media.provider,
      error_code: errorCode,
    });
  };

  const toggleListening = () => {
    setListening((value) => {
      const next = !value;
      if (next && current) {
        captureClientEvent('listening_started', { provider: current.media.provider });
      }
      return next;
    });
  };

  useEffect(() => {
    const timer = window.setInterval(() => setElapsedSeconds(desiredPosition()), 500);
    setElapsedSeconds(desiredPosition());
    return () => window.clearInterval(timer);
  }, [current?.id, current?.startedAt, serverOffset]);

  useEffect(() => {
    controllerRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !current || !listening) return;
    let cancelled = false;
    let syncTimer: number | undefined;
    setPlayerError(null);

    const sync = async () => {
      const controller = controllerRef.current;
      if (!controller) return;
      const desired = desiredPosition();
      const actual = await controller.position();
      if (Math.abs(desired - actual) > 2.5) controller.seek(desired);
    };

    const createPlayer = async () => {
      try {
        if (current.media.provider === 'youtube') {
          await loadYouTubeApi();
          if (cancelled || !window.YT) return;
          const target = document.createElement('div');
          mount.replaceChildren(target);
          const player = new window.YT.Player(target, {
            videoId: current.media.providerMediaId,
            playerVars: {
              autoplay: 1,
              controls: 0,
              disablekb: 1,
              playsinline: 1,
              rel: 0,
              origin: window.location.origin,
            },
            events: {
              onReady: ({ target: readyPlayer }) => {
                readyPlayer.setVolume(volume);
                readyPlayer.seekTo(desiredPosition(), true);
                readyPlayer.playVideo();
              },
              onError: ({ data }) => {
                reportPlayerError(`YouTube playback failed${data ? ` with error ${data}` : ''}.`, data);
              },
            },
          });
          controllerRef.current = {
            play: () => player.playVideo(),
            pause: () => player.pauseVideo(),
            seek: (seconds) => player.seekTo(seconds, true),
            position: async () => player.getCurrentTime() || 0,
            setVolume: (nextVolume) => player.setVolume(nextVolume),
            destroy: () => player.destroy(),
          };
        } else {
          await loadSoundCloudApi();
          if (cancelled || !window.SC) return;
          const iframe = document.createElement('iframe');
          iframe.title = `SoundCloud player for ${current.media.title}`;
          iframe.allow = 'autoplay';
          iframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(current.media.canonicalUrl)}&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&visual=true`;
          mount.replaceChildren(iframe);
          const widget = window.SC.Widget(iframe);
          const events = window.SC.Widget.Events;
          widget.bind(events.READY, () => {
            widget.setVolume(volume);
            widget.seekTo(desiredPosition() * 1_000);
            widget.play();
          });
          widget.bind(events.ERROR, () => reportPlayerError('SoundCloud playback failed.'));
          controllerRef.current = {
            play: () => widget.play(),
            pause: () => widget.pause(),
            seek: (seconds) => widget.seekTo(seconds * 1_000),
            position: () =>
              new Promise((resolve) => widget.getPosition((milliseconds) => resolve(milliseconds / 1_000))),
            setVolume: (nextVolume) => widget.setVolume(nextVolume),
            destroy: () => {
              widget.unbind(events.READY);
              widget.unbind(events.ERROR);
              iframe.remove();
            },
          };
        }
        syncTimer = window.setInterval(() => void sync(), 10_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The player failed to load.';
        reportPlayerError(message);
      }
    };

    void createPlayer();
    return () => {
      cancelled = true;
      if (syncTimer) window.clearInterval(syncTimer);
      controllerRef.current?.destroy();
      controllerRef.current = null;
      mount.replaceChildren();
    };
  }, [current?.id, listening]);

  const duration = current?.media.durationSeconds ?? 0;
  const progress = duration > 0 ? Math.min(100, (elapsedSeconds / duration) * 100) : 0;

  return (
    <section className="player-panel" aria-label="Now playing">
      <div
        className="player-stage"
        style={current?.media.thumbnailUrl ? { backgroundImage: `url(${current.media.thumbnailUrl})` } : undefined}
      >
        <div ref={mountRef} className="player-embed" aria-hidden={!listening} />
        {!current && <div className="player-empty">The room is quiet. Add the first track.</div>}
        {current && !listening && (
          <button className="listen-button" type="button" onClick={toggleListening}>
            <Play size={20} fill="currentColor" />
            Start listening
          </button>
        )}
      </div>

      <div className="player-info">
        <div className="track-copy">
          <strong>{current?.media.title ?? 'Nothing playing'}</strong>
          <span>
            {current
              ? `${current.media.artist} · ${current.requestedBy ? `requested by ${current.requestedBy.username}` : 'requester hidden until the track ends'}`
              : 'Queue a YouTube or SoundCloud link'}
          </span>
        </div>
        <div className="playback-controls">
          {current && (
            <button
              className="icon-button"
              type="button"
              aria-label={listening ? 'Stop listening' : 'Start listening'}
              onClick={toggleListening}
            >
              {listening ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
            </button>
          )}
          <Volume2 size={17} aria-hidden="true" />
          <input
            className="volume"
            type="range"
            min="0"
            max="100"
            value={volume}
            aria-label="Volume"
            onChange={(event) => setVolume(Number(event.target.value))}
          />
        </div>
      </div>

      <div className="progress-track" aria-hidden="true">
        <div style={{ width: `${progress}%` }} />
      </div>
      <div className="time-row">
        <span>{formatTime(Math.min(elapsedSeconds, duration))}</span>
        <span>{formatTime(duration)}</span>
      </div>
      {playerError && (
        <p className="player-error" role="alert">
          <AlertTriangle size={16} /> {playerError} A moderator can skip the track if the error persists.
        </p>
      )}
    </section>
  );
}
