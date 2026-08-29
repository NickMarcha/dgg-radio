# Playlists and the repeat cooldown are on main, not yet verified live

## Current state

`main` and `origin/main` are both at `785775d`, fast-forwarded from `a376d4a`:

```text
785775d Add personal playlists and a track repeat cooldown
```

The push fired both automatic deploys. **Neither was checked.** Compare the
deployed commit on each half before assuming either is running `785775d`, and
remember that a webhook delivery alone does not prove the API rebuilt from
source; that needs `webhook_force_deploy`.

The working tree is clean apart from this handoff replacing the previous one.

## What shipped

### Personal playlists

Private, ordered playlists per listener, held in `playlists` and
`playlist_items`. A row stores only a `media` reference and a position, so
metadata refreshed by a later lookup appears everywhere at once.

Four ways in: the heart control on the player and on `/history`, and on
`/playlists` either a search across both providers or a pasted link. A pasted
link naming a whole YouTube playlist or SoundCloud set imports every track it
holds, up to the 50-track limit, and reports what it skipped and what was
already there.

Saving is deliberately not admission. It runs no duration limit, blocklist,
repeat cooldown, or active-duplicate check, so a track the room refuses today
stays saved and can be queued once the room allows it. Every queue action goes
back through `enqueueMedia`; no playlist route writes to `queue_items`.

Ownership is enforced on every query. A playlist belonging to someone else
answers the same `PLAYLIST_NOT_FOUND` as one that does not exist. Membership
changes lock the playlist row first, so two tabs cannot claim one position or
push past the track limit together.

### Track repeat cooldown

`room_settings.repeat_cooldown_seconds`, defaulting to 90 minutes, ranging from
five minutes to 30 days, set from the Admin form as an amount plus a unit. The
clock starts at `queue_items.started_at`, so a skipped track counts as played
and downvoting is not a way to requeue something immediately.

`enqueueMedia` checks it after the active-duplicate check, which keeps
`ALREADY_QUEUED` distinct from `TRACK_RECENTLY_PLAYED`. `startNextTrack`
rechecks with its own candidate excluded, so raising the setting while a request
waits drops it at playback time.

### The lookup split, and the caching that follows

The playlist policy boundary forced a change in `media.ts`. A provider answers
two questions at once, and the code threw for both. `inspectMedia` now returns
the metadata, the playback issue if the room's player cannot carry the track,
and YouTube's own country lists. It asks nothing about the room.

`lookupMedia` is the admission view over it and throws, so every queue path
behaves exactly as before.

`media_lookups` gained three columns. It now stores refusals as well as
successes, so a track the room keeps refusing costs one lookup rather than one
per attempt, and a cache hit refuses it again rather than letting it through.
Because the row keeps the country lists rather than a verdict about one country,
one lookup answers for every playback region, and moving the room's region
re-reads the same rows. A row recording a playback issue stands for an hour;
anything else stands for a day, SoundCloud included now that those lookups are
no longer billed.

### Also

- Every page's header reads `GET /api/me` rather than the whole room snapshot.
  Stats, History and Playlists now render the same three-part topbar as the room
  instead of a stripped one.
- `YOUTUBE_BLOCKED_IN_UAE` is now `YOUTUBE_REGION_BLOCKED`, and its message
  names the configured region rather than always saying the UAE.

## Bugs found and fixed on the way

1. `PUT` was missing from the API's CORS `allowMethods`, so the browser blocked
   the preflight on every save. Nothing could be added to a playlist from
   anywhere; removing worked, because `DELETE` was allowed.
2. Region and embeddability refusals applied when *saving*, not just when
   queueing. That is what forced the lookup split above.
3. Re-importing a playlist reported every existing track as newly saved, because
   `addPlaylistTrack` is idempotent and returned nothing. It now reports whether
   it inserted, and duplicates are counted separately.
4. `/code-review` found eight more, all fixed: a single-track provider playlist
   being reported as a success when it failed, a duplicated playlist-link
   predicate across client and server, the save dialog silently retargeting when
   the room advanced, an unhandled rejection on a failed sign-out, an invisible
   failure that made every history save button vanish, and duplicate React keys.

## Verification before the push

- `npm run check`: 0 errors, 0 warnings, 0 hints.
- `npm test` with `TEST_DATABASE_URL` set: **165 passed, 0 skipped**. Running it
  without that variable silently skips every Postgres suite, which is most of
  the coverage for this work.
- `npm run build`: both halves.
- `git diff --check`: clean.
- The whole flow exercised against the local production-shaped stack.

## Production checks still needed

1. Confirm Netlify built `785775d` and the API deployment pulled it.
2. Confirm the three migrations ran: `repeat_cooldown_seconds` on
   `room_settings`, the `playlists` and `playlist_items` tables, and
   `playback_issue_code`, `playback_issue_message` and `region_restriction` on
   `media_lookups`. A stale API means a Playlists tab whose every request 404s.
3. Admin shows the cooldown at 90 minutes untouched, and saves at both ends of
   the range. Another connected admin receives the change.
4. Two accounts cannot list, open, change, or queue each other's playlists. This
   is the one thing worth checking against real sessions rather than tests.
5. Save from the player and from history, then queue one track and a whole
   playlist. A blocked or recently played track is reported and stays saved.
6. Paste a YouTube playlist link on `/playlists`.
7. OBS embeds still carry no playlist controls.

Expect the first requests after the deploy to be slower: every YouTube track is
re-checked once, because existing `media_lookups` rows have no stored region
lists. One quota unit each, one time.

Do not restart the production API merely to inspect it. The room may be active.

## Local test stack

```sh
npm run stack:test
npm run dev:web
npm run stack:test:down
```

Integration tests need a database whose name ends in `_test`:

```sh
TEST_DATABASE_URL=postgresql://dgg_radio:local_only@127.0.0.1:54329/dgg_radio_test npm test
```

## Files to start with

- `src/server/playlists.ts` owns playlist CRUD, ownership, and the bridge into
  the queue. It holds no provider or room-rule logic.
- `src/server/room.ts` owns queue admission, the cooldown checks, and the two
  library resolvers that store media without applying policy.
- `src/server/media.ts` splits what a track is from whether the room can play it.
- `src/server/media-cache.ts` owns how long a stored answer stands.
- `src/components/PlaylistsPage.tsx`, `SaveToPlaylistButton.tsx` and
  `usePlaylistLibrary.ts` are the whole frontend of the feature.
- `docs/plans/personal-playlists.md` records the decisions behind it.
