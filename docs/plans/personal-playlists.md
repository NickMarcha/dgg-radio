# Personal playlists plan

Status: implemented. Kept as the record of the decisions behind the feature.

## Outcome

Signed-in listeners can keep private, ordered playlists of tracks that have
already appeared in DGG Radio. They can save the current track or a track from
history, queue one saved track, or append a whole saved playlist to their own
queue.

Saving and queueing have different policy boundaries:

```text
current track or history entry
  -> save existing media id
  -> private playlist membership
  -> no room-rule or provider check

saved track or saved playlist
  -> normal enqueue path
  -> current provider, region, duration, repeat-cooldown, blocklist, and duplicate checks
  -> personal queue
```

A track stays saved when queueing rejects it. The rejection explains the
current reason, and the listener can try again after the room policy or provider
state changes.

## Product decisions

This plan makes the following decisions:

1. Playlists are private to their owner. There are no public, shared, or
   collaborative playlists in this version.
2. A playlist is ordered. Queueing the playlist processes tracks in that order
   and appends accepted tracks to the end of the listener's personal queue.
3. One media item can belong to several playlists, but it can occur only once
   in any one playlist.
4. The heart control works only with an existing `media.id`. Current playback
   and history already provide that ID, so saving from there needs no provider
   request.
5. Saving does not consult room settings, blocklists, duration checks, or
   active-queue duplicate checks, whichever control it came from.
6. Every queue action calls the same queue service used by pasted links. No
   playlist endpoint may insert directly into `queue_items`.
7. A whole-playlist queue action allows partial success. The response lists
   every skipped track and reason. The saved playlist never changes as a side
   effect.
8. Personal playlists hold at most 50 tracks in the first release. This matches
   the current provider-playlist import limit and lets "queue playlist" mean
   the entire saved playlist without adding background jobs or request paging.
9. Saving a pasted link or a search result goes through a metadata-only path,
   `resolveMediaForLibrary`, that resolves and stores the track without running
   any room admission policy. The provider lookup itself cannot be skipped for
   a track the room has never played.

## Favorite button choice

The recommended control is a heart-shaped **Save to playlist** button. Clicking
it opens a small playlist picker. The listener can add or remove the track from
one or more playlists and create a playlist in the same dialog. The heart is
filled when the track belongs to at least one playlist.

This interpretation matches the request for personal playlists without adding
a second favorite concept. It also lets a listener save a track directly to
"Driving", "Meme night", or any other playlist.

The alternative is a one-click heart backed by a reserved `Favorites`
playlist. That needs a special playlist kind, rules preventing its rename or
deletion, and a separate action for adding a track to another playlist. Choose
this alternative before the schema is written if one-click favoriting matters
more than direct playlist selection.

The rest of this plan assumes the recommended picker.

## Data model

Add two tables in `src/server/db/schema.ts` and generate one Drizzle migration.
The beta stage allows a direct schema addition. No backfill, compatibility path,
or duplicate storage is needed.

### `playlists`

- `id`: UUID primary key.
- `owner_user_id`: required foreign key to `users.id`, with cascade delete.
- `name`: required text, validated as 1 to 80 trimmed characters.
- `created_at`: required timestamp with the current time as default.
- `updated_at`: required timestamp, changed on rename and item mutation.
- A case-insensitive unique index on owner and name prevents two playlists that
  differ only by capitalization.
- An index on owner and `updated_at` supports the library list.

### `playlist_items`

- `playlist_id`: required foreign key to `playlists.id`, with cascade delete.
- `media_id`: required foreign key to `media.id`.
- `position`: required non-negative integer.
- `added_at`: required timestamp with the current time as default.
- The composite primary key is `playlist_id, media_id`. This makes add and
  remove operations naturally idempotent and rules out duplicates.
- An index on playlist and position supports ordered reads.

Do not copy title, artist, artwork, provider IDs, or URLs into
`playlist_items`. Playlist reads join `media`, so metadata refreshed by a later
queue attempt appears everywhere.

## Server module

Create `src/server/playlists.ts`. It owns playlist CRUD, ownership checks,
membership changes, ordering, and the bridge into the room queue. It must not
contain provider lookup or room-rule logic.

The module should expose operations equivalent to:

