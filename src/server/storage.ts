import { sql } from 'drizzle-orm';
import { getDatabase, type Database } from './db/client';
import type { StorageGroup, StorageSnapshot } from '../shared/contracts';

/**
 * Playlist items point at shared `media` rows, so the catalogue is measured on
 * its own. Counting that metadata once per saved track would make personal
 * playlists look far larger than the space they actually take.
 *
 * Tables are named without a schema unless they live outside `public`.
 */
const GROUPS: { name: string; tables: string[] }[] = [
  { name: 'History and voting', tables: ['queue_items', 'votes'] },
  // Tens of thousands of rows from a room that ran for two years elsewhere, and
  // by some distance the largest table here. Measured on its own so the total
  // it accounts for is obvious rather than hidden inside the room's own history.
  { name: 'QueUp archive', tables: ['legacy_plays'] },
  // The second largest, and on its own for the same reason: it labels both
  // histories rather than belonging to either, so filing it under the archive
  // or the catalogue would hide a quarter of the database inside a total that
  // is about something else.
  { name: 'Genre labels', tables: ['track_genres'] },
  { name: 'Personal playlists', tables: ['playlists', 'playlist_items'] },
  {
    name: 'Track catalogue and provider cache',
    tables: ['media', 'media_lookups', 'playback_regions'],
  },
  {
    name: 'Accounts and authentication',
    tables: ['users', 'sessions', 'oauth_login_transactions', 'user_chat_counts'],
  },
  { name: 'Rules and moderation', tables: ['rules', 'rule_entries', 'moderation_actions'] },
  // The one group that grows on its own. A row a minute for every embed the
  // site lists, whatever anybody does in the room, so it is the table to watch
  // when this page is opened to ask why the database is bigger than it was.
  {
    name: 'Embed history and overlay',
    tables: [
      'stream_watch_samples',
      'stream_watch_channels',
      'stream_watch',
      'watcher_embed_settings',
    ],
  },
  {
    name: 'Room state and internal tables',
    tables: ['room_settings', 'room_state', 'seed_state', 'drizzle.__drizzle_migrations'],
  },
];

/**
 * Every table this page accounts for. Exported so a test can hold it against
 * the schema: the point of the figure at the bottom of the page is that what is
 * left over is PostgreSQL's own overhead, and a table nobody filed makes that
 * sentence a lie rather than an omission. Three features added tables without
 * touching this file before anybody noticed.
 */
export const STORAGE_TABLES = GROUPS.flatMap((group) => group.tables);

interface Measurement {
  rowCount: number;
  tableBytes: number;
  indexBytes: number;
  totalBytes: number;
}

const NOTHING: Measurement = { rowCount: 0, tableBytes: 0, indexBytes: 0, totalBytes: 0 };

function qualify(name: string): string {
  return name.includes('.') ? name : `public.${name}`;
}

/**
 * A snapshot of what the database occupies right now, taken when an admin opens
 * or refreshes the operations page. `pg_table_size` carries TOAST storage, so a
 * group's table and index bytes add up to its total.
 *
 * Row counts are PostgreSQL's own estimates rather than `count(*)`. There is no
 * stored row count to read: under MVCC, how many rows exist is a question about
 * the asking transaction's snapshot, so every exact count is a scan of the
 * whole table and no index removes that. This page is an indicator — it exists
 * to show when something is growing out of proportion — and nobody acts
 * differently on 48,182 than on 48,000, so it reads the estimate the statistics
 * planner already keeps and costs nothing. It is a few percent out, and further
 * out on a table written in bulk since it was last analysed.
 *
 * The estimate is `pg_class.reltuples` rather than
 * `pg_stat_user_tables.n_live_tup`, which was tried first and was wrong here.
 * `n_live_tup` is the statistics collector's running tally, and a restart had
 * reset it: the two tables the seeds fill and nothing writes to again read as
 * 0 and 36 rows beside 24 MB and 11 MB. `reltuples` lives in the catalogue,
 * survives a restart, and was within 0.2% of both.
 */
export async function getStorageSnapshot(db: Database = getDatabase()): Promise<StorageSnapshot> {
  const totals = await db.execute<{ database_bytes: string }>(
    sql`select pg_database_size(current_database())::bigint as database_bytes`,
  );
  const databaseBytes = Number(totals.rows[0]?.database_bytes ?? 0);

  // `to_regclass` returns null for a table this build does not have, which
  // keeps a renamed or dropped table out of the snapshot instead of failing it.
  const sizes = await db.execute<{
    qualified: string;
    row_count: string;
    table_bytes: string;
    index_bytes: string;
    total_bytes: string;
  }>(sql`
    select
      v.qualified,
      greatest(coalesce(cls.reltuples, 0), 0)::bigint as row_count,
      coalesce(pg_table_size(to_regclass(v.qualified)), 0)::bigint as table_bytes,
      coalesce(pg_indexes_size(to_regclass(v.qualified)), 0)::bigint as index_bytes,
      coalesce(pg_total_relation_size(to_regclass(v.qualified)), 0)::bigint as total_bytes
    from (values ${sql.join(
      STORAGE_TABLES.map((name) => sql`(${qualify(name)}::text)`),
      sql`, `,
    )}) as v(qualified)
    left join pg_class as cls on cls.oid = to_regclass(v.qualified)
  `);

  const measured = new Map<string, Measurement>();
  for (const row of sizes.rows) {
    measured.set(row.qualified, {
      rowCount: Number(row.row_count),
      tableBytes: Number(row.table_bytes),
      indexBytes: Number(row.index_bytes),
      totalBytes: Number(row.total_bytes),
    });
  }

  const groups: StorageGroup[] = GROUPS.map((group) => {
    const parts = group.tables.map((name) => measured.get(qualify(name)) ?? NOTHING);
    const total = (pick: keyof Measurement) => parts.reduce((sum, part) => sum + part[pick], 0);
    const totalBytes = total('totalBytes');
    return {
      name: group.name,
      tables: group.tables,
      rowCount: total('rowCount'),
      tableBytes: total('tableBytes'),
      indexBytes: total('indexBytes'),
      totalBytes,
      share: databaseBytes > 0 ? totalBytes / databaseBytes : 0,
    };
  });

  groups.sort((first, second) => second.totalBytes - first.totalBytes);
  return { databaseBytes, groups };
}
