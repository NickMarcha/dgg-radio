import { useEffect, useState } from 'react';
import { lastStationSlug, stationPath } from '../client/station';

interface SiteNavProps {
  active?: 'station' | 'stations' | 'stats' | 'history' | 'playlists';
}

const links = [
  { key: 'station', href: '/', label: 'Listen' },
  { key: 'stations', href: '/stations', label: 'Stations' },
  { key: 'stats', href: '/stats', label: 'Stats' },
  { key: 'history', href: '/history', label: 'History' },
  { key: 'playlists', href: '/playlists', label: 'Playlists' },
] as const;

export default function SiteNav({ active }: SiteNavProps) {
  // Listen goes back to whichever station this browser last opened, not always
  // the main one. Read after hydration, since the page is prerendered.
  const [listenHref, setListenHref] = useState('/');
  useEffect(() => setListenHref(stationPath(lastStationSlug())), []);

  return (
    <nav className="site-nav" aria-label="DGG Radio">
      <div>
        {links.map((link) => (
          <a
            key={link.key}
            href={link.key === 'station' ? listenHref : link.href}
            aria-current={active === link.key ? 'page' : undefined}
          >
            {link.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
