import { useEffect, useState } from 'react';
import type { WatcherEmbedSettings } from '../shared/contracts';

/** A running OBS source picks up a saved preset within roughly one second. */
export function useWatcherEmbedSettings(
  apiUrl: string,
  ownerId: string | null,
): WatcherEmbedSettings | null {
  const [settings, setSettings] = useState<WatcherEmbedSettings | null>(null);

  useEffect(() => {
    setSettings(null);
    if (!ownerId) return;

    let stopped = false;
    let timer: number | undefined;
    let request: AbortController | undefined;

    const load = async () => {
      request = new AbortController();
      try {
        const response = await fetch(`${apiUrl}/api/watcher-embeds/${ownerId}`, {
          cache: 'no-store',
          signal: request.signal,
        });
        if (response.ok) {
          const next = (await response.json()) as WatcherEmbedSettings;
          if (!stopped) {
            setSettings((current) => (current?.updatedAt === next.updatedAt ? current : next));
          }
        }
      } catch {
        // Keep the last working settings during a brief API outage.
      } finally {
        if (!stopped) timer = window.setTimeout(load, 1_000);
      }
    };

    void load();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      request?.abort();
    };
  }, [apiUrl, ownerId]);

  return settings;
}