- `listPlaylists(ownerId, membershipMediaIds?)`
- `getPlaylist(playlistId, ownerId)`
- `createPlaylist(name, ownerId)`
- `renamePlaylist(playlistId, name, ownerId)`
- `deletePlaylist(playlistId, ownerId)`
- `addPlaylistTrack(playlistId, mediaId, ownerId)`
- `addPlaylistTrackByUrl(playlistId, url, ownerId)`
- `removePlaylistTrack(playlistId, mediaId, ownerId)`
- `reorderPlaylist(playlistId, orderedMediaIds, ownerId)`
- `queuePlaylistTrack(playlistId, mediaId, user)`
- `queuePlaylist(playlistId, user)`

Every query that reads or changes a playlist must constrain both playlist ID
and owner ID. Returning a common `PLAYLIST_NOT_FOUND` response for missing and
foreign playlists avoids exposing another listener's library.

Membership add, remove, and reorder operations run in a transaction that locks
the owned playlist row before reading its items. This serializes count checks
and `max(position) + 1` assignment across tabs. An idempotent add checks for the
existing membership before enforcing the 50-track limit, so retrying an add to
a full playlist still succeeds when that track is already present.

Adding a track performs only these checks:

1. The caller owns the playlist.
2. The playlist has fewer than 50 tracks.
3. The media row exists.
4. The membership does not already exist.

It must not import or call `lookupMediaCached`, `findBlockingRules`, or room
settings.

Reordering sends the complete ordered list of media IDs. The service compares
it with the current membership and returns `PLAYLIST_CHANGED` with status 409
when another tab added or removed an item. This follows the existing rule and
room queue reorder behavior.

## Queue boundary

Keep `src/server/room.ts` as the only owner of queue admission.

The current `enqueueMedia(url, user)` already performs the required checks in
the right order:

- Resolve current provider metadata through the cache.
- Enforce the current duration setting.
- Enforce active blocklist rules for the track and artist.
- Reject a track already queued or playing anywhere in the room.
- Reject a track that started playing inside the configured repeat-cooldown
  window.
- Upsert refreshed media metadata.
- Append the request to the listener's personal queue.
- Join the DJ rotation, bump the room revision, and start playback if idle.

`queuePlaylistTrack` should load the owned membership and its canonical URL,
then call `enqueueMedia`. It must not duplicate any of the steps above.

`queuePlaylist` should load the owner's playlist in position order and call the
same enqueue operation for each track. Use the existing playlist import result
shape as the starting point, but include stable media IDs and error codes:

```ts
interface PlaylistQueueResult {
  attempted: number;
  added: number;
  skipped: Array<{
    mediaId: string;
    title: string;
    code: string;
    reason: string;
  }>;
}
```

The endpoint sends one room-change notification after the operation if at
least one track was added. Saving, renaming, reordering, and deleting private
playlist data do not change the room revision and do not broadcast over the
room WebSocket.

Rename the existing `enqueuePlaylist` function to
`enqueueProviderPlaylist`. The route remains `/api/queue/playlist` for now.
The clearer internal name prevents saved playlists and provider imports from
sharing an ambiguous service name.

## Independent workstream: track repeat cooldown

This room policy can ship before or after personal playlists. It is independent
of playlist storage, but every playlist queue action inherits it through
`enqueueMedia`.

### Policy semantics

- Add `repeat_cooldown_seconds` to the singleton `room_settings` row.
- Default to 5,400 seconds, or 90 minutes.
- Accept values from 300 seconds, or 5 minutes, through 2,592,000 seconds, or
  exactly 30 days. In this setting, "month" means 30 days rather than a
  calendar month.
- Do not add an off state in the first release. The smallest permitted value is
  five minutes.
- Measure the interval from the previous queue item's `started_at`, not its
  finish time. A skipped track therefore counts as played and cannot be used to
  retry the same song immediately.
- Identify a repeat by the canonical provider and provider media ID returned by
  media lookup. Query prior queue items through their `media` row; a new request
  does not need to upsert metadata merely to discover its history.
- Keep the existing active-queue duplicate rule separate. That rule covers a
  track that is still queued or playing; the cooldown covers prior plays.

Saving a track to a personal playlist never reads or applies this setting. The
policy is checked only when a listener asks to put a track into the room queue.
A cooldown rejection never removes or changes a saved playlist item.

### Queue enforcement

Add one room-policy helper that finds the most recent `queue_items.started_at`
for the same provider and provider media ID. It accepts an optional queue item
to exclude and an optional `now` value for deterministic tests. Use it in both
admission paths:

