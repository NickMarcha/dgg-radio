import { and, asc, eq, sql } from 'drizzle-orm';
import type { OwnedStation, StationListing, StationModerator, StationRole } from '../shared/contracts';
import type { AuthenticatedUser } from './auth';
import { getDatabase, type Database } from './db/client';
import {
  media,
  queueItems,
  stationMembers,
  stations,
  stationSeats,
  stationSettings,
  stationState,
  streamWatch,
  users,
} from './db/schema';

/**
 * The station at `/`. Its id is fixed by the migration that created `stations`, so
 * the main station can be named without a lookup.
 */
export const MAIN_STATION_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Whether the QueUp archive counts toward a station's numbers. It is the main
 * station's own past, so it counts there and for the whole site (null), and
 * nowhere else.
 */
export function archiveCountsFor(stationId: string | null): boolean {
  return stationId === null || stationId === MAIN_STATION_ID;
}

/** Either the pool or an open transaction on it. */
type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export class StationAccessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'StationAccessError';
  }
}

/**
 * What a user may do in a station. A site admin acts as an owner everywhere,
 * without a membership row, so the station cannot be locked away from them.
 */
export async function stationRoleOf(
  user: Pick<AuthenticatedUser, 'id' | 'role'> | null,
  stationId: string,
  db: Database = getDatabase(),
): Promise<StationRole | null> {
  if (!user) return null;
  if (user.role === 'admin') return 'owner';
  const [member] = await db
    .select({ role: stationMembers.role })
    .from(stationMembers)
    .where(and(eq(stationMembers.stationId, stationId), eq(stationMembers.userId, user.id)));
  return member?.role ?? null;
}

/** Owners and mods both moderate. */
export function canModerateStation(role: StationRole | null): boolean {
  return role !== null;
}

/** Only an owner changes the station itself, its rules, and who moderates it. */
export function canManageStation(role: StationRole | null): boolean {
  return role === 'owner';
}

/** A station by its slug, with what a page needs to name it, or null. */
export async function findStationBySlug(
  slug: string,
  db: Database = getDatabase(),
): Promise<{ id: string; slug: string; name: string } | null> {
  const [station] = await db
    .select({ id: stations.id, slug: stations.slug, name: stations.name })
    .from(stations)
    .where(eq(stations.slug, slug.toLowerCase()));
  return station ?? null;
}

export async function findStationIdBySlug(
  slug: string,
  db: Database = getDatabase(),
): Promise<string | null> {
  const [station] = await db
    .select({ id: stations.id })
    .from(stations)
    .where(eq(stations.slug, slug.toLowerCase()));
  return station?.id ?? null;
}

/** The station someone is tuned to, or the main one when they have never tuned anywhere. */
export async function tunedStationOf(
  user: Pick<AuthenticatedUser, 'id'>,
  db: Database = getDatabase(),
): Promise<OwnedStation> {
  const [row] = await db
    .select({ slug: stations.slug, name: stations.name })
    .from(users)
    .innerJoin(
      stations,
      eq(stations.id, sql`coalesce(${users.tunedStationId}, ${MAIN_STATION_ID}::uuid)`),
    )
    .where(eq(users.id, user.id));
  return row ?? { slug: 'main', name: 'DGG Radio' };
}

/**
 * Tunes someone to a station without moving anything. Refused while they have
 * tracks waiting somewhere else: those have to move with them, which is the
 * queue move's job, so they are never tuned to one station and queued in
 * another.
 */
export async function tuneIn(
  stationId: string,
  user: Pick<AuthenticatedUser, 'id'>,
  db: Database = getDatabase(),
): Promise<void> {
  const [seat] = await db
    .select({ stationId: stationSeats.stationId })
    .from(stationSeats)
    .where(eq(stationSeats.userId, user.id));
  if (seat && seat.stationId !== stationId) {
    throw new StationAccessError(
      'QUEUED_ELSEWHERE',
      'You have tracks waiting in another station. Move them to tune in here.',
      409,
    );
  }
  await db.update(users).set({ tunedStationId: stationId }).where(eq(users.id, user.id));
}

/**
 * How many stations one person may own. The schema allows any number; this is the
 * only thing to change when owners may run more than one.
 */
export const MAX_STATIONS_PER_OWNER = 1;

/** Taken by the station at `/`, so nobody else can claim it. */
const RESERVED_SLUGS = new Set(['main']);

/** Every station, the main one first and the rest by age, with what each is playing. */
export async function listStations(
  db: Database = getDatabase(),
): Promise<(Omit<StationListing, 'listenerCount'> & { id: string })[]> {
  const rows = await db
    .select({
      id: stations.id,
      slug: stations.slug,
      name: stations.name,
      onAir: stationState.onAir,
      title: media.title,
      artist: media.artist,
    })
    .from(stations)
    .leftJoin(stationState, eq(stationState.stationId, stations.id))
    .leftJoin(queueItems, eq(queueItems.id, stationState.currentQueueItemId))
    .leftJoin(media, eq(media.id, queueItems.mediaId))
    .orderBy(sql`${stations.id} <> ${MAIN_STATION_ID}`, asc(stations.createdAt));
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    // A station whose state row is not written yet has never been taken off air.
    onAir: row.onAir ?? true,
    nowPlaying: row.title === null ? null : { title: row.title, artist: row.artist ?? '' },
  }));
}

