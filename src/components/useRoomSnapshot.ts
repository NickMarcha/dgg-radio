import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomSnapshot } from '../shared/contracts';

interface RoomSnapshotState {
  room: RoomSnapshot | null;
  error: string | null;
}

/** Keep a public room snapshot current through WebSocket notices and a polling fallback. */
export function useRoomSnapshot(apiUrl: string): RoomSnapshotState {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reconnectTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiUrl}/api/room`, { credentials: 'include' });
      if (!response.ok) throw new Error(`The room API returned ${response.status}.`);
      setRoom(await response.json() as RoomSnapshot);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The room could not be loaded.');
    }
  }, [apiUrl]);

  useEffect(() => {
    void refresh();
    const fallbackPoll = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(fallbackPoll);
  }, [refresh]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    const wsUrl = new URL(apiUrl);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.pathname = '/ws';

    const connect = () => {
      socket = new WebSocket(wsUrl);
      socket.onmessage = () => void refresh();
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!stopped) reconnectTimer.current = window.setTimeout(connect, 2_000);
      };
    };
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      socket?.close();
    };
  }, [apiUrl, refresh]);

  return { room, error };
}
