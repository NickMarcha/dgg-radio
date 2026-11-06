import { zValidator } from '@hono/zod-validator';
import { routePath } from 'hono/route';
import { cors } from 'hono/cors';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import {
  blockByUrlSchema,
  blockMediaSchema,
  clearQueueSchema,
  playlistSchema,
  personalPlaylistSchema,
  playlistListQuerySchema,
  playlistOrderSchema,
  queupImportSchema,
  reorderSchema,
  searchSchema,
  removeQueueItemSchema,
  ruleSchema,
  ruleUpdateSchema,
  roomSettingsSchema,
  streamWatchSchema,
  submitRequestSchema,
  roomCreatorSchema,
  roomModeratorSchema,
  userRoleSchema,
  voteSchema,
  watcherEmbedSchema,
  type ProcessSnapshot,
} from '../shared/contracts';
import {
  AuthenticationError,
  clearSession,
  completeAuthorization,
  createAuthorizationUrl,
  getSessionUser,
  setSessionCookie,
  type AuthenticatedUser,
} from './auth';
import {
  captureServerEvent,
  captureServerException,
  captureSlowRequest,
  SLOW_REQUEST_MS,
} from './analytics';
import {
  createRule,
  deleteRule,
  listRuleEntries,
  listRules,
  removeRuleEntry,
  roomOfRule,
  roomOfRuleEntry,
  reorderRules,
  RuleError,
  updateRule,
} from './rules';
import { ChatLookupError, requestChatCheck } from './chat';
import { listPlaybackRegions, RegionLookupError } from './regions';
import { AdminError, listAdmins, listUsers, setRoomCreator, setUserRole } from './admins';
import { CatalogueError, getArtistDetail, getTrackDetail } from './catalogue';
import {
  CommunityError,
  getCommunityStats,
  getUserProfile,
  listHistory,
} from './community';
import { getEnv } from './env';
import { enqueueLegacyPlay, listLegacyHistory } from './legacy';
import { MediaLookupError, searchMedia } from './media';
import {
  blockMediaByUrl,
  blockQueueItemMedia,
  clearUserQueue,
  enqueueMedia,
  dismissQueueNotice,
  enqueueProviderPlaylist,
  reorderMyQueue,
  reorderRoomQueue,
  getRoomSnapshot,
  removeQueuedTrack,
  roomOfQueueItem,
  RoomError,
  skipCurrentTrack,
  toRoomUser,
  updateRoomSettings,
  voteOnCurrentTrack,
  withdrawQueuedTrack,
} from './room';
import {
  canManageRoom,
  canModerateRoom,
  findRoomIdBySlug,
  RoomAccessError,
  roomRoleOf,
  setRoomModerator,
} from './rooms';
import {
  addLegacyPlayToPlaylist,
  addPlaylistTrack,
  addPlaylistTrackByUrl,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  importQueupPlaylists,
  listPlaylists,
  PlaylistError,
  queuePlaylist,
  queuePlaylistTrack,
  removePlaylistTrack,
  renamePlaylist,
  reorderPlaylist,
} from './playlists';
import { getModerationLog } from './moderation';
import { QueupError, refreshArchive } from './queup';
import { limitPerAddress, limitPerUser } from './rate-limit';
import { exportCsv, exportFilename, EXPORTS } from './export';
import { getStorageSnapshot } from './storage';
import {
  updateStreamWatchSettings,
  watchTracker,
} from './watchers';
import {
  findWatcherEmbedSettings,
  getOrCreateWatcherEmbedSettings,
  updateWatcherEmbedSettings,
} from './watcher-embeds';

interface AppDependencies {
  /** People in one room, or across the site when no room is named. */
  listenerCount: (roomId?: string) => number;
  eligibleVoterCount: (roomId: string) => number;
  operationsSnapshot: () => ProcessSnapshot;
  /** Tells one room's sockets it changed, or every room's when none is named. */
  onRoomChanged: (roomId?: string) => void;
}

type Variables = {
  user: AuthenticatedUser;
  /** Set by `inRoom` or `requireRoomRole`: the room the request acts in. */
  roomId: string;
};

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().length(64),
});

const idParamSchema = z.object({ id: z.uuid() });
const roomMemberParamSchema = z.object({ slug: z.string().min(1).max(32), id: z.uuid() });
const playlistTrackParamSchema = z.object({ id: z.uuid(), mediaId: z.uuid() });
/** QueUp's own id for a play, which is what the archive is keyed by. */
const legacySourceId = z.string().trim().min(1).max(64);
const legacyTrackParamSchema = z.object({ id: z.uuid(), sourceId: legacySourceId });
const legacySourceParamSchema = z.object({ sourceId: legacySourceId });
const usernameParamSchema = z.object({ username: z.string().trim().min(1).max(64) });
/** The slug out of a QueUp room's URL, as in `queup.net/join/dgg-radio`. */
const archiveRefreshSchema = z.object({
  room: z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/i, 'That is not a QueUp room name.'),
});