1. `enqueueMedia` checks after the active-queue duplicate check but before the
   media upsert and queue insert. This preserves `ALREADY_QUEUED` for a track
   that is currently queued or playing. A prior play inside the window returns
   `TRACK_RECENTLY_PLAYED`; its message rounds the remaining wait up to the next
   minute so it never tells the listener to retry too early.
2. `startNextTrack` repeats the check with the candidate queue item excluded.
   This preserves the existing playback-time policy revalidation when an admin
   increases the cooldown after a request was accepted or another matching
   track starts first. A rejected candidate is removed with the normal
   automatic-playback reason and playback continues to the next candidate.

The boundary is inclusive: a track is allowed when
`now >= previous started_at + repeat_cooldown_seconds`. Capture one `now` value
per check and pass it into the helper so boundary tests are stable.

All current entry points already converge on `enqueueMedia`, including pasted
links, search results, provider-playlist imports, saved playlist tracks, and
whole saved playlists. No route should reproduce the query or calculate its
own window.

### Admin setting

Add **Track repeat cooldown** to the existing room settings form in
`AdminPanel`. Use a numeric input beside a unit picker with minutes, hours, and
days. A slider would be too imprecise across the five-minute to 30-day range.

The helper copy should read: "How long after a track starts before it can be
requested again. 5 minutes to 30 days."

The client converts the entered value to canonical seconds before sending the
existing settings patch. When loading a stored value, display the largest unit
that represents it as a whole number, falling back to minutes. The 90-minute
default therefore appears as `90 minutes`, while 48 hours appears as `2 days`.
Validate the converted seconds in the shared contract and again with a database
check constraint.

Include the new value in `RoomSnapshot.settings` so all admins see changes after
the normal room revision and WebSocket refresh. Log the old and new values in
the existing room-settings moderation action without creating a separate audit
system.

### Cooldown tests

- The database default is 90 minutes and rejects values below five minutes or
  above 30 days.
- Only an admin can patch the setting, and API validation accepts both exact
  limits.
- A track just inside the window is rejected; a track exactly at the boundary
  is accepted.
- A previously skipped track counts as a recent play. A queue item that never
  started does not.
- An unrelated media item is unaffected, and the active duplicate error remains
  distinct from `TRACK_RECENTLY_PLAYED`.
- Pasted links, search results, provider-playlist imports, saved tracks, and
  whole saved playlists inherit the same central check.
- Playback-time validation excludes its own candidate and removes a newly
  ineligible repeat if the admin increased the setting while it waited.
- A whole-playlist result reports a recent track as skipped, queues eligible
  tracks in order, and leaves saved membership unchanged.
- The Admin form converts minutes, hours, and days without rounding or allowing
  a converted value outside the server range.

## API contract

Add Zod request schemas and response types to `src/shared/contracts.ts`. Keep
playlist names, track limits, membership queries, and complete reorder payloads
bounded there.

Suggested endpoints:

```text
GET    /api/playlists
GET    /api/playlists/:id
POST   /api/playlists
PATCH  /api/playlists/:id
DELETE /api/playlists/:id

PUT    /api/playlists/:id/tracks/:mediaId
DELETE /api/playlists/:id/tracks/:mediaId
PATCH  /api/playlists/:id/tracks/order

POST   /api/playlists/:id/tracks/:mediaId/queue
POST   /api/playlists/:id/queue
```

All endpoints require a signed-in user. `PUT` and `DELETE` membership calls are
idempotent, which makes retries from the save dialog safe.

`GET /api/playlists` accepts an optional, validated list of up to 100 media IDs.
Along with playlist summaries, it returns playlist memberships for those IDs.
The room asks about one current track. History asks about the entries on its
current page. This avoids one request per history row without making the public
history response user-specific.

The list response contains:

- Playlist ID and name.
- Track count.
- Most recent update time.
- Memberships only for media IDs requested by the caller.

`GET /api/playlists/:id` returns the ordered tracks with their joined
`RoomMedia` data.

Add a `PlaylistError` to the existing API error mapping. Use specific codes for
name conflicts, a full playlist, stale reorder payloads, and queue failures
that need to appear in the bulk report.

## Frontend structure

### Navigation and page

Add `Playlists` to `SiteNav` and create `/playlists` as a static Astro shell
with a client React component. Anonymous visitors see the normal sign-in
action. The API remains the source of truth for authentication and ownership.

