import { serve } from '@hono/node-server';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createApp } from '../src/server/app';
import { shutdownServerAnalytics } from '../src/server/analytics';
import { getSessionUserByToken, readSessionTokenFromCookieHeader } from '../src/server/auth';
import { getDatabase } from '../src/server/db/client';
import { getEnv } from '../src/server/env';
import { applySeeds } from '../src/server/seed';
import { watchTracker } from '../src/server/watchers';
import {
  advanceIfExpired,
  currentRevision,
  ensureRoomExists,
  listRoomIds,
} from '../src/server/room';
import { findRoomIdBySlug, MAIN_ROOM_ID } from '../src/server/rooms';
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

/**
 * The overlay is pushed the snapshot itself rather than a revision to go and
 * fetch, the way the room socket works: every field of it is already public in
 * Destiny chat, so there is no private state to keep out of a shared message.
 * An unchanged snapshot is not resent, which on a quiet channel is most seconds.
 * Each overlay is sent the snapshot of the room it named.
 */
const lastWatchersMessage = new Map<string, string>();

function watchersMessage(roomId: string): string {
  return JSON.stringify({ type: 'watchers', snapshot: watchTracker.snapshot(roomId) });
}

function broadcastWatchers(): void {
  const byRoom = new Map<string, WebSocket[]>();
  for (const client of connections.clientsOfKind('embed-watchers')) {
    const roomId = connections.roomOf(client);
    if (roomId === undefined) continue;
    byRoom.set(roomId, [...(byRoom.get(roomId) ?? []), client]);
  }
  for (const roomId of lastWatchersMessage.keys()) {
    if (!byRoom.has(roomId)) lastWatchersMessage.delete(roomId);
  }

  for (const [roomId, clients] of byRoom) {
    const message = watchersMessage(roomId);
    if (message === lastWatchersMessage.get(roomId)) continue;
    lastWatchersMessage.set(roomId, message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }
}

/**
 * Tells the sockets on one room that it changed, or every room's sockets when
 * no room is named: a change to a person, such as their team, shows wherever
 * their name does.
 */
function broadcastRoomChanged(roomId?: string): void {
  const roomIds = roomId === undefined ? [...connections.roomIds()] : [roomId];
  for (const id of roomIds) {
    void currentRevision(id)
      .then((revision) => {
        const message = JSON.stringify({ type: 'room_changed', revision });
        for (const client of connections.clientsInRoom(id)) {
          if (client.readyState === WebSocket.OPEN) client.send(message);
        }
      })
      .catch((error) => console.error('Could not broadcast room state', error));
  }
}

const app = createApp({
  listenerCount: (roomId) => connections.listenerCount(roomId),
  eligibleVoterCount: (roomId) => connections.eligibleVoterCount(roomId),
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

await ensureRoomExists(MAIN_ROOM_ID);

// Watching a destiny.gg embed, if an admin has turned it on. It connects to
// nothing while it is off, and a failure here is never a reason to refuse to
// serve the room.
// An open overlay is reason enough to hold the chat socket, so the tracker is
// told how many there are.
watchTracker
  .start(() => connections.countOfKind('embed-watchers'))
  .catch((error) => console.error('Could not start the stream watch', error));

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
    room: requestUrl.searchParams.get('room'),
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
    room: requestUrl.searchParams.get('room'),
    visitorId: requestUrl.searchParams.get('visitorId') ?? undefined,
  });
  const roomId = await findRoomIdBySlug(connectionRequest.room);
  if (!roomId) {
    // 4404 is in the range the protocol leaves to applications; the client
    // stops retrying a room that does not exist rather than looping on it.
    client.close(4404, 'That room does not exist.');
    return;
  }
  const sessionToken = readSessionTokenFromCookieHeader(request.headers.cookie);
  const user = sessionToken ? await getSessionUserByToken(sessionToken) : null;
  connections.add(client, {
    kind: connectionRequest.kind,
    roomId,
    userId: user?.id ?? null,
    username: user?.username ?? null,
    visitorId: connectionRequest.kind === 'room' ? connectionRequest.visitorId : null,
  });
  client.send(
    JSON.stringify({
      type: 'connected',
      revision: await currentRevision(roomId),
      authenticated: Boolean(user),
    }),
  );
  broadcastRoomChanged(roomId);

  if (connectionRequest.kind === 'embed-watchers') {
    client.send(watchersMessage(roomId));
    // The first overlay is a reason to open the chat socket, and waiting for
    // the next refresh would leave it dark for a quarter of a minute.
    void watchTracker.refresh().catch((error) => console.error('Stream watch refresh failed', error));
  }

  const removeConnection = () => {
    if (connections.delete(client)) broadcastRoomChanged(roomId);
  };
  client.on('close', removeConnection);
  client.on('error', removeConnection);
});

const watchersClock = setInterval(broadcastWatchers, 1_000);

let clockBusy = false;
const clock = setInterval(() => {
  if (clockBusy) return;
  clockBusy = true;
  clockChecks += 1;
  lastClockCheckAt = new Date();
  // Every room is ticked, and one failing does not stop the others.
  void listRoomIds()
    .then(async (roomIds) => {
      const results = await Promise.allSettled(roomIds.map((roomId) => advanceIfExpired(roomId)));
      const changed: string[] = [];
      results.forEach((result, index) => {
        if (result.status === 'rejected') console.error('Room clock failed', result.reason);
        else if (result.value) changed.push(roomIds[index]!);
      });
      return changed;
    })
    .then((changed) => {
      if (changed.length > 0) {
        clockAdvances += 1;
        lastClockAdvanceAt = new Date();
        for (const roomId of changed) broadcastRoomChanged(roomId);
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
  clearInterval(watchersClock);
  watchTracker.stop();
  for (const client of connections.clients()) client.close(1001, 'Server shutting down');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await shutdownServerAnalytics();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
