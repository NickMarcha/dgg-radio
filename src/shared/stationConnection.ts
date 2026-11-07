import { z } from 'zod';

export const embedConnectionKinds = [
  'embed-player',
  'embed-playing',
  'embed-queue',
  'embed-watchers',
] as const;
export type EmbedConnectionKind = (typeof embedConnectionKinds)[number];
export type ConnectionKind = 'station' | EmbedConnectionKind;
export const visitorIdSchema = z.uuid();

/** A station's name in its URL. The main station is `main`. */
export const stationSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/);
export const MAIN_STATION_SLUG = 'main';

export const stationConnectionRequestSchema = z.union([
  z.object({ kind: z.literal('station'), station: stationSlugSchema, visitorId: visitorIdSchema }),
  z.object({ kind: z.enum(embedConnectionKinds), station: stationSlugSchema }),
]);

export type StationConnectionRequest = z.infer<typeof stationConnectionRequestSchema>;
