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
  {
    name: 'Room state and internal tables',
    tables: ['room_settings', 'room_state', 'drizzle.__drizzle_migrations'],
  },
];

const TABLES = GROUPS.flatMap((group) => group.tables);

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

function identifier(name: string) {
  const [schema, table] = qualify(name).split('.');
  return sql`${sql.identifier(schema)}.${sql.identifier(table)}`;
}

/**
 * A snapshot of what the database occupies right now, taken when an admin opens
 * or refreshes the operations page. `pg_table_size` carries TOAST storage, so a
 * group's table and index bytes add up to its total.
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
    present: boolean;
    table_bytes: string;
    index_bytes: string;
    total_bytes: string;
  }>(sql`
    select
      v.qualified,
      to_regclass(v.qualified) is not null as present,
      coalesce(pg_table_size(to_regclass(v.qualified)), 0)::bigint as table_bytes,
      coalesce(pg_indexes_size(to_regclass(v.qualified)), 0)::bigint as index_bytes,
      coalesce(pg_total_relation_size(to_regclass(v.qualified)), 0)::bigint as total_bytes
    from (values ${sql.join(
      TABLES.map((name) => sql`(${qualify(name)}::text)`),
      sql`, `,
    )}) as v(qualified)
  `);

  const present = TABLES.filter((name) =>
    sizes.rows.some((row) => row.qualified === qualify(name) && row.present),
  );
  const counts = present.length
    ? await db.execute<{ qualified: string; row_count: string }>(
        sql.join(
          present.map(
            (name) =>
              sql`select ${qualify(name)}::text as qualified, count(*)::bigint as row_count from ${identifier(name)}`,
          ),
          sql` union all `,
        ),
      )
    : { rows: [] };

  const measured = new Map<string, Measurement>();
  for (const row of sizes.rows) {
    measured.set(row.qualified, {
      rowCount: 0,
      tableBytes: Number(row.table_bytes),
      indexBytes: Number(row.index_bytes),
      totalBytes: Number(row.total_bytes),
    });
  }
  for (const row of counts.rows) {
    const measurement = measured.get(row.qualified);
    if (measurement) measurement.rowCount = Number(row.row_count);
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
