# Handoff

One rolling file. Update it at the end of a session rather than adding another.
Session narrative belongs in git history; what belongs here is the state of the
room, what is waiting on a person, and the things that are true but not visible
in the code.

Last updated 2026-09-02.

## Where things stand

`npm run check` is clean at 96 files. 255 Vitest pass across 26 files, run
against the local Postgres:

```
TEST_DATABASE_URL=postgresql://dgg_radio:local_only@127.0.0.1:54329/dgg_radio_test npm test
```

Both strands are now built, and neither is deployed.

**The room's QueUp years are importable.** QueUp's own export is gone, but its
web client's API is still up and splits in two. Room data is public: the room,
its play history 20 a page, members, bans, staff, the whole moderation log.
Playlists are not, and cannot be made so, because `api.queup.net` answers private
endpoints only with the owner's cookie and only for its own origin. So room
history is `scripts/queup-export-room.ts` and playlists are a snippet people
paste into their own browser, served from `public/queup-export-playlists.js` so
it can be read before it is pasted.

dggJams holds 47,982 plays, 34,114 distinct tracks, 1,050 people, back to
2024-10-20, its first day.

`legacy_plays` (migration `0016`) is deliberately its own table. Folding it into
`queue_items` would need 1,050 user rows with no Destiny identity behind them and
34,114 provider lookups. As a separate table it costs no lookups and imports in
seconds. The room's own machinery ignores it, and `/history` shows it in its own
tab beside the live history. Its primary key is QueUp's play id, so a rerun
against a fresher export brings across only what is new.

The archive is no longer a dead end. A track can be saved to a playlist or
requested out of it, and because the archive holds a provider id rather than a
`media` row, the first person to reach for one pays for the lookup the import
skipped; the answer carries the media id back so the row stops being unresolved.
Every genre on a row narrows the history to it, and `/stats` counts plays by
genre with the two histories kept apart, which is the only honest way to draw
that chart when one is 168 plays and the other is 48,000. Top Played and Top
Jammers carry the same choice, so the archive's 5,375-play requesters are
readable without drowning the room's own handful.
`/history` is two tabs — the room's own and QueUp's — with one search box that
queries both and tab labels that count what each matched. Both are paged by
number rather than by a cursor, and the tab, the search and the page live in the
address bar, because 960 pages of archive is not something to walk through and
what somebody is reading should be sendable. The cost of offsets is that a track
finishing under a reader shifts the room's own history down a row; at a track
every few minutes that was judged the better trade.

Bans, staff and the audit log are exported and imported nowhere. This room has no
banned-user concept and a QueUp name is not a Destiny identity, so importing 18
bans would mean inventing both a feature and a mapping.

**Genre and identity are built.** All seven steps of the researched shape, in
`track_genres` (migration `0017`), `src/server/genre.ts`, `musicbrainz.ts`,
`discogs.ts`, `youtube-music.ts`, two scripts, and `TrackGenres.tsx`. The
research doc carries a table of what lives where.

Against the full archive the Discogs dump reproduces the research almost
exactly: 30.8% of distinct tracks and 34.9% of plays, with 1,430 still ambiguous
after both tie-breaks against a predicted 1,429.

MusicBrainz now comes from its dumps too, and the two together label **14,492 of
34,003 tracks (42.6%)** — 4,030 of them tracks only MusicBrainz has, 4,207
carrying both sources and so cross-checkable, and 13,153 (38.7%) described at
track level rather than by their artist. The research doc has the full table and
the correction it forced: the earlier conclusion that a MusicBrainz dump would
not pay for itself was drawn from the URL join alone, and the URL join was never
the part worth having.

Track-level genre across a deterministic 100-video sample:

| Layer | Adds | Total |
| --- | --- | --- |
| MusicBrainz track-level | | 38 |
| + Discogs monthly dump, joined on video id | +12 | 50 |
| + Discogs live search on what the dump missed | +9 | 59 |
| + MusicBrainz artist-level fallback | +7 | 66 |

The two findings that decided the design:

- **Discogs embeds YouTube video ids in its masters**, 5.76 million of them, in a
  CC0 monthly dump. Joining on that id is exact and reaches 30.8% of the archive.
  Going through MusicBrainz's Discogs relations reaches 1.4%. The API cannot
  query by video id, so the dump is not a cheaper route to the same data, it is
  the only route.
- **Live Discogs search fails closed.** On the 50 sampled tracks the dump missed
  it answered 26, all 26 the right artist, none wrong. That is what makes it safe
  to consult for a track that is playing.

Genre carries its provenance: which source, which entity level, whether a second
source agreed. Artist-level genre is never displayed as though it describes the
track. Do not merge the two vocabularies; Discogs has ~15 broad genres plus
styles, MusicBrainz a folksonomy of hundreds, and normalising them together
manufactures both false agreement and false conflict.

## Waiting on a person

1. **Migrations `0016` and `0017` are applied locally and nowhere else.** The API
   applies pending migrations at startup, so production picks them up on its
   next deploy. Genre comes with them: `data/genres.json` is committed, and the
   API applies it right after migrating, so a deploy carries all 19,272 answers
   without the deployment host fetching any data dump.
