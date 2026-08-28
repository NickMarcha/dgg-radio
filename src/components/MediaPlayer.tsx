import { AlertTriangle, Pause, Play, Volume2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MediaProvider, QueueItem } from '../shared/contracts';

interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getIframe(): HTMLIFrameElement;
  setVolume(volume: number): void;
  unMute(): void;
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
            onAutoplayBlocked?: () => void;
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
  embedded?: boolean;
  onListeningStarted?: (provider: MediaProvider) => void;
  onPlayerError?: (message: string, provider: MediaProvider | undefined, errorCode?: number) => void;
}

const PLAYER_STATE_KEY = 'dgg-radio.player';

/** How long to give a restored player to actually start before giving up on it. */
const AUTOPLAY_GRACE_MS = 3_000;

interface StoredPlayerState {
  listening: boolean;
  volume: number;
}

/**
 * Playback preferences are per listener, not part of the room, so they live in
 * this browser. Reads and writes are guarded: a private window or blocked site
 * data throws, and the player has to work anyway.
 */
function readPlayerState(): StoredPlayerState | null {
  try {
    const raw = window.localStorage.getItem(PLAYER_STATE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { listening, volume } = parsed as Partial<StoredPlayerState>;
    if (typeof volume !== 'number' || Number.isNaN(volume)) return null;
    return { listening: listening === true, volume: Math.min(100, Math.max(0, volume)) };
  } catch {
    return null;
  }
}

function writePlayerState(state: StoredPlayerState): void {
  try {
    window.localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify(state));
  } catch {
    // Preferences simply do not persist here.
  }
}

export default function MediaPlayer({
  current,
  serverTime,
  embedded = false,
  onListeningStarted,
  onPlayerError,
}: MediaPlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<PlaybackController | null>(null);
  const [listening, setListening] = useState(embedded);
  const [volume, setVolume] = useState(embedded ? 100 : 80);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [playerError, setPlayerError] = useState<string | null>(null);
  /** Set when listening resumed from storage rather than from a click. */
  const restoredWithoutGesture = useRef(false);
  const skipFirstWrite = useRef(true);

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
    onPlayerError?.(message, current?.media.provider, errorCode);
  };

  const toggleListening = () => {
    restoredWithoutGesture.current = false;
    setListening((value) => {
      const next = !value;
      if (next && current) {
        onListeningStarted?.(current.media.provider);
      }
      return next;
    });
  };

  // Restore after mount rather than in the initial state, so the server-rendered
  // markup and the first client render agree.
  useEffect(() => {
    if (embedded) return;
    const stored = readPlayerState();
    if (!stored) return;
    setVolume(stored.volume);
    if (stored.listening) {
      restoredWithoutGesture.current = true;
      setListening(true);
    }
  }, [embedded]);

  useEffect(() => {
    if (embedded) return;
    if (skipFirstWrite.current) {
      skipFirstWrite.current = false;
      return;
    }
    writePlayerState({ listening, volume });
  }, [embedded, listening, volume]);

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
      if (embedded) controller.play();
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
                readyPlayer.getIframe().allow = 'autoplay; encrypted-media';
                readyPlayer.setVolume(volume);
                readyPlayer.unMute();
                readyPlayer.seekTo(desiredPosition(), true);
                readyPlayer.playVideo();
              },
              onError: ({ data }) => {
                reportPlayerError(`YouTube playback failed${data ? ` with error ${data}` : ''}.`, data);
              },
              onAutoplayBlocked: () => {
                reportPlayerError('YouTube blocked automatic playback.');
              },
            },
          });
          controllerRef.current = {
            play: () => player.playVideo(),
            pause: () => player.pauseVideo(),
            seek: (seconds) => player.seekTo(seconds, true),
            position: async () =>
              typeof player.getCurrentTime === 'function' ? player.getCurrentTime() || 0 : 0,
            setVolume: (nextVolume) => player.setVolume(nextVolume),
            destroy: () => player.destroy(),
          };
        } else {
          await loadSoundCloudApi();
          if (cancelled || !window.SC) return;
          const iframe = document.createElement('iframe');
          iframe.title = `SoundCloud player for ${current.media.title}`;
          iframe.allow = 'autoplay';
          iframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(current.media.canonicalUrl)}&auto_play=${embedded}&hide_related=true&show_comments=false&show_user=true&show_reposts=false&visual=true`;
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

        // A refresh carries no user gesture, so the browser may refuse to start
        // audio. If the position has not moved, fall back to the paused state
        // rather than showing a playing indicator over silence.
        if (restoredWithoutGesture.current) {
          restoredWithoutGesture.current = false;
          try {
            const before = (await controllerRef.current?.position()) ?? 0;
            await new Promise((resolve) => window.setTimeout(resolve, AUTOPLAY_GRACE_MS));
            const after = (await controllerRef.current?.position()) ?? 0;
            if (!cancelled && after <= before) setListening(false);
          } catch {
            // Could not tell. Leave playback alone rather than interrupting it.
          }
        }
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
  }, [current?.id, embedded, listening]);

  const duration = current?.media.durationSeconds ?? 0;
  const progress = duration > 0 ? Math.min(100, (elapsedSeconds / duration) * 100) : 0;

  if (embedded) {
    const provider = current?.media.provider ?? 'empty';
    return (
      <section className={`embed-media embed-media-${provider}`} aria-label="Synchronized player">
        <div
          className="embed-media-stage"
          style={current?.media.thumbnailUrl ? { backgroundImage: `url(${current.media.thumbnailUrl})` } : undefined}
        >
          <div ref={mountRef} className="embed-media-provider" />
        </div>
      </section>
    );
  }

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