The page should match the current direct-on-canvas design:

- A plain `Playlists` heading and create button.
- A 240 to 260 pixel playlist list separated from the selected track list by a
  one-pixel divider on desktop.
- A normal stacked selector and track list on narrow screens.
- Existing fonts, neutral surfaces, blue focus and active states, and compact
  outline icons.
- No card grid, decorative statistics, gradient covers, or new color system.

Each playlist exposes rename and delete actions, its track count, and one
`Add playlist to queue` button. Each track row exposes queue, save to another
playlist, remove, and the existing four movement controls. Destructive delete
actions require a direct confirmation naming the playlist.

### Reusable save control

Create one `SaveToPlaylistButton` and one small library hook rather than
implementing current-track and history behavior separately.

The button receives a `RoomMedia`, known membership IDs, and callbacks. It does
not fetch room state or mutate the queue. Its dialog lists the caller's
playlists with checkboxes and supports creating a playlist without leaving the
current page.

Use pessimistic updates for the first release. Disable the changed checkbox
until the API responds, then update local membership. This prevents a failed
request from showing a saved state that never reached Postgres.

### Now playing

Render the save control in `RadioRoom` beside the existing vote and moderation
controls when a user is signed in and a track is playing. Do not put library
state inside `MediaPlayer`. That keeps playback and OBS embed behavior
untouched.

The room already knows the current `media.id` and signed-in user through the
room snapshot. Fetch playlist summaries and membership for only the current
media ID. Refresh that membership when the current queue item changes.

### History

Keep `/api/history` public and unchanged. When the page loads, make a separate
authenticated playlist request for the displayed media IDs. A 401 means the
viewer is anonymous, so history renders without save controls.

For signed-in viewers, add the heart control inside the track cell rather than
adding a wide table column. This keeps the existing table usable on smaller
screens. The same component can later appear in profile history, but that is
not required for the first release.

### Queue feedback

Queueing one track uses the existing room error message. Queueing a playlist
shows a compact result below the action:

- The number added.
- Every skipped title and its current reason.
- A link back to the room when at least one track was accepted.

Do not remove, gray out, or reorder rejected saved tracks. Library state and
room policy remain separate in the interface as well as the server.

## Concurrency and failure behavior

- Adding the same media twice to one playlist succeeds without a duplicate.
- Removing a membership that is already gone succeeds.
- Concurrent adds to one playlist serialize on its playlist row, so they cannot
  take the same position or exceed the track limit together.
- Two tabs creating the same playlist name receive one success and one
  `PLAYLIST_NAME_TAKEN` response.
- Reorder fails as a whole if the membership changed since the client built its
  order.
- Whole-playlist queueing converts known `RoomError` and `MediaLookupError`
  failures into per-track skips. An unexpected database or programming error
  stops the operation instead of pretending later tracks were checked.
- A track that becomes unavailable stays visible with its last stored metadata.
  Its next queue attempt reports the provider failure.
- Queue operations preserve the existing global active-track duplicate rule.
  A saved track already queued by someone else appears in the skipped report.

## Security and privacy

- Require authentication on every playlist endpoint.
- Scope every playlist query to the authenticated user's stable local user ID.
- Never accept an owner ID from the client.
- Keep playlist names and membership out of room snapshots, public history,
  profiles, statistics, WebSocket messages, and analytics properties.
- Continue enforcing the configured frontend origin on every state-changing
  request.
- Return the same not-found response for a missing playlist and another user's
  playlist.

## Tests

Add `src/server/playlists.integration.test.ts` against the guarded Postgres test
database. Cover:

- Playlist create, rename, list, delete, and case-insensitive name conflicts.
- Owner isolation for reads and every mutation.
- One media item in several playlists and no duplicate inside one playlist.
- Position assignment and complete-list reorder conflict handling.
- The 50-track limit.
- Saving a media row that is now blocked or over the duration limit. Assert that
  saving performs no media lookup and succeeds.
- Queueing that same saved row through the normal queue path. Assert the current
  policy rejection and that the playlist membership remains.
- Individual queue success.
- Whole-playlist ordering, partial success, error codes, and unchanged saved
  membership.

Extend `src/server/app.test.ts` for authentication, route validation, ownership
error mapping, and room-change notifications. Private playlist mutations must
not notify the room. Successful queue actions must.