/** A provider id, as the provider spells it rather than as a UUID. */
const providerId = z.string().trim().min(1).max(120);
const trackParamSchema = z.object({
  provider: z.enum(['youtube', 'soundcloud']),
  providerMediaId: providerId,
});
const artistParamSchema = z.object({
  provider: z.enum(['youtube', 'soundcloud']),
  providerArtistId: providerId,
});

/** A month on its own means nothing, and is ignored rather than guessed at. */
const statsQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

const exportParamSchema = z.object({
  dataset: z.enum([
    'history',
    'archive',
    'tracks',
    'lookups',
    'stats-tracks',
    'stats-jammers',
    'stats-genres',
  ]),
});
/**
 * Both histories are read the same way: one numbered page at a time, newest
 * first, optionally narrowed by a search. Numbered rather than walked by a
 * cursor so that the page somebody is reading survives being shared as a link.
 */
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  q: z.string().trim().min(1).max(80).optional(),
  /** One genre or style, spelled the way the tag a reader clicked spells it. */
  genre: z.string().trim().min(1).max(60).optional(),
});

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function createApp(dependencies: AppDependencies) {
  const env = getEnv();
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', secureHeaders());
  // Only the tail is recorded: a request slower than SLOW_REQUEST_MS. A healthy
  // server writes nothing at all, which is what makes this safe to put in front
  // of /api/room, polled every fifteen seconds by every open room.
  app.use('/api/*', async (context, next) => {
    const startedAt = performance.now();
    // If the handler throws, the error handler below decides the real status;
    // what is recorded here is only that the request failed slowly.
    let status = 500;
    try {
      await next();
      status = context.res.status;
    } finally {
      const durationMs = performance.now() - startedAt;
      if (durationMs >= SLOW_REQUEST_MS) {
        captureSlowRequest({
          // The registered path rather than the requested one, so a thousand
          // track ids do not become a thousand different routes.
          route: routePath(context, -1),
          method: context.req.method,
          status,
          durationMs,
          userId: context.get('user')?.id,
        });
      }
    }
  });
  app.use(
    '/api/*',
    cors({
      origin: env.APP_ORIGIN,
      credentials: true,
      allowHeaders: ['Content-Type'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use('/api/*', async (context, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(context.req.method)) {
      const origin = context.req.header('Origin');
      if (origin !== env.APP_ORIGIN) {
        return context.json(errorBody('INVALID_ORIGIN', 'The request origin was rejected.'), 403);
      }
    }
    await next();
  });

  const requireUser = async (context: any, next: () => Promise<void>) => {
    const user = await getSessionUser(context);
    if (!user) return context.json(errorBody('AUTH_REQUIRED', 'Sign in with Destiny to do that.'), 401);
    context.set('user', user);
    await next();
  };

  const requireAdmin = async (context: any, next: () => Promise<void>) => {
    const user = await getSessionUser(context);
    if (!user) return context.json(errorBody('AUTH_REQUIRED', 'Sign in with Destiny to do that.'), 401);
    if (user.role !== 'admin') {
      return context.json(errorBody('ADMIN_REQUIRED', 'Only admins can do that.'), 403);
    }
    context.set('user', user);
    await next();
  };

  /**
   * A role in the room the request acts in: `mod` for moderating it, `owner`
   * for changing it. The room is resolved per route, so an action on a queue
   * item or a rule is judged by the room that item or rule belongs to, never
   * by the room the caller happens to moderate.
   */
  const requireRoomRole =
    (level: 'mod' | 'owner', resolveRoom: (context: any) => Promise<string>) =>
    async (context: any, next: () => Promise<void>) => {
      // A route whose room comes from its params signs the caller in first,
      // so a stranger is told to sign in before being told the id is wrong.
      const user = context.get('user') ?? (await getSessionUser(context));
      if (!user) {
        return context.json(errorBody('AUTH_REQUIRED', 'Sign in with Destiny to do that.'), 401);
      }
      const roomId = await resolveRoom(context);
      const role = await roomRoleOf(user, roomId);
      if (level === 'owner' ? !canManageRoom(role) : !canModerateRoom(role)) {
        return level === 'owner'
          ? context.json(errorBody('ROOM_OWNER_REQUIRED', 'Only the room owner can do that.'), 403)
          : context.json(errorBody('MODERATOR_REQUIRED', 'Only this room\'s mods can do that.'), 403);
      }
      context.set('user', user);
      context.set('roomId', roomId);
      await next();
    };

  const itemRoom = (context: any) => roomOfQueueItem(context.req.valid('param').id);
  const ruleRoom = (context: any) => roomOfRule(context.req.valid('param').id);
  const ruleEntryRoom = (context: any) => roomOfRuleEntry(context.req.valid('param').id);
  const slugRoom = async (context: any) => {
    const roomId = await findRoomIdBySlug(context.req.param('slug'));
    if (!roomId) throw new RoomAccessError('ROOM_NOT_FOUND', 'That room does not exist.', 404);
    return roomId;
  };
  /** For a route under `/api/rooms/:slug` that anyone, or any signed-in listener, may use. */
  const inRoom = async (context: any, next: () => Promise<void>) => {
    context.set('roomId', await slugRoom(context));
    await next();
  };
  const requireRoomModerator = requireRoomRole('mod', slugRoom);
  const requireRoomOwner = requireRoomRole('owner', slugRoom);

  app.onError((error, context) => {
    if (
      error instanceof RoomError ||
      error instanceof MediaLookupError ||
      error instanceof RuleError ||
      error instanceof AdminError ||
      error instanceof CatalogueError ||
      error instanceof QueupError ||
      error instanceof CommunityError ||
      error instanceof RegionLookupError ||
      error instanceof ChatLookupError ||
      error instanceof PlaylistError ||
      error instanceof RoomAccessError
    ) {
      if (error.status >= 500) {
        captureServerException(error, context.get('user')?.id, {
          error_code: error.code,
          method: context.req.method,
          path: new URL(context.req.url).pathname,
        });
      }
      return context.json(errorBody(error.code, error.message), error.status as 400);
    }
    if (error instanceof AuthenticationError) {
      return context.json(errorBody('LOGIN_FAILED', error.message), 400);
    }
    captureServerException(error, context.get('user')?.id, {
      method: context.req.method,
      path: new URL(context.req.url).pathname,
    });
    console.error('Unhandled API error', error);
    return context.json(errorBody('INTERNAL_ERROR', 'The server could not complete that request.'), 500);
  });

  const routes = app
    /**
     * `ok` answers the container healthcheck: can this process serve? It stays
     * true when the live socket is down, deliberately. The socket failed once
     * because the host could not resolve a name, and restarting the container
     * would have done nothing about that except take the room down too.
     *
     * `liveSocket` is here for something outside the host to poll, because the
     * push path cannot be trusted for this: the same DNS failure that killed
     * the socket also killed PostHog, so every event about it was dropped. The
     * tunnel kept serving throughout, which is why an inbound check is the one
     * that would have caught it.
     */
    .get('/health', (context) => context.json({ ok: true, liveSocket: watchTracker.liveSocket() }))
    .get('/api/auth/login', async (context) => context.redirect(await createAuthorizationUrl()))
    .post('/api/auth/callback', zValidator('json', callbackSchema), async (context) => {
      const { code, state } = context.req.valid('json');
      const session = await completeAuthorization(code, state);
      setSessionCookie(context, session.sessionToken, session.expiresAt);
      captureServerEvent(session.userId, 'user_signed_in');
      return context.json({ ok: true });
    })
    .post('/api/auth/logout', async (context) => {
      await clearSession(context);
      return context.json({ ok: true });
    })
    .get('/api/rooms/:slug', inRoom, async (context) => {
      const user = await getSessionUser(context);
      const roomId = context.get('roomId');
      return context.json(await getRoomSnapshot(roomId, user, dependencies.listenerCount(roomId)));
    })
    // Public, but a signed-in viewer is looked up anyway so the page can tell
    // whether it is showing someone their own profile.
    .get(
      '/api/profiles/:username',
      limitPerAddress('profiles', 60),
      zValidator('param', usernameParamSchema),
      async (context) => {
        const viewer = await getSessionUser(context);
        const username = context.req.valid('param').username;
        return context.json(await getUserProfile(username, viewer?.id ?? null));
      },
    )
    // Public: an OBS browser source carries no session, and everything in the
    // snapshot is already public in Destiny chat.
    .get('/api/rooms/:slug/watchers', inRoom, (context) =>
      context.json(watchTracker.snapshot(context.get('roomId'))),
    )
    // The UUID is the stable public source key. The row contains display
    // choices only, and both ends disable caching so a running OBS source sees
    // an admin's save without a reload.
    .get(
      '/api/watcher-embeds/:id',
      zValidator('param', idParamSchema),
      async (context) => {
        context.header('Cache-Control', 'no-store, max-age=0');
        const settings = await findWatcherEmbedSettings(context.req.valid('param').id);
        if (!settings) {
          return context.json(errorBody('WATCHER_EMBED_NOT_FOUND', 'That watcher source does not exist.'), 404);
        }
        return context.json(settings);
      },
    )
    .get('/api/me', async (context) =>
      context.json({
        me: toRoomUser(await getSessionUser(context)),
        listenerCount: dependencies.listenerCount(),
      }),
    )
    .get(
      '/api/history',
      limitPerAddress('history', 60),
      zValidator('query', historyQuerySchema),
      async (context) => {
        const { limit, page, q, genre } = context.req.valid('query');
        return context.json(await listHistory({ limit, page, search: q, genre }));
      },
    )
    // The archive from QueUp. Public like the room's own history, and paged the
    // same way, because it holds every play the room made before this one
    // existed.
    .get(
      '/api/history/legacy',
      limitPerAddress('history', 60),
      zValidator('query', historyQuerySchema),
      async (context) => {
        const { limit, page, q, genre } = context.req.valid('query');
        return context.json(await listLegacyHistory({ limit, page, search: q, genre }));
      },
    )
    // One track, and whoever published it. Public, like the history they are
    // reached from, and keyed by the provider's own id so that a track only the
    // QueUp archive remembers has a page too.
    .get(
      '/api/tracks/:provider/:providerMediaId',
      limitPerAddress('catalogue', 60),
      zValidator('param', trackParamSchema),
      async (context) => {
        const { provider, providerMediaId } = context.req.valid('param');
        return context.json(await getTrackDetail(provider, providerMediaId));
      },
    )
    .get(
      '/api/artists/:provider/:providerArtistId',
      limitPerAddress('catalogue', 60),
      zValidator('param', artistParamSchema),
      async (context) => {
        const { provider, providerArtistId } = context.req.valid('param');
        return context.json(await getArtistDetail(provider, providerArtistId));
      },
    )
    .get(
      '/api/stats',
      limitPerAddress('stats', 60),
      zValidator('query', statsQuerySchema),
      async (context) => {
        const { year, month } = context.req.valid('query');
        return context.json(
          await getCommunityStats(undefined, { year: year ?? null, month: month ?? null }),
        );
      },
    )
    .get(
      '/api/playlists',
      requireUser,
      zValidator('query', playlistListQuerySchema),
      async (context) =>
        context.json(
          await listPlaylists(
            context.get('user').id,
            context.req.valid('query').mediaIds,
          ),
        ),
    )
    .get(
      '/api/playlists/:id',
      requireUser,
      zValidator('param', idParamSchema),
      async (context) =>
        context.json(
          await getPlaylist(context.req.valid('param').id, context.get('user').id),
        ),
    )
    // A whole library moved over from QueUp, exported by
    // `public/queup-export-playlists.js` in the owner's own browser. It costs
    // provider lookups, so it is limited like the other import routes.
    .post(
      '/api/playlists/import',
      requireUser,
      limitPerUser('playlist-import', 5),
      zValidator('json', queupImportSchema),
      async (context) => {
        const imported = await importQueupPlaylists(
          context.req.valid('json'),
          context.get('user').id,
        );
        captureServerEvent(context.get('user').id, 'queup_playlists_imported', {
          playlists: imported.playlists.length,
          saved: imported.playlists.reduce((total, entry) => total + entry.saved, 0),
          skipped: imported.playlists.reduce((total, entry) => total + entry.skipped.length, 0),
        });
        return context.json(imported);
      },
    )
    .post(
      '/api/playlists',
      requireUser,
      zValidator('json', personalPlaylistSchema),
      async (context) => {
        const id = await createPlaylist(
          context.req.valid('json').name,
          context.get('user').id,
        );
        captureServerEvent(context.get('user').id, 'personal_playlist_created');
        return context.json({ id }, 201);
      },
    )
    .patch(
      '/api/playlists/:id',
      requireUser,
      zValidator('param', idParamSchema),
      zValidator('json', personalPlaylistSchema),
      async (context) => {
        await renamePlaylist(
          context.req.valid('param').id,
          context.req.valid('json').name,
          context.get('user').id,
        );
        return context.json({ ok: true });
      },
    )
    .delete(
      '/api/playlists/:id',
      requireUser,
      zValidator('param', idParamSchema),
      async (context) => {
        await deletePlaylist(context.req.valid('param').id, context.get('user').id);
        return context.json({ ok: true });
      },
    )
    .post(
      '/api/playlists/:id/tracks',
      requireUser,
      limitPerUser('lookup', 20),
      zValidator('param', idParamSchema),
      zValidator('json', submitRequestSchema),
      async (context) => {
        const saved = await addPlaylistTrackByUrl(
          context.req.valid('param').id,
          context.req.valid('json').url,
          context.get('user').id,
        );
        captureServerEvent(context.get('user').id, 'track_saved_to_playlist');
        return context.json(saved, 201);
      },
    )
    .put(
      '/api/playlists/:id/tracks/:mediaId',
      requireUser,
      zValidator('param', playlistTrackParamSchema),
      async (context) => {
        const { id, mediaId } = context.req.valid('param');
        await addPlaylistTrack(id, mediaId, context.get('user').id);
        captureServerEvent(context.get('user').id, 'track_saved_to_playlist');
        return context.json({ ok: true });
      },
    )
    .delete(
      '/api/playlists/:id/tracks/:mediaId',
      requireUser,
      zValidator('param', playlistTrackParamSchema),
      async (context) => {
        const { id, mediaId } = context.req.valid('param');
        await removePlaylistTrack(id, mediaId, context.get('user').id);
        return context.json({ ok: true });
      },
    )
    // Saving a track out of the QueUp archive. Unlike the route above it may
    // have to ask a provider first, because the archive holds no media rows, so
    // it is limited like everything else that spends a lookup.
    .put(
      '/api/playlists/:id/legacy/:sourceId',
      requireUser,
      limitPerUser('legacy-save', 30),
      zValidator('param', legacyTrackParamSchema),
      async (context) => {
        const { id, sourceId } = context.req.valid('param');
        const saved = await addLegacyPlayToPlaylist(id, sourceId, context.get('user').id);
        captureServerEvent(context.get('user').id, 'track_saved_to_playlist', {
          source: 'queup_archive',
        });
        return context.json(saved);
      },
    )
    .patch(
      '/api/playlists/:id/tracks/order',
      requireUser,
      zValidator('param', idParamSchema),
      zValidator('json', playlistOrderSchema),
      async (context) => {
        await reorderPlaylist(
          context.req.valid('param').id,
          context.req.valid('json').orderedMediaIds,
          context.get('user').id,
        );
        return context.json({ ok: true });
      },
    )
    .post(
      '/api/rooms/:slug/playlists/:id/tracks/:mediaId/queue',
      requireUser,
      inRoom,
      zValidator('param', playlistTrackParamSchema.extend({ slug: z.string() })),
      async (context) => {
        const { id, mediaId } = context.req.valid('param');
        const queued = await queuePlaylistTrack(
          context.get('roomId'),
          id,
          mediaId,
          context.get('user'),
        );
        captureServerEvent(context.get('user').id, 'saved_track_requested', {
          provider: queued.provider,
          duration_seconds: queued.durationSeconds,
        });
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ id: queued.id }, 201);
      },
    )
    .post(
      '/api/rooms/:slug/playlists/:id/queue',
      requireUser,
      inRoom,
      zValidator('param', idParamSchema.extend({ slug: z.string() })),
      async (context) => {
        const result = await queuePlaylist(
          context.get('roomId'),
          context.req.valid('param').id,
          context.get('user'),
        );
        captureServerEvent(context.get('user').id, 'personal_playlist_queued', {
          added: result.added,
          skipped: result.skipped.length,
        });
        if (result.added > 0) dependencies.onRoomChanged(context.get('roomId'));
        return context.json(result);
      },
    )
    .post(
      '/api/rooms/:slug/queue',
      requireUser,
      inRoom,
      limitPerUser('lookup', 20),
      zValidator('json', submitRequestSchema),
      async (context) => {
        const { url } = context.req.valid('json');
        const queued = await enqueueMedia(context.get('roomId'), url, context.get('user'));
        captureServerEvent(context.get('user').id, 'track_requested', {
          provider: queued.provider,
          duration_seconds: queued.durationSeconds,
        });
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ id: queued.id }, 201);
      },
    )
    // Requesting a track out of the QueUp archive. The archive holds a provider
    // id rather than a link, so this resolves one and then goes through the
    // room's ordinary request path, rules and cooldown included.
    .post(
      '/api/rooms/:slug/queue/legacy/:sourceId',
      requireUser,
      inRoom,
      limitPerUser('lookup', 20),
      zValidator('param', legacySourceParamSchema.extend({ slug: z.string() })),
      async (context) => {
        const queued = await enqueueLegacyPlay(
          context.get('roomId'),
          context.req.valid('param').sourceId,
          context.get('user'),
        );
        captureServerEvent(context.get('user').id, 'track_requested', {
          provider: queued.provider,
          duration_seconds: queued.durationSeconds,
          source: 'queup_archive',
        });
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ id: queued.id }, 201);
      },
    )
    .post(
      '/api/queue/:id/vote',
      requireUser,
      zValidator('param', idParamSchema),
      zValidator('json', voteSchema),
      async (context) => {
        const { id } = context.req.valid('param');
        const { value } = context.req.valid('json');
        const roomId = await roomOfQueueItem(id);
        await voteOnCurrentTrack(
          id,
          value,
          context.get('user'),
          dependencies.eligibleVoterCount(roomId),
        );
        captureServerEvent(context.get('user').id, 'track_vote_changed', {
          vote: value === 1 ? 'up' : value === -1 ? 'down' : 'cleared',
        });
        dependencies.onRoomChanged(roomId);
        return context.json({ ok: true });
      },
    )
    .get(
      '/api/search',
      requireUser,
      limitPerUser('search', 10),
      zValidator('query', searchSchema),
      async (context) => context.json({ results: await searchMedia(context.req.valid('query').q, 15) }),
    )
    .post(
      '/api/rooms/:slug/queue/playlist',
      requireUser,
      inRoom,
      limitPerUser('playlist-import', 5),
      zValidator('json', playlistSchema),
      async (context) => {
        const imported = await enqueueProviderPlaylist(
          context.get('roomId'),
          context.req.valid('json').url,
          context.get('user'),
        );
        captureServerEvent(context.get('user').id, 'playlist_imported', {
          added: imported.added,
          skipped: imported.skipped.length,
        });
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json(imported);
      },
    )
    .delete(
      '/api/queue/:id',
      requireUser,
      zValidator('param', idParamSchema),
      async (context) => {
        const { id } = context.req.valid('param');
        const roomId = await roomOfQueueItem(id);
        await withdrawQueuedTrack(id, context.get('user'));
        captureServerEvent(context.get('user').id, 'queue_track_withdrawn');
        dependencies.onRoomChanged(roomId);
        return context.json({ ok: true });
      },
    )
    // A notice belongs to one person, so reading it changes nothing anyone
    // else is looking at and no room broadcast is worth waking for it.
    .delete(
      '/api/queue/:id/notice',
      requireUser,
      zValidator('param', idParamSchema),
      async (context) => {
        await dismissQueueNotice(context.req.valid('param').id, context.get('user'));
        return context.json({ ok: true });
      },
    )
    .patch('/api/queue/order', requireUser, zValidator('json', reorderSchema), async (context) => {
      const { orderedIds } = context.req.valid('json');
      await reorderMyQueue(orderedIds, context.get('user'));
      // A listener queues in one room, so any of their tracks names it.
      dependencies.onRoomChanged(await roomOfQueueItem(orderedIds[0]!));
      return context.json({ ok: true });
    })
    .patch(
      '/api/rooms/:slug/queue/room-order',
      requireRoomModerator,
      zValidator('json', reorderSchema),
      async (context) => {
        await reorderRoomQueue(
          context.get('roomId'),
          context.req.valid('json').orderedIds,
          context.get('user'),
        );
        captureServerEvent(context.get('user').id, 'room_queue_reordered');
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ ok: true });
      },
    )
    .post(
      '/api/users/:id/clear-queue',
      requireAdmin,
      zValidator('param', idParamSchema),
      zValidator('json', clearQueueSchema),
      async (context) => {
        const removed = await clearUserQueue(
          context.req.valid('param').id,
          context.req.valid('json').reason,
          context.get('user'),
        );
        captureServerEvent(context.get('user').id, 'user_queue_cleared', { removed });
        dependencies.onRoomChanged();
        return context.json({ removed });
      },
    )
    .post(
      '/api/queue/:id/remove',
      requireUser,

      zValidator('param', idParamSchema),
      requireRoomRole('owner', itemRoom),
      zValidator('json', removeQueueItemSchema),
      async (context) => {
        const { id } = context.req.valid('param');
        const { reason } = context.req.valid('json');
        await removeQueuedTrack(id, reason, context.get('user'));
        captureServerEvent(context.get('user').id, 'queue_item_removed');
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ ok: true });
      },
    )
    .post(
      '/api/queue/:id/block',
      requireUser,

      zValidator('param', idParamSchema),
      requireRoomRole('mod', itemRoom),
      zValidator('json', blockMediaSchema),
      async (context) => {
        const { id } = context.req.valid('param');
        await blockQueueItemMedia(id, context.req.valid('json'), context.get('user'));
        captureServerEvent(context.get('user').id, 'media_blocked');
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ ok: true });
      },
    )
    .post(
      '/api/rooms/:slug/current/skip',
      requireRoomModerator,
      zValidator('json', removeQueueItemSchema),
      async (context) => {
        const { reason } = context.req.valid('json');
        await skipCurrentTrack(context.get('roomId'), reason, context.get('user'));
        captureServerEvent(context.get('user').id, 'track_skipped');
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ ok: true });
      },
    )
    .patch(
      '/api/rooms/:slug/settings',
      requireRoomOwner,
      zValidator('json', roomSettingsSchema),
      async (context) => {
        const patch = context.req.valid('json');
        await updateRoomSettings(context.get('roomId'), patch, context.get('user'));
        captureServerEvent(context.get('user').id, 'room_settings_changed', {
          fields: Object.keys(patch).join(','),
        });
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ ok: true });
      },
    )
    .get('/api/rooms/:slug/rules', inRoom, async (context) =>
      context.json({ rules: await listRules(context.get('roomId')) }),
    )
    .get(
      '/api/rules/:id/entries',
      requireUser,

      zValidator('param', idParamSchema),
      requireRoomRole('mod', ruleRoom),
      async (context) =>
        context.json({ entries: await listRuleEntries(context.req.valid('param').id) }),
    )
    // Blocking something before anyone requests it. It costs a provider lookup,
    // so it is limited like every other route that spends one.
    .post(
      '/api/rules/:id/entries',
      requireUser,

      zValidator('param', idParamSchema),
      requireRoomRole('mod', ruleRoom),
      limitPerUser('lookup', 20),
      zValidator('json', blockByUrlSchema),
      async (context) => {
        const { id } = context.req.valid('param');
        const { url, entryType, note } = context.req.valid('json');
        const blocked = await blockMediaByUrl(
          context.get('roomId'),
          url,
          { ruleIds: [id], entryType, note },
          context.get('user'),
        );
        captureServerEvent(context.get('user').id, 'media_blocked', {
          entry_type: entryType,
          source: 'link',
        });
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json(blocked, 201);
      },
    )
    .post(
      '/api/rooms/:slug/rules',
      requireRoomOwner,
      zValidator('json', ruleSchema),
      async (context) => {
        const id = await createRule(
          context.get('roomId'),
          context.req.valid('json'),
          context.get('user'),
        );
        captureServerEvent(context.get('user').id, 'rule_created');
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ id });
      },
    )
    .patch(
      '/api/rooms/:slug/rules/order',
      requireRoomOwner,
      zValidator('json', reorderSchema),
      async (context) => {
        await reorderRules(context.get('roomId'), context.req.valid('json').orderedIds);
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ ok: true });
      },
    )
    .patch(
      '/api/rules/:id',
      requireUser,

      zValidator('param', idParamSchema),
      requireRoomRole('owner', ruleRoom),
      zValidator('json', ruleUpdateSchema),
      async (context) => {
        await updateRule(context.req.valid('param').id, context.req.valid('json'));
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ ok: true });
      },
    )
    .delete(
      '/api/rules/:id',
      requireUser,

      zValidator('param', idParamSchema),
      requireRoomRole('owner', ruleRoom),
      async (context) => {
        await deleteRule(context.req.valid('param').id);
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ ok: true });
      },
    )
    .delete(
      '/api/rules/entries/:id',
      requireUser,

      zValidator('param', idParamSchema),
      requireRoomRole('mod', ruleEntryRoom),
      async (context) => {
        await removeRuleEntry(context.req.valid('param').id);
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ ok: true });
      },
    )
    .post('/api/me/chat-check', requireUser, limitPerUser('chat-check', 5), async (context) => {
      const user = context.get('user');
      const result = await requestChatCheck({ id: user.id, username: user.username });
      captureServerEvent(user.id, 'chat_check_requested');
      dependencies.onRoomChanged();
      return context.json(result);
    })
    // Taking the room's data out of it. A browser downloads these by navigating
    // to them, so they are a plain GET with the session cookie rather than a
    // fetch, and the whole answer is one response.
    // Topping the archive up from the room QueUp still runs. It reads a handful
    // of pages and stops where the archive and the live room meet, so it is
    // quick, and it is limited because it reaches somebody else's API.
    .post(
      '/api/archive/refresh',
      requireAdmin,
      limitPerUser('archive-refresh', 4),
      zValidator('json', archiveRefreshSchema),
      async (context) => {
        const refreshed = await refreshArchive(context.req.valid('json').room);
        captureServerEvent(context.get('user').id, 'archive_refreshed', {
          added: refreshed.added,
          pages_read: refreshed.pagesRead,
        });
        dependencies.onRoomChanged();
        return context.json(refreshed);
      },
    )
    .get('/api/exports', requireAdmin, (context) => context.json({ exports: EXPORTS }))
    .get(
      '/api/exports/:dataset',
      requireAdmin,
      limitPerUser('export', 10),
      zValidator('param', exportParamSchema),
      async (context) => {
        const { dataset } = context.req.valid('param');
        const csv = await exportCsv(dataset);
        captureServerEvent(context.get('user').id, 'data_exported', {
          dataset,
          bytes: Buffer.byteLength(csv),
        });
        return new Response(csv, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${exportFilename(dataset)}"`,
          },
        });
      },
    )
    .get('/api/moderation', requireAdmin, async (context) => context.json(await getModerationLog()))
    .get('/api/operations', requireAdmin, async (context) =>
      context.json({
        ...dependencies.operationsSnapshot(),
        storage: await getStorageSnapshot(),
      }),
    )
    .get('/api/rooms/:slug/stream-watch', requireRoomOwner, async (context) =>
      context.json(await watchTracker.status(context.get('roomId'))),
    )
    // An owner's saved overlay look. It belongs to them rather than to the
    // room: the overlay's URL names the room, and the look travels with them.
    .get('/api/rooms/:slug/watcher-embed', requireRoomOwner, async (context) => {
      context.header('Cache-Control', 'no-store, max-age=0');
      return context.json(await getOrCreateWatcherEmbedSettings(context.get('user').id));
    })
    .patch(
      '/api/rooms/:slug/watcher-embed',
      requireRoomOwner,
      zValidator('json', watcherEmbedSchema),
      async (context) => {
        const patch = context.req.valid('json');
        const settings = await updateWatcherEmbedSettings(context.get('user').id, patch);
        captureServerEvent(context.get('user').id, 'watcher_embed_settings_changed', {
          fields: Object.keys(patch).join(','),
        });
        return context.json(settings);
      },
    )
    .patch(
      '/api/rooms/:slug/stream-watch',
      requireRoomOwner,
      zValidator('json', streamWatchSchema),
      async (context) => {
        const settings = await updateStreamWatchSettings(
          context.get('roomId'),
          context.req.valid('json'),
          context.get('user').id,
        );
        await watchTracker.refresh();
        captureServerEvent(context.get('user').id, 'stream_watch_changed', {
          enabled: settings.enabled,
          platform: settings.platform,
        });
        return context.json(await watchTracker.status(context.get('roomId')));
      },
    )
    .get('/api/rooms/:slug/regions', requireRoomOwner, async (context) =>
      context.json({ regions: await listPlaybackRegions() }),
    )
    .get('/api/admins', requireAdmin, async (context) => context.json({ admins: await listAdmins() }))
    .get('/api/users', requireAdmin, async (context) =>
      context.json({ users: await listUsers(context.req.query('search')?.trim() || undefined) }),
    )
    .patch(
      '/api/users/:id/role',
      requireAdmin,
      zValidator('param', idParamSchema),
      zValidator('json', userRoleSchema),
      async (context) => {
        await setUserRole(context.req.valid('param').id, context.req.valid('json').role);
        captureServerEvent(context.get('user').id, 'user_role_changed');
        return context.json({ ok: true });
      },
    )
    // The whitelist of who may create a room. Only a site admin keeps it.
    .patch(
      '/api/users/:id/room-creator',
      requireAdmin,
      zValidator('param', idParamSchema),
      zValidator('json', roomCreatorSchema),
      async (context) => {
        await setRoomCreator(
          context.req.valid('param').id,
          context.req.valid('json').canCreateRooms,
        );
        captureServerEvent(context.get('user').id, 'room_creator_changed');
        return context.json({ ok: true });
      },
    )
    .put(
      '/api/rooms/:slug/moderators/:id',
      requireUser,

      zValidator('param', roomMemberParamSchema),
      requireRoomOwner,
      zValidator('json', roomModeratorSchema),
      async (context) => {
        await setRoomModerator(
          context.get('roomId'),
          context.req.valid('param').id,
          context.req.valid('json').moderator,
          context.get('user'),
        );
        captureServerEvent(context.get('user').id, 'room_moderator_changed');
        dependencies.onRoomChanged(context.get('roomId'));
        return context.json({ ok: true });
      },
    );

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
