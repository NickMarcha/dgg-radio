import { zValidator } from '@hono/zod-validator';
import { cors } from 'hono/cors';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import {
  blockMediaSchema,
  clearQueueSchema,
  playlistSchema,
  reorderSchema,
  searchSchema,
  removeQueueItemSchema,
  ruleSchema,
  ruleUpdateSchema,
  roomSettingsSchema,
  submitRequestSchema,
  userRoleSchema,
  voteSchema,
} from '../shared/contracts';
import {
  AuthenticationError,
  canModerate,
  clearSession,
  completeAuthorization,
  createAuthorizationUrl,
  getSessionUser,
  setSessionCookie,
  type AuthenticatedUser,
} from './auth';
import { captureServerEvent, captureServerException } from './analytics';
import {
  createRule,
  deleteRule,
  listRuleEntries,
  listRules,
  removeRuleEntry,
  reorderRules,
  RuleError,
  updateRule,
} from './rules';
import { listPlaybackRegions, RegionLookupError } from './regions';
import { AdminError, listAdmins, listUsers, setUserRole } from './admins';
import {
  CommunityError,
  getCommunityStats,
  getUserProfile,
  listHistory,
} from './community';
import { getEnv } from './env';
import { MediaLookupError, searchMedia } from './media';
import {
  blockQueueItemMedia,
  clearUserQueue,
  enqueueMedia,
  enqueuePlaylist,
  reorderMyQueue,
  reorderRoomQueue,
  getRoomSnapshot,
  removeQueuedTrack,
  RoomError,
  skipCurrentTrack,
  updateRoomSettings,
  voteOnCurrentTrack,
} from './room';

interface AppDependencies {
  listenerCount: () => number;
  onRoomChanged: () => void;
}

type Variables = {
  user: AuthenticatedUser;
};

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().length(64),
});

