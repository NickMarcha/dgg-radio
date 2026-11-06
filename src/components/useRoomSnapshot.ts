import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomSnapshot } from '../shared/contracts';
import type { EmbedConnectionKind } from '../shared/roomConnection';
import { createRoomSocketUrl } from './roomSocket';

interface RoomSnapshotState {
  room: RoomSnapshot | null;
  error: string | null;
}

/** Keep a public room snapshot current through WebSocket notices and a polling fallback. */
export function useRoomSnapshot(
  apiUrl: string,
  connectionKind: EmbedConnectionKind,
  roomSlug: string,
): RoomSnapshotState {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reconnectTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiUrl}/api/rooms/${roomSlug}`, { credentials: 'include' });
      if (!response.ok) throw new Error(`The room API returned ${response.status}.`);
      setRoom(await response.json() as RoomSnapshot);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The room could not be loaded.');
    }
  }, [apiUrl, roomSlug]);

  useEffect(() => {
    void refresh();
    const fallbackPoll = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(fallbackPoll);
  }, [refresh]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    const wsUrl = createRoomSocketUrl(apiUrl, { kind: connectionKind, room: roomSlug });

    const connect = () => {
      socket = new WebSocket(wsUrl);
      socket.onmessage = () => void refresh();
      socket.onerror = () => socket?.close();
      socket.onclose = (event) => {
        // 4404: no such room, which retrying will not change.
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
  }, [apiUrl, connectionKind, refresh, roomSlug]);

  return { room, error };
}
