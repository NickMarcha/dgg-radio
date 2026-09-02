# Handoff

One rolling file. Update it at the end of a session rather than adding another.
Session narrative belongs in git history; what belongs here is the state of the
room, what is waiting on a person, and the things that are true but not visible
in the code.

Last updated 2026-09-02.

## Where things stand

`npm run check` is clean at 95 files. 233 Vitest pass across 25 files, run
against the local Postgres:

```
TEST_DATABASE_URL=postgresql://dgg_radio:local_only@127.0.0.1:54329/dgg_radio_test npm test
```

Two strands landed together and neither is deployed.

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
seconds. The room's own machinery ignores it, and `/history` shows it below the
live history under "Before DGG Radio". Its primary key is QueUp's play id, so a
rerun against a fresher export brings across only what is new. Nothing can be
saved or queued out of it; `docs/backlog.md` carries the item and the workaround.

Bans, staff and the audit log are exported and imported nowhere. This room has no
banned-user concept and a QueUp name is not a Destiny identity, so importing 18
bans would mean inventing both a feature and a mapping.

**Genre and identity are researched, measured, and unbuilt.** No application code
exists for it: no schema, no writer, no display. The shape is in
`docs/research/discogs-dump-genre-coverage.md`.

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

1. **Migration `0016` is applied nowhere.** The API applies pending migrations at
   startup, so local picks it up on restart and production on its next deploy.
2. **The real import has never run.** Only `dgg_radio_test` has held these rows.
3. **The beta badge.** `AGENTS.md` makes that badge the line: while it is there
   the stored data is disposable. Importing two years the community cannot
   regenerate puts something in the database that exists only because QueUp is
   still up. Worth settling deliberately, in either direction, before the import.
4. **Failed YouTube lookups are not cached.** Successful ones are, so a dead video
   is re-fetched against the metered quota on every playlist import containing
   it. Unrelated to the above, still a real bug.

## True but not visible in the code

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
- **Cached HTTP responses live in `%TEMP%/dggradio-*`**, which lets every genre
  and metadata measurement replay with zero network calls. Worth keeping until
  the real enrichment exists.
- **A dead session can be recovered from its own transcript.** Codex writes
  `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, one JSON object per event;
  reading back the `response_item` messages gives the whole conversation. The
  session that produced the QueUp import ran out of context, and two of its
  findings existed only there, never in any file.

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

Build the enrichment. The shape is settled and measured; the honest summary of
what it buys is 59 tracks in 100 labelled at track level, 66 if a coarse
artist-level genre is acceptable and marked as such. The prototypes under
`scripts/*.prototype.ts` are disposable and can go once it exists.
