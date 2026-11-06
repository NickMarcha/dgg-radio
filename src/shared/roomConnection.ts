import { z } from 'zod';

export const embedConnectionKinds = [
  'embed-player',
  'embed-playing',
  'embed-queue',
  'embed-watchers',
] as const;
export type EmbedConnectionKind = (typeof embedConnectionKinds)[number];
export type ConnectionKind = 'room' | EmbedConnectionKind;
export const visitorIdSchema = z.uuid();

/** A room's name in its URL. The main room is `main`. */
export const roomSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/);
export const MAIN_ROOM_SLUG = 'main';

export const roomConnectionRequestSchema = z.union([
  z.object({ kind: z.literal('room'), room: roomSlugSchema, visitorId: visitorIdSchema }),
  z.object({ kind: z.enum(embedConnectionKinds), room: roomSlugSchema }),
]);

export type RoomConnectionRequest = z.infer<typeof roomConnectionRequestSchema>;
