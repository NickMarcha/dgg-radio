import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { QueueItem } from '../shared/contracts';
import MediaPlayer from './MediaPlayer';
import { useRoomSnapshot } from './useRoomSnapshot';
import './EmbedView.css';

interface EmbedViewProps {
  apiUrl: string;
  mode: 'player' | 'playing' | 'queue';
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function useElapsedSeconds(current: QueueItem | null, serverTime: string | null): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!current?.startedAt) {
      setElapsedSeconds(0);
      return;
    }
    const serverOffset = serverTime ? new Date(serverTime).getTime() - Date.now() : 0;
    const startedAt = new Date(current.startedAt).getTime();
    const update = () => {
      const elapsed = (Date.now() + serverOffset - startedAt) / 1_000;
      setElapsedSeconds(Math.min(current.media.durationSeconds, Math.max(0, elapsed)));
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [current?.id, current?.startedAt, current?.media.durationSeconds, serverTime]);

  return elapsedSeconds;
}

function ScrollingTitle({ children }: { children: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLElement>(null);
  const [scrolling, setScrolling] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;
    const measure = () => setScrolling(text.scrollWidth > container.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(text);
    return () => observer.disconnect();
  }, [children]);

  const style = {
    '--embed-scroll-duration': `${Math.max(14, children.length * 0.25)}s`,
  } as CSSProperties;

  return (
    <div ref={containerRef} className="embed-playing-title">
      <div className={`embed-title-track${scrolling ? ' embed-title-track-scrolling' : ''}`} style={style}>
        <strong ref={textRef}>{children}</strong>
        {scrolling && <strong aria-hidden="true">{children}</strong>}
      </div>
    </div>
  );
}

function QueueEmbed({ queue }: { queue: QueueItem[] }) {
  return (
    <main className="embed-root embed-queue-root" aria-label="Upcoming queue">
      <ol className="embed-queue-list">
        {queue.map((item, index) => (
          <li className="embed-queue-item" key={item.id}>
            <span className="embed-queue-position">{index + 1}</span>
            {item.media.thumbnailUrl ? (
              <img className="embed-queue-art" src={item.media.thumbnailUrl} alt="" />
            ) : (
              <span className="embed-queue-art embed-queue-art-empty" aria-hidden="true" />
            )}
            <div className="embed-queue-copy">
              <strong>{item.media.title}</strong>
              <span>{item.media.artist} · {formatTime(item.media.durationSeconds)}</span>
              <span>{item.requestedBy ? `Requested by ${item.requestedBy.username}` : 'Requester hidden'}</span>
            </div>
          </li>
        ))}
      </ol>
    </main>
  );
}

function PlayingEmbed({ current, serverTime }: { current: QueueItem | null; serverTime: string | null }) {
  const elapsedSeconds = useElapsedSeconds(current, serverTime);

  if (!current) return <main className="embed-root" aria-label="Nothing playing" />;

  return (
    <main className="embed-root embed-playing-root" aria-live="polite">
      {current.media.thumbnailUrl && (
        <img className="embed-playing-art" src={current.media.thumbnailUrl} alt="" />
      )}
      <div className="embed-playing-copy">
        <ScrollingTitle>{current.media.title}</ScrollingTitle>
        <span className="embed-playing-artist">{current.media.artist}</span>
        <span className="embed-playing-meta">
          {current.requestedBy ? `Requested by ${current.requestedBy.username}` : 'Requester hidden'}
          {' · '}▲ {current.upvotes} · ▼ {current.downvotes}
        </span>
        <time>{formatTime(elapsedSeconds)} / {formatTime(current.media.durationSeconds)}</time>
      </div>
    </main>
  );
}

/**
 * A stream overlay wants the video, not YouTube's subtitles, so the player
 * embed hides them unless the URL asks for them back. Read from the live URL
 * rather than the route, because these pages are prerendered and a query string
 * only exists in the browser.
 */
function captionsRequested(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('captions') === 'on';
}

export default function EmbedView({ apiUrl, mode }: EmbedViewProps) {
  const { room } = useRoomSnapshot(apiUrl);
  const current = room?.current ?? null;

  if (mode === 'player') {
    return (
      <main className="embed-root embed-player-root">
        <MediaPlayer
          current={current}
          serverTime={room?.serverTime ?? null}
          embedded
          captions={captionsRequested()}
        />
      </main>
    );
  }

  if (mode === 'queue') return <QueueEmbed queue={room?.queue ?? []} />;

  return <PlayingEmbed current={current} serverTime={room?.serverTime ?? null} />;
}
