import { serve } from '@hono/node-server';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createApp } from '../src/server/app';
import { shutdownServerAnalytics } from '../src/server/analytics';
import { getSessionUserByToken, readSessionTokenFromCookieHeader } from '../src/server/auth';
import { getDatabase } from '../src/server/db/client';
import { getEnv } from '../src/server/env';
import { applySeeds } from '../src/server/seed';
import { advanceIfExpired, currentRevision, ensureRoomExists } from '../src/server/room';
import { roomConnectionRequestSchema } from '../src/shared/roomConnection';
import { WebSocket, WebSocketServer } from 'ws';
import { ConnectionRegistry } from './connections';

const env = getEnv();
const connections = new ConnectionRegistry<WebSocket>();
const processStartedAt = new Date();
let clockChecks = 0;
let clockAdvances = 0;
let lastClockCheckAt: Date | null = null;
let lastClockAdvanceAt: Date | null = null;

function operationsSnapshot() {
  return {
    capturedAt: new Date().toISOString(),
    processStartedAt: processStartedAt.toISOString(),
    ...connections.snapshot(),
    clock: {
      checks: clockChecks,
      advances: clockAdvances,
      lastCheckedAt: lastClockCheckAt?.toISOString() ?? null,
      lastAdvancedAt: lastClockAdvanceAt?.toISOString() ?? null,
    },
  };
}

function broadcastRoomChanged(): void {
  void currentRevision()
    .then((revision) => {
      const message = JSON.stringify({ type: 'room_changed', revision });
      for (const client of connections.clients()) {
        if (client.readyState === WebSocket.OPEN) client.send(message);
      }
    })
    .catch((error) => console.error('Could not broadcast room state', error));
}

const app = createApp({
  listenerCount: () => connections.listenerCount(),
  eligibleVoterCount: () => connections.eligibleVoterCount(),
  operationsSnapshot,
  onRoomChanged: broadcastRoomChanged,
});

// Apply pending migrations before serving. Deploys are automated from `main`,
// so there is no operator around to run `db:migrate` by hand — without this a
// commit that adds a migration would start the API against a stale schema.
// Failing here is deliberate: a container that cannot migrate should not serve.
await migrate(getDatabase(), { migrationsFolder: 'drizzle' });

// The QueUp years and what every track is, shipped in the repository so that a
// deploy carries them. They only fill gaps, so anything this database has
// learned since survives. Unlike a migration this is allowed to fail: a room
// with less in it still works, and a seed file is no reason to refuse to serve.
try {
  const seeded = await applySeeds();
  for (const [what, result] of Object.entries(seeded)) {
    if (result) {
      console.log(
        result.skipped
          ? `Seed ${what}: unchanged since it was applied, ${result.kept.toLocaleString()} rows left alone`
          : `Seeded ${what}: added ${result.added.toLocaleString()}, ` +
            `left ${result.kept.toLocaleString()} already stored`,
      );
    }
  }
} catch (error) {
  console.error('Could not apply the seeds', error);
}

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
  const connectionRequest = roomConnectionRequestSchema.safeParse({
    kind: requestUrl.searchParams.get('kind'),
    visitorId: requestUrl.searchParams.get('visitorId') ?? undefined,
  });
  if (
    requestUrl.pathname !== '/ws' ||
    request.headers.origin !== env.APP_ORIGIN ||
    !connectionRequest.success
  ) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (client) => {
    webSocketServer.emit('connection', client, request);
  });
});

webSocketServer.on('connection', async (client, request) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const connectionRequest = roomConnectionRequestSchema.parse({
    kind: requestUrl.searchParams.get('kind'),
    visitorId: requestUrl.searchParams.get('visitorId') ?? undefined,
  });
  const sessionToken = readSessionTokenFromCookieHeader(request.headers.cookie);
  const user = sessionToken ? await getSessionUserByToken(sessionToken) : null;
  connections.add(client, {
    kind: connectionRequest.kind,
    userId: user?.id ?? null,
    username: user?.username ?? null,
    visitorId: connectionRequest.kind === 'room' ? connectionRequest.visitorId : null,
  });
  client.send(
    JSON.stringify({
      type: 'connected',
      revision: await currentRevision(),
      authenticated: Boolean(user),
    }),
  );
  broadcastRoomChanged();

  const removeConnection = () => {
    if (connections.delete(client)) broadcastRoomChanged();
  };
  client.on('close', removeConnection);
  client.on('error', removeConnection);
});

let clockBusy = false;
const clock = setInterval(() => {
  if (clockBusy) return;
  clockBusy = true;
  clockChecks += 1;
  lastClockCheckAt = new Date();
  void advanceIfExpired()
    .then((changed) => {
      if (changed) {
        clockAdvances += 1;
        lastClockAdvanceAt = new Date();
        broadcastRoomChanged();
      }
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
  for (const client of connections.clients()) client.close(1001, 'Server shutting down');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await shutdownServerAnalytics();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