/** The stations a user owns, for the header to link them to. */
export async function ownedStations(
  userId: string,
  db: Executor = getDatabase(),
): Promise<OwnedStation[]> {
  return db
    .select({ slug: stations.slug, name: stations.name })
    .from(stationMembers)
    .innerJoin(stations, eq(stations.id, stationMembers.stationId))
    .where(and(eq(stationMembers.userId, userId), eq(stationMembers.role, 'owner')))
    .orderBy(asc(stations.createdAt));
}

/** What the header needs to offer someone a station: the ones they own, and whether they may make one. */
export async function stationAccessOf(
  user: Pick<AuthenticatedUser, 'id' | 'role'>,
  db: Database = getDatabase(),
): Promise<{ owned: OwnedStation[]; canCreate: boolean }> {
  const [row] = await db
    .select({ canCreateStations: users.canCreateStations })
    .from(users)
    .where(eq(users.id, user.id));
  const owned = await ownedStations(user.id, db);
  const allowed = user.role === 'admin' || Boolean(row?.canCreateStations);
  return { owned, canCreate: allowed && owned.length < MAX_STATIONS_PER_OWNER };
}

/**
 * A new station, owned by whoever made it. Only someone a site admin has
 * whitelisted may, and only up to `MAX_STATIONS_PER_OWNER`. The station starts with
 * the default settings, no rules, and no stream.
 */
export async function createStation(
  input: { slug: string; name: string },
  owner: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<OwnedStation> {
  const slug = input.slug.trim().toLowerCase();
  const name = input.name.trim();
  if (RESERVED_SLUGS.has(slug)) {
    throw new StationAccessError('STATION_EXISTS', 'That name is taken.', 409);
  }

  return db.transaction(async (transaction) => {
    const [creator] = await transaction
      .select({ canCreateStations: users.canCreateStations })
      .from(users)
      .where(eq(users.id, owner.id));
    if (!creator?.canCreateStations && owner.role !== 'admin') {
      throw new StationAccessError(
        'STATION_CREATOR_REQUIRED',
        'Creating a station needs a site admin to allow it first.',
        403,
      );
    }
    // Serialised per owner, so two tabs cannot both slip under the limit.
    const lockKey = `station-owner:${owner.id}`;
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    if ((await ownedStations(owner.id, transaction)).length >= MAX_STATIONS_PER_OWNER) {
      throw new StationAccessError('STATION_LIMIT', 'You already own a station.', 409);
    }

    const [station] = await transaction
      .insert(stations)
      .values({ slug, name })
      .onConflictDoNothing()
      .returning({ id: stations.id, slug: stations.slug, name: stations.name });
    if (!station) throw new StationAccessError('STATION_EXISTS', 'That name is taken.', 409);

    await transaction.insert(stationSettings).values({ stationId: station.id });
    await transaction.insert(stationState).values({ stationId: station.id });
    await transaction.insert(streamWatch).values({ stationId: station.id });
    await transaction
      .insert(stationMembers)
      .values({ stationId: station.id, userId: owner.id, role: 'owner', addedByUserId: owner.id });
    // A new owner is tuned in to their station, so a playlist queued straight
    // after creating it lands there. Not while tracks wait somewhere else:
    // those would have to move, and that is theirs to choose.
    const [seat] = await transaction
      .select({ stationId: stationSeats.stationId })
      .from(stationSeats)
      .where(eq(stationSeats.userId, owner.id));
    if (!seat) {
      await transaction
        .update(users)
        .set({ tunedStationId: station.id })
        .where(eq(users.id, owner.id));
    }
    return { slug: station.slug, name: station.name };
  });
}

/** Who runs a station, owners first. */
export async function listStationModerators(
  stationId: string,
  db: Database = getDatabase(),
): Promise<StationModerator[]> {
  return db
    .select({ id: users.id, username: users.username, role: stationMembers.role })
    .from(stationMembers)
    .innerJoin(users, eq(users.id, stationMembers.userId))
    .where(eq(stationMembers.stationId, stationId))
    .orderBy(asc(stationMembers.role), asc(users.username));
}

/**
 * Adds or removes one of a station's moderators. An owner's row is left alone:
 * ownership changes hands some other way, never by unticking a box.
 */
export async function setStationModerator(
  stationId: string,
  username: string,
  moderator: boolean,
  actor: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  // Somebody becomes known to the station by signing in once, so a name nobody
  // has signed in with yet cannot be made a moderator.
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username.trim()})`)
    .limit(1);
  if (!target) {
    throw new StationAccessError(
      'USER_NOT_FOUND',
      'Nobody by that name has signed in to the radio yet.',
      404,
    );
  }
  const userId = target.id;

  const [current] = await db
    .select({ role: stationMembers.role })
    .from(stationMembers)
    .where(and(eq(stationMembers.stationId, stationId), eq(stationMembers.userId, userId)));
  if (current?.role === 'owner') {
    throw new StationAccessError('STATION_OWNER', 'That user owns this station.', 409);
  }

  if (moderator) {
    await db
      .insert(stationMembers)
      .values({ stationId, userId, role: 'mod', addedByUserId: actor.id })
      .onConflictDoNothing();
  } else {
    await db
      .delete(stationMembers)
      .where(and(eq(stationMembers.stationId, stationId), eq(stationMembers.userId, userId)));
  }
}
