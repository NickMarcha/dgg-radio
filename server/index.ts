import { serve } from '@hono/node-server';
import { createApp } from '../src/server/app';
import { shutdownServerAnalytics } from '../src/server/analytics';
import { getSessionUserByToken, readSessionTokenFromCookieHeader } from '../src/server/auth';
import { getEnv } from '../src/server/env';
import { advanceIfExpired, currentRevision, ensureRoomExists } from '../src/server/room';
import { WebSocket, WebSocketServer } from 'ws';

const env = getEnv();
const clients = new Set<WebSocket>();

function broadcastRoomChanged(): void {
  void currentRevision()
    .then((revision) => {
      const message = JSON.stringify({ type: 'room_changed', revision });
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.send(message);
      }
    })
    .catch((error) => console.error('Could not broadcast room state', error));
}

const app = createApp({
  listenerCount: () => clients.size,
  onRoomChanged: broadcastRoomChanged,
});

await ensureRoomExists();

const server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  ({ port }) => console.log(`DGG Radio API listening on http://localhost:${port}`),
);

const webSocketServer = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (requestUrl.pathname !== '/ws' || request.headers.origin !== env.APP_ORIGIN) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (client) => {
    webSocketServer.emit('connection', client, request);
  });
});

webSocketServer.on('connection', async (client, request) => {
  const sessionToken = readSessionTokenFromCookieHeader(request.headers.cookie);
  const user = sessionToken ? await getSessionUserByToken(sessionToken) : null;
  clients.add(client);
  client.send(
    JSON.stringify({
      type: 'connected',
      revision: await currentRevision(),
      authenticated: Boolean(user),
    }),
  );
  broadcastRoomChanged();

  client.on('close', () => {
    clients.delete(client);
    broadcastRoomChanged();
  });
  client.on('error', () => clients.delete(client));
});

let clockBusy = false;
const clock = setInterval(() => {
  if (clockBusy) return;
  clockBusy = true;
  void advanceIfExpired()
    .then((changed) => {
      if (changed) broadcastRoomChanged();
    })
    .catch((error) => console.error('Room clock failed', error))
    .finally(() => {
      clockBusy = false;
    });
}, 1_000);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(clock);
  for (const client of clients) client.close(1001, 'Server shutting down');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await shutdownServerAnalytics();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
