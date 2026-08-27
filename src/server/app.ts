import { zValidator } from '@hono/zod-validator';
import { cors } from 'hono/cors';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import {
  blockMediaSchema,
  removeQueueItemSchema,
  roomSettingsSchema,
  submitRequestSchema,
  voteSchema,
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
import { captureServerEvent, captureServerException } from './analytics';
import { getEnv } from './env';
import { MediaLookupError } from './media';
import {
  blockQueueItemMedia,
  enqueueMedia,
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

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().length(64),
});

const idParamSchema = z.object({ id: z.uuid() });

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
      allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
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
      return context.json(errorBody('ADMIN_REQUIRED', 'Room controls are limited to moderators.'), 403);
    }
    context.set('user', user);
    await next();
  };

  app.onError((error, context) => {
    if (error instanceof RoomError || error instanceof MediaLookupError) {
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
    .get('/api/auth/callback', zValidator('query', callbackQuerySchema), async (context) => {
      const { code, state } = context.req.valid('query');
      const session = await completeAuthorization(code, state);
      setSessionCookie(context, session.sessionToken, session.expiresAt);
      captureServerEvent(session.userId, 'user_signed_in');
      return context.redirect(env.APP_ORIGIN);
    })
    .post('/api/auth/logout', async (context) => {
      await clearSession(context);
      return context.json({ ok: true });
    })
    .get('/api/room', async (context) => {
      const user = await getSessionUser(context);
      return context.json(await getRoomSnapshot(user, dependencies.listenerCount()));
    })
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
        await voteOnCurrentTrack(id, value, context.get('user'));
        captureServerEvent(context.get('user').id, 'track_vote_changed', {
          vote: value === 1 ? 'up' : value === -1 ? 'down' : 'cleared',
        });
        dependencies.onRoomChanged();
        return context.json({ ok: true });
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
      requireAdmin,
      zValidator('param', idParamSchema),
      zValidator('json', blockMediaSchema),
      async (context) => {
        const { id } = context.req.valid('param');
        const { reason } = context.req.valid('json');
        await blockQueueItemMedia(id, reason, context.get('user'));
        captureServerEvent(context.get('user').id, 'media_blocked');
        dependencies.onRoomChanged();
        return context.json({ ok: true });
      },
    )
    .post('/api/current/skip', requireAdmin, zValidator('json', removeQueueItemSchema), async (context) => {
      const { reason } = context.req.valid('json');
      await skipCurrentTrack(reason, context.get('user'));
      captureServerEvent(context.get('user').id, 'track_skipped');
      dependencies.onRoomChanged();
      return context.json({ ok: true });
    })
    .patch('/api/settings', requireAdmin, zValidator('json', roomSettingsSchema), async (context) => {
      const { maxDurationSeconds } = context.req.valid('json');
      await updateRoomSettings(maxDurationSeconds, context.get('user'));
      captureServerEvent(context.get('user').id, 'room_settings_changed', {
        max_duration_seconds: maxDurationSeconds,
      });
      dependencies.onRoomChanged();
      return context.json({ ok: true });
    });

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
