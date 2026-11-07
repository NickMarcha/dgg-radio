import { useEffect, useState } from 'react';
import type { OwnedStation, SessionSnapshot } from '../shared/contracts';

const MAIN: OwnedStation = { slug: 'main', name: 'DGG Radio' };

/**
 * The station the signed-in listener is tuned to, which is where a page with
 * no station of its own sends a request. The main station until it is known,
 * and for anybody signed out.
 */
export function useTunedStation(apiUrl: string): OwnedStation {
  const [tuned, setTuned] = useState<OwnedStation>(MAIN);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${apiUrl}/api/me`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : null))
      .then((session: SessionSnapshot | null) => {
        if (!cancelled && session?.tunedStation) setTuned(session.tunedStation);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  return tuned;
}
