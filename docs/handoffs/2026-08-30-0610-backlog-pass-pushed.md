# Seven slices shipped in one pass

## What went out

One commit, closing six items from `docs/backlog.md`. Every slice was tested
locally and accepted by the user, in this order:

1. Profile history can save tracks to personal playlists.
2. The phone layouts for the room, community pages, and account header.
3. Distinct listener counting and the corrected ratio-skip denominator.
4. The admin server-activity snapshot.
5. The admin panel split into tabs.
6. Database storage on the server tab.
7. A per-listener notice when the room drops a pending request.

`docs/backlog.md` lost the six shipped items and gained one short follow-up for
what the storage slice deliberately left out.

## Profile history and profile routes

`CommunityPage` uses the existing playlist library and `SaveToPlaylistButton`
on profile history rows, for a signed-in viewer only, matching the history
page.

The static Astro build emits `/profile/index.html`. `src/middleware.ts` rewrites
`/profile/:username` to that page, and `CommunityPage` reads the path when it
chooses the profile username, so direct navigation no longer 404s.

## Listener identity and voting

`ConnectionRegistry` replaced the raw WebSocket set. It keeps every socket for
broadcasts but counts room identities rather than sockets:

- Multiple room tabs for one signed-in user count once.
- Anonymous room tabs share a browser UUID in local storage and count once per
  browser.
- `/embed/player`, `/embed/playing` and `/embed/queue` sockets count as zero.
- Distinct signed-in room users are the only denominator for ratio skips.

The WebSocket URL declares `kind`, and room sockets send a visitor UUID. The
API rejects the old unlabelled handshake rather than carrying a compatibility
path.

## The admin panel is four tabs

`/admin` is Room (settings and rules), People, Server, and OBS. `tabFromHash`
reads the open tab from the URL hash, so `/admin#server` is linkable and the
back button walks the tabs. The hash is read in an effect rather than a
`useState` initializer, because `client:load` prerenders the page and reading
`window` at init would mismatch on hydration.

`RulesSection` and `PeopleSection` came out of the top-level component.
`RulesSection` took the `entries` state, `moveRule` and `toggleEntries` with it;
`search` stayed at the top level because `refresh` depends on it.

The server snapshot is fetched when the Server tab first opens, not on mount, so
the other tabs never pay for it.

## Server activity and database storage

`GET /api/operations` is admin-only and returns:

- Open socket, distinct listener and eligible voter counts.
- Every open connection's source, signed-in username when known, and connection
  time.
- API process start time, and room-clock checks, advances and last timestamps.
  These reset when the API process restarts.
- A storage snapshot from `src/server/storage.ts`.

The storage module runs three queries: `pg_database_size`, then per-table
`pg_table_size` / `pg_indexes_size` / `pg_total_relation_size`, then exact
`count(*)` per table. Two decisions worth keeping:

- `pg_table_size` rather than `pg_relation_size`, so TOAST is counted and a
  group's table plus index bytes equal its total exactly. A test asserts it.
- Every table is resolved through `to_regclass`, so a table this build does not
  have contributes zero instead of failing the snapshot. That is also how
  `drizzle.__drizzle_migrations` is measured in its own schema.

The card labels the figure honestly: it covers PostgreSQL's own tables and
indexes only, not WAL, fixed files, container logs, free disk, or backups, of
which there are none. A closing line reports what share the groups actually
account for, because the rest is PostgreSQL's catalogues rather than something
missing.

## Listener notices

`queue_items.listener_notice` is a message written for the requester. It is
deliberately a separate column from `moderation_reason`, which is the internal
log and can hold a moderator's private note: the two must never be the same
field, or a mod's note would reach the person it is about.

Only the automatic playback check writes it, in `startNextTrack`, using the
`RoomError` message the check already produces for a listener to read. The room
snapshot carries `myNotices` for the signed-in viewer, the room shows them above
"Your queue", and `DELETE /api/queue/:id/notice` clears the column, which is how
a notice is marked read. That route does not broadcast a room change, because a
notice belongs to one person.

Migration `0015_omniscient_puppet_master.sql` adds the column and a partial
index on the requester where the notice is not null, since the query runs on
every room poll for every signed-in listener.

## Verification

- `npm run check`: 0 errors, 0 warnings, 0 hints.
- Full Vitest with `TEST_DATABASE_URL` on `dgg_radio_test`: 192 passed, 0
  skipped.
- `npm run build`: Astro and API builds pass.
- `git diff --check`: clean apart from Git's existing LF-to-CRLF warnings.
- Local API rebuilt with `npm run stack:test` and checked through the real UI.

Running `npm test` without `TEST_DATABASE_URL` silently skips the Postgres
suites. The working command takes the compose password from `.env`, points at
`127.0.0.1:54329`, and names the database `dgg_radio_test`.

## What is next

`docs/backlog.md` has five items left. Only two are work anyone can start now:

- PostHog is wired up but never reviewed. The largest remaining piece, and it
  wants a session of its own.
- Saved PostHog queries may still name `YOUTUBE_BLOCKED_IN_UAE`. Five minutes,
  but inside PostHog rather than in this repository.

Two more are waiting on the world: a real destiny.gg moderator signing in, and
somebody actually hitting the fifty-track playlist limit. The fifth records what
the storage card still cannot show.
