import { Headphones, LogIn, LogOut, Shield } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_EMOTE, type RoomSnapshot, type SessionSnapshot } from '../shared/contracts';
import { userClass } from './flair';
import './SiteHeader.css';

interface SiteHeaderProps {
  children?: ReactNode;
  apiUrl?: string;
}

interface SiteHeaderPresenceProps {
  connected?: boolean;
  listenerCount: number;
}

export function SiteHeaderPresence({ connected, listenerCount }: SiteHeaderPresenceProps) {
  return (
    <div className="room-presence">
      {connected !== undefined && (
        <span className={connected ? 'connection-ok' : 'connection-wait'}>
          {connected ? 'Connected' : 'Reconnecting'}
        </span>
      )}
      <span><Headphones size={15} /> {listenerCount}</span>
    </div>
  );
}

interface SiteHeaderAccountProps {
  apiUrl: string;
  me: RoomSnapshot['me'];
  busy?: boolean;
  onLogout: () => void;
}

export function SiteHeaderAccount({ apiUrl, me, busy = false, onLogout }: SiteHeaderAccountProps) {
  return (
    <div className="account">
      {me ? (
        <>
          <span className={userClass(me, 'avatar avatar-frame')} aria-hidden="true">
            {me.avatarUrl ? (
              <img src={me.avatarUrl} alt="" />
            ) : (
              <span className={`emote ${me.topEmote ?? DEFAULT_EMOTE}`} />
            )}
          </span>
          <span className="account-name">
            <a
              className={userClass(me, 'profile-link')}
              href={`/profile/${encodeURIComponent(me.username)}`}
            >
              {me.username}
            </a>
          </span>
          {me.role === 'admin' && (
            <a className="admin-label" href="/admin" title="Room admin">
              <Shield size={13} /> admin
            </a>
          )}
          {me.role === 'mod' && (
            <span className="admin-label" title="Room moderator">
              <Shield size={13} /> mod
            </span>
          )}
          <button className="text-button" type="button" onClick={onLogout} disabled={busy}>
            <LogOut size={15} /> Sign out
          </button>
        </>
      ) : (
        <button
          className="login-button"
          type="button"
          onClick={() => { window.location.href = `${apiUrl}/api/auth/login`; }}
        >
          <LogIn size={16} /> Sign in with Destiny
        </button>
      )}
    </div>
  );
}

function RemoteHeaderContent({ apiUrl }: { apiUrl: string }) {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiUrl}/api/me`, { credentials: 'include' });
      if (!response.ok) return;
      setSession(await response.json() as SessionSnapshot);
    } catch {
      setSession(null);
    } finally {
      setLoaded(true);
    }
  }, [apiUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function logout() {
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch(`${apiUrl}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Sign out was refused.');
      await refresh();
    } catch {
      // Staying signed in without a word looks like the button did nothing.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SiteHeaderPresence listenerCount={session?.listenerCount ?? 0} />
      {loaded ? (
        <>
          {failed && <span className="header-notice" role="alert">Sign out failed</span>}
          <SiteHeaderAccount apiUrl={apiUrl} me={session?.me ?? null} busy={busy} onLogout={() => void logout()} />
        </>
      ) : (
        <div className="account" aria-hidden="true" />
      )}
    </>
  );
}

export default function SiteHeader({ children, apiUrl }: SiteHeaderProps) {
  return (
    <header className="topbar">
      <div className="brand-block">
        <a className="brand" href="/player" aria-label="DGG Radio home">
          <span className="emote pepeJAM" aria-hidden="true" />
          <span>DGG Radio</span>
          <span className="emote YAM" aria-hidden="true" />
          <span className="beta-badge">beta</span>
        </a>
        <span className="disclaimer">Not affiliated with destiny.gg</span>
      </div>
      {children ?? (apiUrl ? <RemoteHeaderContent apiUrl={apiUrl} /> : null)}
    </header>
  );
}
