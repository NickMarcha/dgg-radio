import MediaPlayer from './MediaPlayer';
import { useRoomSnapshot } from './useRoomSnapshot';
import './EmbedView.css';

interface EmbedViewProps {
  apiUrl: string;
  mode: 'player' | 'playing';
}

export default function EmbedView({ apiUrl, mode }: EmbedViewProps) {
  const { room } = useRoomSnapshot(apiUrl);
  const current = room?.current ?? null;

  if (mode === 'player') {
    return (
      <main className="embed-root embed-player-root">
        <MediaPlayer current={current} serverTime={room?.serverTime ?? null} embedded />
      </main>
    );
  }

  if (!current) return <main className="embed-root" aria-label="Nothing playing" />;

  return (
    <main className="embed-root embed-playing-root" aria-live="polite">
      {current.media.thumbnailUrl && (
        <img className="embed-playing-art" src={current.media.thumbnailUrl} alt="" />
      )}
      <div className="embed-playing-copy">
        <strong>{current.media.title}</strong>
        <span>{current.media.artist}</span>
      </div>
    </main>
  );
}
