import {
  visitorIdSchema,
  type EmbedConnectionKind,
  type RoomConnectionRequest,
} from '../shared/roomConnection';

const VISITOR_ID_STORAGE_KEY = 'dgg-radio:visitor-id';

interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getRoomVisitorId(
  storage: BrowserStorage = window.localStorage,
  generateId: () => string = () => crypto.randomUUID(),
): string {
  try {
    const existingId = storage.getItem(VISITOR_ID_STORAGE_KEY);
    if (existingId && visitorIdSchema.safeParse(existingId).success) return existingId;

    const visitorId = generateId();
    storage.setItem(VISITOR_ID_STORAGE_KEY, visitorId);
    return visitorId;
  } catch {
    return generateId();
  }
}

export function createRoomSocketUrl(apiUrl: string, connection: RoomConnectionRequest): URL {
  const socketUrl = new URL(apiUrl);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  socketUrl.pathname = '/ws';
  socketUrl.search = '';
  socketUrl.searchParams.set('kind', connection.kind);
  if (connection.kind === 'room') socketUrl.searchParams.set('visitorId', connection.visitorId);
  return socketUrl;
}

export function embedConnectionKind(mode: 'player' | 'playing' | 'queue'): EmbedConnectionKind {
  return `embed-${mode}`;
}
