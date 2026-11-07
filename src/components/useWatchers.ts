import { useEffect, useState } from 'react';
import type { WatchersSnapshot } from '../shared/contracts';
import { createStationSocketUrl, embedConnectionKind } from './stationSocket';

/**
 * Who is watching the station's stream, kept current from the API.
 *
 * Unlike the station socket, which announces a revision and sends the browser off
 * to fetch its own snapshot, this one carries the snapshot itself: every field
 * of it is already public in Destiny chat, so there is no private state to keep
 * out of a shared message, and the roster moves too often to fetch each time.
 *
 * The connection is also the signal that somebody is looking. The server keeps
 * the chat socket open while an overlay is connected, so opening this page is
 * enough to start the tracker on a channel nobody is watching yet.
 */
export function useWatchers(apiUrl: string, stationSlug: string): WatchersSnapshot | null {
  const [snapshot, setSnapshot] = useState<WatchersSnapshot | null>(null);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let reconnect: number | undefined;

    // One fetch, so the source is not blank while the socket opens. It never
    // overwrites anything the socket has already delivered.
    void fetch(`${apiUrl}/api/stations/${stationSlug}/watchers`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: WatchersSnapshot | null) => {
        if (!stopped && body) setSnapshot((current) => current ?? body);
      })
      .catch(() => undefined);

    const connect = () => {
      const kind = embedConnectionKind('watchers');
      socket = new WebSocket(createStationSocketUrl(apiUrl, { kind, station: stationSlug }));
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as {
            type?: string;
            snapshot?: WatchersSnapshot;
          };
          if (message.type === 'watchers' && message.snapshot) setSnapshot(message.snapshot);
        } catch {
          // A frame this page cannot read is no reason to drop the socket.
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!stopped) reconnect = window.setTimeout(connect, 2_000);
      };
    };
    connect();

    return () => {
      stopped = true;
      if (reconnect) window.clearTimeout(reconnect);
      socket?.close();
    };
  }, [apiUrl, stationSlug]);

  return snapshot;
}