Add focused frontend tests for:

- Signed-out pages hiding the save action.
- The picker showing current memberships.
- Successful add and remove state.
- API failure leaving the previous membership visible.
- History batching membership lookup rather than requesting once per row.
- The whole-playlist result summary.

Run the normal checks after every vertical slice:

```sh
npm run check
npm test
npm run build
```

Run Postgres integration tests with `TEST_DATABASE_URL` against a database whose
name ends in `_test`.

## Delivery slices

Each slice ends in a working product state.

### Independent slice: track repeat cooldown

- Add the setting, schema constraint, migration, shared contract, and room
  snapshot field.
- Add the central request-time and playback-time checks with integration tests.
- Add the numeric amount and unit picker to the current Admin settings form.
- Deploy and verify this slice on its own. It is not a prerequisite for saving
  playlists, and playlist queueing will inherit it whenever both features are
  present.

### Slice 1: create, save, view, and queue one track

- Add the two tables and service tests.
- Add create, list, detail, membership, and single-track queue endpoints.
- Add `/playlists` with create and detail views.
- Add the current-track save picker.
- Queue one saved track through `enqueueMedia`.

This proves ownership, the save-versus-queue policy boundary, and the core UI
before bulk behavior is added.

### Slice 2: manage playlists and save from history

- Add rename, delete, remove, and reorder operations.
- Add batched membership lookup.
- Add the save picker to `/history`.
- Add copy-to-another-playlist from a playlist track row.

### Slice 3: queue a whole playlist

- Add the bulk queue service and result contract.
- Preserve playlist order and report partial success.
- Rename the provider import service for clarity and share only the result type
  where that reduces duplication.
- Confirm that only successful queue additions emit a room update.

### Slice 4: finish and verify

- Add concise analytics events without playlist names or track IDs.
- Update `README.md` and `docs/architecture.md`.
- Exercise the complete flow through the local production-shaped stack and its
  Destiny OAuth stand-in.
- After deployment, verify two production accounts cannot see each other's
  playlists, then test current-track save, history save, individual queue, and
  whole-playlist partial failure.

## Likely file changes

- `src/server/db/schema.ts` and one generated file under `drizzle/`
- New `src/server/playlists.ts`
- New `src/server/playlists.integration.test.ts`
- `src/server/room.ts` and `src/server/room.integration.test.ts`
- `src/server/app.ts` and `src/server/app.test.ts`
- `src/shared/contracts.ts`
- `src/components/AdminPanel.tsx` and its focused settings tests
- New `src/components/PlaylistsPage.tsx` and its stylesheet
- New reusable save button and playlist-library hook under `src/components/`
- `src/components/RadioRoom.tsx`
- `src/components/CommunityPage.tsx` and its stylesheet
- `src/components/SiteNav.tsx`
- New `src/pages/playlists.astro`
- `README.md` and `docs/architecture.md`

## Production acceptance checks

1. The untouched production setting is 90 minutes. An admin can save both five
   minutes and 30 days, and another connected admin receives the updated value.
2. A track played just inside the configured window is rejected with the wait
   remaining. The same track is accepted at the boundary.
3. Saving that recent track to a personal playlist still succeeds. Queueing it
   alone or within a whole playlist reports `TRACK_RECENTLY_PLAYED`, while
   eligible playlist tracks are added in order.
4. Account A creates two playlists. Account B cannot list, open, change, or
   queue either one.
5. A signed-in listener saves the current track without affecting playback or
   the room revision.
6. The same track can be saved from history and shows its existing membership.
7. A moderator blocks a saved track. It remains in the owner's playlist.
8. Queueing the blocked saved track fails with the active rule name.
9. After the rule is disabled, queueing the saved track succeeds without
   changing the playlist.
10. A playlist containing valid, recently played, blocked, too-long, duplicate,
    and unavailable tracks queues the valid tracks in order and reports every
    rejection.
11. The playlist order and membership are unchanged after the bulk action.
12. OBS player and metadata embeds still contain no save or playlist controls.

## Questions this plan opened

1. Picker or a reserved one-click `Favorites` playlist? **Settled**: the picker
   shipped, so a playlist is one concept and a track can be saved straight into
   any of them.
2. Is 50 tracks a permanent limit? **Open**, now tracked in `docs/backlog.md`.
3. Save controls on profile history too? **Deferred**, also in the backlog.
