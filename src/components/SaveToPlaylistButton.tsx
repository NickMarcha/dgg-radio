import { Heart, Plus, X } from 'lucide-react';
import { useId, useState, type SubmitEvent } from 'react';
import type { RoomMedia } from '../shared/contracts';
import type { PlaylistLibraryController } from './usePlaylistLibrary';
import './SaveToPlaylistButton.css';

interface SaveToPlaylistButtonProps {
  media: RoomMedia;
  library: PlaylistLibraryController;
  compact?: boolean;
  onChanged?: () => void | Promise<void>;
}

export default function SaveToPlaylistButton({
  media,
  library,
  compact = false,
  onChanged,
}: SaveToPlaylistButtonProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const newPlaylistId = useId();
  const memberships = library.memberships[media.id] ?? [];
  const saved = memberships.length > 0;

  async function toggle(playlistId: string, checked: boolean) {
    setNotice(null);
    try {
      await library.setMembership(playlistId, media.id, checked);
      await onChanged?.();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'The track could not be saved.');
    }
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setNotice(null);
    try {
      await library.create(trimmed, media.id);
      await onChanged?.();
      setName('');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'The playlist could not be created.');
    }
  }

  return (
    <>
      <button
        type="button"
        className={`save-playlist-button${saved ? ' is-saved' : ''}${compact ? ' is-compact' : ''}`}
        aria-label={`Save ${media.title} to a playlist`}
        title="Save to playlist"
        onClick={() => setOpen(true)}
      >
        <Heart size={compact ? 15 : 17} fill={saved ? 'currentColor' : 'none'} />
        {!compact && <span>Save</span>}
      </button>

      {open && (
        <div className="playlist-dialog-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <section
            className="playlist-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Save ${media.title} to a playlist`}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2>Save to playlist</h2>
                <p>{media.title}</p>
              </div>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)}>
                <X size={17} />
              </button>
            </header>

            <div className="playlist-dialog-list">
              {library.loading ? (
                <p>Loading playlists...</p>
              ) : library.playlists.length === 0 ? (
                <p>You have no playlists yet.</p>
              ) : (
                library.playlists.map((playlist) => (
                  <label key={playlist.id}>
                    <input
                      type="checkbox"
                      checked={memberships.includes(playlist.id)}
                      disabled={library.busy}
                      onChange={(event) => void toggle(playlist.id, event.currentTarget.checked)}
                    />
                    <span>{playlist.name}</span>
                    <small>{playlist.trackCount}</small>
                  </label>
                ))
              )}
            </div>

            <form onSubmit={(event) => void create(event)}>
              <label htmlFor={newPlaylistId}>New playlist</label>
              <div>
                <input
                  id={newPlaylistId}
                  value={name}
                  maxLength={80}
                  placeholder="Playlist name"
                  onChange={(event) => setName(event.currentTarget.value)}
                />
                <button type="submit" disabled={library.busy || !name.trim()}>
                  <Plus size={15} /> Create
                </button>
              </div>
            </form>
            {(notice || library.error) && <p className="playlist-dialog-error">{notice ?? library.error}</p>}
          </section>
        </div>
      )}
    </>
  );
}
