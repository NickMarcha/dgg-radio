import { Headphones, Plus, Settings } from 'lucide-react';
import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import type { StationListing, SessionSnapshot } from '../shared/contracts';
import { stationPath } from '../client/station';
import SiteHeader from './SiteHeader';
import SiteNav from './SiteNav';
import './StationsPage.css';

interface StationsPageProps {
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

export default function StationsPage({ apiUrl }: StationsPageProps) {
  const [stations, setStations] = useState<StationListing[] | null>(null);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [stationList, me] = await Promise.all([
      fetch(`${apiUrl}/api/stations`, { credentials: 'include' }).then((response) => response.json()),
      fetch(`${apiUrl}/api/me`, { credentials: 'include' }).then((response) => response.json()),
    ]);
    setStations((stationList as { stations: StationListing[] }).stations);
    setSession(me as SessionSnapshot);
  }, [apiUrl]);

  useEffect(() => {
    void load().catch(() => setError('The stations could not be loaded.'));
  }, [load]);

  async function create(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/api/stations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), slug }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? 'The station could not be created.');
      window.location.href = stationPath((body as { slug: string }).slug);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The station could not be created.');
      setBusy(false);
    }
  }

  const owned = session?.stations.owned ?? [];

  return (
    <div className="stations-app">
      <SiteHeader apiUrl={apiUrl} />
      <SiteNav active="stations" />
      <main className="stations-main">
        <h1>Stations</h1>

        {error && <p className="stations-error" role="alert">{error}</p>}

        {stations === null ? (
          <p className="stations-muted">Loading…</p>
        ) : (
          <ul className="stations-list">
            {stations.map((station) => (
              <li key={station.slug}>
                <a href={stationPath(station.slug)}>{station.name}</a>
                <span className="stations-playing">
                  {station.nowPlaying
                    ? `${station.nowPlaying.title}${station.nowPlaying.artist ? ` · ${station.nowPlaying.artist}` : ''}`
                    : 'Nothing playing'}
                </span>
                <span className="stations-listeners" title="Listening now">
                  <Headphones size={14} /> {station.listenerCount}
                </span>
              </li>
            ))}
          </ul>
        )}

        {owned.length > 0 && (
          <section className="stations-owned">
            <h2>Your station</h2>
            {owned.map((station) => (
              <p key={station.slug}>
                <a href={stationPath(station.slug)}>{station.name}</a>
                <a className="stations-manage" href={`/admin?station=${encodeURIComponent(station.slug)}`}>
                  <Settings size={14} /> Manage
                </a>
              </p>
            ))}
          </section>
        )}

        {session?.stations.canCreate && (
          <section className="stations-create">
            <h2>Create a station</h2>
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
                <span className="stations-slug">
                  <span>/s/</span>
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
