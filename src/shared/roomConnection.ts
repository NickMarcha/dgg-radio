import { z } from 'zod';

export const embedConnectionKinds = ['embed-player', 'embed-playing', 'embed-queue'] as const;
export type EmbedConnectionKind = (typeof embedConnectionKinds)[number];
export type ConnectionKind = 'room' | EmbedConnectionKind;
export const visitorIdSchema = z.uuid();

export const roomConnectionRequestSchema = z.union([
  z.object({ kind: z.literal('room'), visitorId: visitorIdSchema }),
  z.object({ kind: z.enum(embedConnectionKinds) }),
]);

export type RoomConnectionRequest = z.infer<typeof roomConnectionRequestSchema>;
