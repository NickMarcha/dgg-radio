import { useCallback, useEffect, useRef, useState } from 'react';
import type { StationSnapshot } from '../shared/contracts';
import type { EmbedConnectionKind } from '../shared/stationConnection';
import { createStationSocketUrl } from './stationSocket';

interface StationSnapshotState {
  station: StationSnapshot | null;
  error: string | null;
}

/** Keep a public station snapshot current through WebSocket notices and a polling fallback. */
export function useStationSnapshot(
  apiUrl: string,
  connectionKind: EmbedConnectionKind,
  stationSlug: string,
): StationSnapshotState {
  const [station, setStation] = useState<StationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reconnectTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiUrl}/api/stations/${stationSlug}`, { credentials: 'include' });
      if (!response.ok) throw new Error(`The station API returned ${response.status}.`);
      setStation(await response.json() as StationSnapshot);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The station could not be loaded.');
    }
  }, [apiUrl, stationSlug]);

  useEffect(() => {
    void refresh();
    const fallbackPoll = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(fallbackPoll);
  }, [refresh]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    const wsUrl = createStationSocketUrl(apiUrl, { kind: connectionKind, station: stationSlug });

    const connect = () => {
      socket = new WebSocket(wsUrl);
      socket.onmessage = () => void refresh();
      socket.onerror = () => socket?.close();
      socket.onclose = (event) => {
        // 4404: no such station, which retrying will not change.
        if (!stopped && event.code !== 4404) {
          reconnectTimer.current = window.setTimeout(connect, 2_000);
        }
      };
    };
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      socket?.close();
    };
  }, [apiUrl, connectionKind, refresh, stationSlug]);

  return { station, error };
}