2. **The real import has never run in production.** Locally it now has: 48,000
   plays, 34,130 tracks, 1,050 people, back to 2024-10-20. The 26 MB export it
   came from is at `%TEMP%/dggradio-queup-dgg-radio-full.json`, which Windows
   will clear eventually — move it somewhere real or re-export.
3. **The MusicBrainz pass has done six tracks.** It is a long background job by
   nature: three requests a track against a one-a-second limit. Run
   `scripts/enrich-genres.ts` with a real `--limit` when there is time for it,
   and see the backlog first — the MusicBrainz dumps might remove the need.
4. **The Discogs dump import wants rerunning monthly**, against a fresh dump and
   after any large archive import.
5. **The beta badge.** `AGENTS.md` makes that badge the line: while it is there
   the stored data is disposable. Importing two years the community cannot
   regenerate puts something in the database that exists only because QueUp is
   still up. Worth settling deliberately, in either direction, before the import.
6. **Failed YouTube lookups are not cached.** Successful ones are, so a dead video
   is re-fetched against the metered quota on every playlist import containing
   it. Unrelated to the above, still a real bug.

## True but not visible in the code

- **Three pages are one prerendered shell each**, serving every id under them:
  `/profile`, `/track` and `/artist`. Netlify does that from
  `public/_redirects` and the local dev server does it from `src/middleware.ts`,
  because Astro's dev server does not read that file. Adding a fourth means
  editing both, and forgetting the middleware only shows up as a 404 in
  development while production is fine.

- **`@distube/ytsr` reads videos and playlists and nothing else.** Its
  `parseItem` returns null for a `channelRenderer`, which then throws, so there
  is no channel search however the options are written. Blocking a channel goes
  through one of its videos instead. YouTube's own `search.list?type=channel`
  would work and costs 100 quota units a query, which is the whole daily budget
  in a hundred searches.

- **Session replay is gated by an `$exception` trigger configured in PostHog, not
  in the repo.** `src/client/analytics.ts` reads as "record everything" on its
  own. The recorder holds each session in memory and uploads only the ones where
  an exception was captured.
- **The room's player is a cross-origin iframe**, so the video is a blank
  rectangle in every recording. Understood and accepted.
- **`CF-Connecting-IP` is believed only because the API publishes no port and
  answers nothing but the tunnel.** On a directly reachable origin a caller could
  write that header themselves and be counted as somebody else. If a port is ever
  published, this stops being safe.
- **`/api/room` is deliberately exempt from rate limiting.** Every open room polls
  it every 15 seconds and refetches on each change, so an address shared by a
  household or a VPN would trip any limit tight enough to be worth having.
- **The September Discogs dump is already downloaded**, at
  `%TEMP%/dggradio-discogs-masters-20260901.xml.gz`, 597 MB. The cached HTTP
  responses beside it, `%TEMP%/dggradio-*`, let the research measurements replay
  with no network calls. Both are temporary-directory files that Windows will
  clear eventually; the dump is a fresh download away and the caches are only
  worth what re-running the prototypes is worth.
- **A dead session can be recovered from its own transcript.** Codex writes
  `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, one JSON object per event;
  reading back the `response_item` messages gives the whole conversation. The
  session that produced the QueUp import ran out of context, and two of its
  findings existed only there, never in any file.

## A local symptom that looks like a room bug

An island that fails to hydrate leaves its prerendered shell on screen, and the
shell has no data. On `/player` that reads as **"The room is quiet. Add the
first track."** with "Reconnecting" in the header, while `/embed/player` — a
different island on a different page — carries on playing correctly. It looks
like the room lost its track. It has not: nothing has fetched `/api/room` on
that page at all.

The console says so plainly:

```
[astro-island] Error hydrating /src/components/RadioRoom.tsx
TypeError: Failed to fetch dynamically imported module: .../RadioRoom.tsx
```

It is a stale Vite module graph, and only ever happens in development, after
files have been added, moved or renamed while `astro dev` was running. The API
is fine throughout, which is the quickest way to tell: `curl /api/room` shows
the track the page claims does not exist. The fix is to restart the dev server,
clearing `node_modules/.vite` if it recurs.

## Mistakes worth not repeating

Both from 2026-09-02, and the same mistake twice: a plausible number arrived and
was explained before anything checked what produced it.

- MusicBrainz recordings were reported as having no genres. The **search**
  endpoint never returns genres regardless of the entity; they arrive only from a
  lookup with `inc=genres`. A script reading genres off search results got empty
  arrays, which looked like an answer.
- Discogs coverage was called contaminated because YouTube ids appear in `<video>`
  description text as well as in `src`. The fix was right in principle and moved
  coverage by 0.07 points. The Beatles mislabelling blamed on it was never that:
  `Happiness Is A Warm Gun` is attached by genuine `<video src>` links to a
  Various-Artists compilation and a gospel quartet record, neither of them The
  Beatles. It is Discogs data quality, and no tie-break rescues a track whose
  every candidate master is wrong.

## Next

Deploy it, and then feed it. Nothing in either strand has left this machine, and
the genre table is only as good as the runs that fill it: one dump import is
minutes of work and covers a third of the archive, and the MusicBrainz pass is
open-ended.

The prototypes under `scripts/*.prototype.ts` are superseded by the shipped
modules and can go.
