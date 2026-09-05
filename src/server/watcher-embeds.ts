import { eq } from 'drizzle-orm';
import type { WatcherEmbedOptions, WatcherEmbedSettings } from '../shared/contracts';
import { getDatabase, type Database } from './db/client';
import { watcherEmbedSettings } from './db/schema';

type WatcherEmbedUpdate = Partial<WatcherEmbedOptions>;

function toSettings(
  row: typeof watcherEmbedSettings.$inferSelect,
): WatcherEmbedSettings {
  return {
    ownerId: row.ownerUserId,
    show: row.show,
    window: row.windowMinutes,
    max: row.maxWatchers,
    layout: row.layout,
    names: row.names,
    enter: row.entrance,
    motion: row.motion,
    color: row.color,
    speed: row.speedPercent,
    size: row.sizePercent,
    roam: row.roamPercent,
    inset: row.insetPercent,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Creates an admin's stable source the first time they open the OBS tab. */
export async function getOrCreateWatcherEmbedSettings(
  ownerUserId: string,
  db: Database = getDatabase(),
): Promise<WatcherEmbedSettings> {
  await db.insert(watcherEmbedSettings).values({ ownerUserId }).onConflictDoNothing();
  const [row] = await db
    .select()
    .from(watcherEmbedSettings)
    .where(eq(watcherEmbedSettings.ownerUserId, ownerUserId));
  return toSettings(row);
}

/** Public read for an OBS source. Unknown ids do not create database rows. */
export async function findWatcherEmbedSettings(
  ownerUserId: string,
  db: Database = getDatabase(),
): Promise<WatcherEmbedSettings | null> {
  const [row] = await db
    .select()
    .from(watcherEmbedSettings)
    .where(eq(watcherEmbedSettings.ownerUserId, ownerUserId))
    .limit(1);
  return row ? toSettings(row) : null;
}

export async function updateWatcherEmbedSettings(
  ownerUserId: string,
  update: WatcherEmbedUpdate,
  db: Database = getDatabase(),
): Promise<WatcherEmbedSettings> {
  await getOrCreateWatcherEmbedSettings(ownerUserId, db);
  await db
    .update(watcherEmbedSettings)
    .set({
      ...(update.show === undefined ? {} : { show: update.show }),
      ...(update.window === undefined ? {} : { windowMinutes: update.window }),
      ...(update.max === undefined ? {} : { maxWatchers: update.max }),
      ...(update.layout === undefined ? {} : { layout: update.layout }),
      ...(update.names === undefined ? {} : { names: update.names }),
      ...(update.enter === undefined ? {} : { entrance: update.enter }),
      ...(update.motion === undefined ? {} : { motion: update.motion }),
      ...(update.color === undefined ? {} : { color: update.color }),
      ...(update.speed === undefined ? {} : { speedPercent: update.speed }),
      ...(update.size === undefined ? {} : { sizePercent: update.size }),
      ...(update.roam === undefined ? {} : { roamPercent: update.roam }),
      ...(update.inset === undefined ? {} : { insetPercent: update.inset }),
      updatedAt: new Date(),
    })
    .where(eq(watcherEmbedSettings.ownerUserId, ownerUserId));
  return getOrCreateWatcherEmbedSettings(ownerUserId, db);
}
