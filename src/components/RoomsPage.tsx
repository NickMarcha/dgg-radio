import { Headphones, Plus, Settings } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { RoomListing, SessionSnapshot } from '../shared/contracts';
import { roomPath } from '../client/room';
import SiteHeader from './SiteHeader';
import SiteNav from './SiteNav';
import './RoomsPage.css';

interface RoomsPageProps {
  apiUrl: string;
}

/** A name in a URL from a name a person typed: lowercase, dashes for anything else. */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

export default function RoomsPage({ apiUrl }: RoomsPageProps) {
  const [rooms, setRooms] = useState<RoomListing[] | null>(null);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [roomList, me] = await Promise.all([
      fetch(`${apiUrl}/api/rooms`, { credentials: 'include' }).then((response) => response.json()),
      fetch(`${apiUrl}/api/me`, { credentials: 'include' }).then((response) => response.json()),
    ]);
    setRooms((roomList as { rooms: RoomListing[] }).rooms);
    setSession(me as SessionSnapshot);
  }, [apiUrl]);

  useEffect(() => {
    void load().catch(() => setError('The rooms could not be loaded.'));
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/api/rooms`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), slug }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? 'The room could not be created.');
      window.location.href = roomPath((body as { slug: string }).slug);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The room could not be created.');
      setBusy(false);
    }
  }

  const owned = session?.rooms.owned ?? [];

  return (
    <div className="rooms-app">
      <SiteHeader apiUrl={apiUrl} />
      <SiteNav active="rooms" />
      <main className="rooms-main">
        <h1>Rooms</h1>

        {error && <p className="rooms-error" role="alert">{error}</p>}

        {rooms === null ? (
          <p className="rooms-muted">Loading…</p>
        ) : (
          <ul className="rooms-list">
            {rooms.map((room) => (
              <li key={room.slug}>
                <a href={roomPath(room.slug)}>{room.name}</a>
                <span className="rooms-playing">
                  {room.nowPlaying
                    ? `${room.nowPlaying.title}${room.nowPlaying.artist ? ` · ${room.nowPlaying.artist}` : ''}`
                    : 'Nothing playing'}
                </span>
                <span className="rooms-listeners" title="Listening now">
                  <Headphones size={14} /> {room.listenerCount}
                </span>
              </li>
            ))}
          </ul>
        )}

        {owned.length > 0 && (
          <section className="rooms-owned">
            <h2>Your room</h2>
            {owned.map((room) => (
              <p key={room.slug}>
                <a href={roomPath(room.slug)}>{room.name}</a>
                <a className="rooms-manage" href={`/admin?room=${encodeURIComponent(room.slug)}`}>
                  <Settings size={14} /> Manage
                </a>
              </p>
            ))}
          </section>
        )}

        {session?.rooms.canCreate && (
          <section className="rooms-create">
            <h2>Create a room</h2>
            <form onSubmit={(event) => void create(event)}>
              <label>
                Name
                <input
                  value={name}
                  maxLength={40}
                  required
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    setName(next);
                    if (!slugEdited) setSlug(slugFromName(next));
                  }}
                />
              </label>
              <label>
                Address
                <span className="rooms-slug">
                  <span>/r/</span>
                  <input
                    value={slug}
                    maxLength={32}
                    required
                    pattern="[a-z0-9][a-z0-9\-]{1,31}"
                    title="2 to 32 lowercase letters, digits, or dashes"
                    onChange={(event) => {
                      setSlugEdited(true);
                      setSlug(event.currentTarget.value.toLowerCase());
                    }}
                  />
                </span>
              </label>
              <button type="submit" disabled={busy || name.trim().length < 2 || slug.length < 2}>
                <Plus size={16} /> Create
              </button>
            </form>
          </section>
        )}
      </main>
    </div>
  );
}