const idParamSchema = z.object({ id: z.uuid() });
const usernameParamSchema = z.object({ username: z.string().trim().min(1).max(64) });
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function createApp(dependencies: AppDependencies) {
  const env = getEnv();
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', secureHeaders());
  app.use(
    '/api/*',
    cors({
      origin: env.APP_ORIGIN,
      credentials: true,
      allowHeaders: ['Content-Type'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
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

  const requireModerator = async (context: any, next: () => Promise<void>) => {
    const user = await getSessionUser(context);
    if (!user) return context.json(errorBody('AUTH_REQUIRED', 'Sign in with Destiny to do that.'), 401);
    if (!canModerate(user.role)) {
      return context.json(errorBody('MODERATOR_REQUIRED', 'Only mods and admins can do that.'), 403);
    }
    context.set('user', user);
    await next();
  };

  app.onError((error, context) => {
    if (
      error instanceof RoomError ||
      error instanceof MediaLookupError ||
      error instanceof RuleError ||
      error instanceof AdminError ||
      error instanceof CommunityError ||
      error instanceof RegionLookupError
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
    .get('/health', (context) => context.json({ ok: true }))
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
    .get('/api/room', async (context) => {
      const user = await getSessionUser(context);
      return context.json(await getRoomSnapshot(user, dependencies.listenerCount()));
    })
    .get('/api/profiles/:username', zValidator('param', usernameParamSchema), async (context) =>
      context.json(await getUserProfile(context.req.valid('param').username)),
    )
    .get('/api/history', zValidator('query', historyQuerySchema), async (context) =>
      context.json({ history: await listHistory(context.req.valid('query').limit) }),
    )
    .get('/api/stats', async (context) => context.json(await getCommunityStats()))
    .post('/api/queue', requireUser, zValidator('json', submitRequestSchema), async (context) => {
      const { url } = context.req.valid('json');
      const queued = await enqueueMedia(url, context.get('user'));
      captureServerEvent(context.get('user').id, 'track_requested', {
        provider: queued.provider,
        duration_seconds: queued.durationSeconds,
      });
      dependencies.onRoomChanged();
      return context.json({ id: queued.id }, 201);
    })
    .post(
      '/api/queue/:id/vote',
      requireUser,
      zValidator('param', idParamSchema),
      zValidator('json', voteSchema),
      async (context) => {
        const { id } = context.req.valid('param');
        const { value } = context.req.valid('json');
        await voteOnCurrentTrack(id, value, context.get('user'), dependencies.listenerCount());
        captureServerEvent(context.get('user').id, 'track_vote_changed', {
          vote: value === 1 ? 'up' : value === -1 ? 'down' : 'cleared',
        });
        dependencies.onRoomChanged();
        return context.json({ ok: true });
      },
    )
    .get('/api/search', requireUser, zValidator('query', searchSchema), async (context) =>
      context.json({ results: await searchMedia(context.req.valid('query').q, 15) }),
    )
    .post('/api/queue/playlist', requireUser, zValidator('json', playlistSchema), async (context) => {
      const imported = await enqueuePlaylist(context.req.valid('json').url, context.get('user'));
      captureServerEvent(context.get('user').id, 'playlist_imported', {
        added: imported.added,
        skipped: imported.skipped.length,
      });
      dependencies.onRoomChanged();
      return context.json(imported);
    })
    .patch('/api/queue/order', requireUser, zValidator('json', reorderSchema), async (context) => {
      await reorderMyQueue(context.req.valid('json').orderedIds, context.get('user'));
      dependencies.onRoomChanged();
      return context.json({ ok: true });
    })
    .patch(
      '/api/queue/room-order',
      requireModerator,
      zValidator('json', reorderSchema),
      async (context) => {
        await reorderRoomQueue(context.req.valid('json').orderedIds, context.get('user'));
        captureServerEvent(context.get('user').id, 'room_queue_reordered');
        dependencies.onRoomChanged();
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
      requireAdmin,
      zValidator('param', idParamSchema),
      zValidator('json', removeQueueItemSchema),
      async (context) => {
        const { id } = context.req.valid('param');
        const { reason } = context.req.valid('json');
        await removeQueuedTrack(id, reason, context.get('user'));
        captureServerEvent(context.get('user').id, 'queue_item_removed');
        dependencies.onRoomChanged();
        return context.json({ ok: true });
      },
    )
    .post(
      '/api/queue/:id/block',
      requireModerator,
      zValidator('param', idParamSchema),
      zValidator('json', blockMediaSchema),
      async (context) => {
        const { id } = context.req.valid('param');
        await blockQueueItemMedia(id, context.req.valid('json'), context.get('user'));
        captureServerEvent(context.get('user').id, 'media_blocked');
        dependencies.onRoomChanged();
        return context.json({ ok: true });
      },
    )
    .post('/api/current/skip', requireModerator, zValidator('json', removeQueueItemSchema), async (context) => {
      const { reason } = context.req.valid('json');
      await skipCurrentTrack(reason, context.get('user'));
      captureServerEvent(context.get('user').id, 'track_skipped');
      dependencies.onRoomChanged();
      return context.json({ ok: true });
    })
    .patch('/api/settings', requireAdmin, zValidator('json', roomSettingsSchema), async (context) => {
      const patch = context.req.valid('json');
      await updateRoomSettings(patch, context.get('user'));
      captureServerEvent(context.get('user').id, 'room_settings_changed', {
        fields: Object.keys(patch).join(','),
      });
      dependencies.onRoomChanged();
      return context.json({ ok: true });
    })
    .get('/api/rules', async (context) => context.json({ rules: await listRules() }))
    .get('/api/rules/:id/entries', requireAdmin, zValidator('param', idParamSchema), async (context) =>
      context.json({ entries: await listRuleEntries(context.req.valid('param').id) }),
    )
    .post('/api/rules', requireAdmin, zValidator('json', ruleSchema), async (context) => {
      const id = await createRule(context.req.valid('json'), context.get('user'));
      captureServerEvent(context.get('user').id, 'rule_created');
      dependencies.onRoomChanged();
      return context.json({ id });
    })
    .patch('/api/rules/order', requireAdmin, zValidator('json', reorderSchema), async (context) => {
      await reorderRules(context.req.valid('json').orderedIds);
      dependencies.onRoomChanged();
      return context.json({ ok: true });
    })
    .patch(
      '/api/rules/:id',
      requireAdmin,
      zValidator('param', idParamSchema),
      zValidator('json', ruleUpdateSchema),
      async (context) => {
        await updateRule(context.req.valid('param').id, context.req.valid('json'));
        dependencies.onRoomChanged();
        return context.json({ ok: true });
      },
    )
    .delete('/api/rules/:id', requireAdmin, zValidator('param', idParamSchema), async (context) => {
      await deleteRule(context.req.valid('param').id);
      dependencies.onRoomChanged();
      return context.json({ ok: true });
    })
    .delete(
      '/api/rules/entries/:id',
      requireAdmin,
      zValidator('param', idParamSchema),
      async (context) => {
        await removeRuleEntry(context.req.valid('param').id);
        dependencies.onRoomChanged();
        return context.json({ ok: true });
      },
    )
    .get('/api/regions', requireAdmin, async (context) =>
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
    );

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
