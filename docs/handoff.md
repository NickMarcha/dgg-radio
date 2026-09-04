# Handoff

One rolling file. Update it at the end of a session rather than adding another.
Session narrative belongs in git history; what belongs here is the state of the
room, what is waiting on a person, and the things that are true but not visible
in the code.

Last updated 2026-09-03.

## Where things stand

`npm run check` is clean. 281 Vitest pass across 28 files, run against the local
Postgres:

```
TEST_DATABASE_URL=postgresql://dgg_radio:local_only@127.0.0.1:54329/dgg_radio_test npm test
```

Everything below is on `recover-queup-import-and-genre-research` and **none of it
is deployed**. `npm run build` succeeds.

### The archive is part of the room now

The QueUp years are no longer a separate list to look at. A track can be saved
to a playlist or requested out of the archive; because the archive holds a
provider id rather than a `media` row, the first person to reach for one pays
for the provider lookup the import skipped, and the answer carries the media id
back so the row stops being unresolved.

`/history` is two tabs — the room's own and QueUp's — with one search box that
queries both, numbered pages rather than a cursor, and the tab, search, genre
filter and page all in the address bar so a view can be sent to somebody.

`/stats` has tabs, a year-and-month filter over every table, and the QueUp years
beside the room's own wherever the two can honestly be counted apart. Every
track and every channel has a page: when it played in either history, who asked
for it, what it is, and what else is like it.

### Genre, and how much of it there is

`track_genres` (migration `0017`) is keyed by the provider's id, so one table
labels both histories. Two sources are kept side by side and never merged.

Against the whole archive:

| | tracks | of 34,248 |
| --- | --- | --- |
| Discogs | 10,480 | 30.6% |
| MusicBrainz | 17,952 | 52.4% |
| **Either** | **21,175** | **61.8%** |
| Both, so cross-checkable | 7,257 | 21.2% |
| About the track rather than its artist | 17,903 | 52.3% |

MusicBrainz doubled on 2026-09-04, and not because the catalogue got better.
The dumps match on an artist and a title read out of the upload title, and only
17,652 of 34,058 uploads are named `Artist - Title` at all. The ceiling was the
question, not the answer. `scripts/youtube-music-identities.ts` reads the Music
card off each video's watch page — 20,093 of 25,220, 79.7% — and hands the dump
importer those names instead. 10,764 matched, 9,694 carried a genre.

Discogs comes from its CC0 monthly dump, joined exactly on the YouTube ids it
embeds in masters. MusicBrainz comes from its dumps too, and the interesting
part is *why*: its URL relations only reach 6.6% of the archive, and what
actually pays is a fuzzy match on artist and title parsed from the upload title
— worthless over an API at one request a second, free once the tables are local.
`docs/research/discogs-dump-genre-coverage.md` has the full table and the
correction it forced.

### Deploying carries the data

`data/legacy-plays.json.gz` (48,182 plays, 3 MB) and `data/genres.json` (30,086
answers, 8 MB) are committed, and `src/server/seed.ts` applies them at startup
right after migrations. So a deployment gets two years of history and everything
known about it without fetching a byte of anyone's data dump.

Each file is read once. `seed_state` (migration `0018`) holds a digest of the
bytes that were applied, because without it every restart offered 68,000 rows to
PostgreSQL to be told each one was already there — 3.7 seconds before the room
could serve, spent to change nothing. Regenerating a file changes its digest and
it applies again by itself. The log says which happened, so the skip is visible
rather than merely claimed.

Both seeds **only fill gaps**. A row the database already has is left exactly as
it is, so anything learned since — a play brought across last week, a genre
worked out against the running database — survives every later deploy. Verified
by editing a stored answer, deleting others, and redeploying: the edit stood and
the gaps filled.

### New tracks look themselves up

`src/server/enrichment.ts` runs the first time the room stores a track: identity
from the video's own YouTube Music card, falling back to splitting the upload
title, then MusicBrainz and Discogs, both stored. It is queued, bounded, and
never on the request path — a request is accepted, the room plays, and the genre
appears a poll or two later.

`/admin#server` has a button that brings across whatever QueUp has played since
last time. It reads the newest pages and stops at the first page it already
knows, so pressing it twice finds nothing the second time. Measured: 71 plays
across 5 pages, then 0 across 1.

## Waiting on a person

1. **Nothing is deployed.** Merging to `main` builds the frontend on Netlify,
   rebuilds the API, applies migrations `0016` and `0017` at startup, and then
   applies both seeds. No new environment variables are required.
2. **The beta badge stays**, decided 2026-09-02. The archive and its genre are
   therefore still disposable data by the rule in `AGENTS.md`.
3. **Nothing here is unverified any more.** The admin archive button was
   driven in a browser against the running stack: three plays across two pages,
   then "Nothing new" on the second press.
