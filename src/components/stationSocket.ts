import {
  visitorIdSchema,
  type EmbedConnectionKind,
  type StationConnectionRequest,
} from '../shared/stationConnection';

const VISITOR_ID_STORAGE_KEY = 'dgg-radio:visitor-id';

interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getStationVisitorId(
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

export function createStationSocketUrl(apiUrl: string, connection: StationConnectionRequest): URL {
  const socketUrl = new URL(apiUrl);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  socketUrl.pathname = '/ws';
  socketUrl.search = '';
  socketUrl.searchParams.set('kind', connection.kind);
  socketUrl.searchParams.set('station', connection.station);
  if (connection.kind === 'station') socketUrl.searchParams.set('visitorId', connection.visitorId);
  return socketUrl;
}

export function embedConnectionKind(
  mode: 'player' | 'playing' | 'queue' | 'watchers',
): EmbedConnectionKind {
  return `embed-${mode}`;
}