4. **Failed YouTube lookups are not cached.** Successful ones are, so a dead
   video is re-fetched against the metered quota on every playlist import
   containing it. Still a real bug, still unrelated to everything above.
5. **The seed files drift.** They are a snapshot: regenerate with
   `scripts/seed-export.ts` after topping up the archive or running a dump
   import, then commit what changed.

## True but not visible in the code

- **Storing Discogs API answers is a decision, not an oversight.** Their terms
  forbid keeping API content durably, which is why the durable table was built
  from the CC0 dump. The room's operator has confirmed permission, so the live
  lookup now writes what it finds like any other source.
- **`@distube/ytsr` reads videos and playlists and nothing else.** Its
  `parseItem` returns null for a `channelRenderer`, which then throws, so there
  is no channel search however the options are written. Blocking a channel goes
  through one of its videos instead.
- **The MusicBrainz dump import needs `--max-old-space-size` at 12 GB or more.**
  Node's default 4 GB dies partway through the `track` scan, which peaks near
  14 GB. Column order is read from MusicBrainz's own `CreateTables.sql`, because
  a headerless TSV with a wrong index does not fail — it silently labels
  everything with somebody else's data.
- **Three pages are one prerendered shell each**, serving every id under them:
  `/profile`, `/track` and `/artist`. Netlify does that from `public/_redirects`
  and the dev server from `src/middleware.ts`. Adding a fourth means editing
  both, and forgetting the middleware only shows as a 404 in development.
- **Session replay is gated by an `$exception` trigger configured in PostHog,
  not in the repo.** The recorder holds each session in memory and uploads only
  the ones where an exception was captured.
- **The room's player is a cross-origin iframe**, so the video is a blank
  rectangle in every recording. Understood and accepted.
- **`CF-Connecting-IP` is believed only because the API publishes no port and
  answers nothing but the tunnel.** If a port is ever published, this stops
  being safe.
- **`/api/room` is deliberately exempt from rate limiting.** Every open room
  polls it every 15 seconds.
- **A dead session can be recovered from its own transcript.** Codex writes
  `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, one JSON object per
  event; reading back the `response_item` messages gives the whole conversation.

## A local symptom that looks like a room bug

An island that fails to hydrate leaves its prerendered shell on screen, and the
shell has no data. On `/player` that reads as **"The room is quiet. Add the
first track."** with "Reconnecting" in the header, while `/embed/player` carries
on playing correctly. Nothing has fetched `/api/room` on that page at all.

```
[astro-island] Error hydrating /src/components/RadioRoom.tsx
TypeError: Failed to fetch dynamically imported module: .../RadioRoom.tsx
```

It is a stale Vite module graph, only ever in development, after files have been
added, moved or renamed while `astro dev` was running. The quickest way to tell
is that `curl /api/room` shows the track the page claims does not exist. Restart
the dev server, clearing `node_modules/.vite` if it recurs.

## Mistakes worth not repeating

- **A number measured on the most played tracks is not the number.** The
  MusicBrainz URL join looked like 18% against a sample of the hundred most
  played and turned out to be 6.6% across the archive. The head of a play-count
  distribution is the best known music in the room.
- **A conclusion drawn from one half of a thing is not a conclusion.** That 18%
  was used to write a backlog item saying a MusicBrainz dump would not pay for
  itself. It pays for itself easily — the URL join was simply never the part
  worth having. Build the cheap measurement, not the argument.
- **MusicBrainz genres arrive only from a lookup with `inc=genres`.** The search
  endpoint never returns them, whatever is asked for.
- **Discogs coverage was once called contaminated** because YouTube ids appear
  in `<video>` description text as well as in `src`. The fix was right and moved
  coverage by 0.07 points; the mislabelling blamed on it was Discogs' own data.
- **Re-running a patch to see why it failed applies the parts that worked
  again.** That silently duplicated seventy lines of `contracts.ts`, which
  TypeScript accepted because identical interfaces merge.

## Next

Deploy it. Then the one thing that moves 42% upward: the per-track pass in
`scripts/enrich-genres.ts`, which identifies a track from its YouTube Music card
rather than a parsed upload title and so reaches what the dumps could not. About
three requests a track against a one-a-second limit, most played first, safe to
stop and resume — roughly sixteen hours for what is still unlabelled. It runs
here, not in production: the output is a regenerated `data/genres.json` that the
next deploy picks up on its changed digest.

A rerun of the two dump imports is **not** that. Both were rerun on 2026-09-03
and moved coverage by 30 tracks, because the importers reconsider every track
every time — the same dumps re-derive the same answers. Rerun them when the
dumps are newer, not when the archive is.

The prototypes under `scripts/*.prototype.ts` are superseded by the shipped
modules and can go.
