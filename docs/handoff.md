# Handoff

One rolling file. Update it at the end of a session rather than adding another.
Session narrative belongs in git history; what belongs here is the state of the
station, what is waiting on a person, and the things that are true but not visible
in the code.

Last updated 2026-11-06.

## Where things stand

`astro check` and `tsc --noEmit` are both clean. 435 Vitest pass across 44 files,
run against the local Postgres:

```
TEST_DATABASE_URL=postgresql://dgg_radio:local_only@127.0.0.1:54329/dgg_radio_test npm test
```

**Stations are mostly built and not pushed.** `docs/plans/stations.md` is the plan.
Steps 1 to 6 and the first two parts of step 7 are committed on `main` locally:
stations with their own queue, rules, stream and overlays; owners and mods as station
roles; `/stations` to list and create them; `/admin?station=<slug>` for an owner;
moving a queue between stations. Pushing deploys migrations `0028` to `0033`,
which move every existing row to the main station and then rename rooms to
stations in place; each was checked against a database holding rows from
before it. Still to build from step 7: following
and snapshotting another station's rule, per-rule edit grants, the revertable rule
log, and per-station and site-wide stats. Stats still count every station together.

Before that, everything was on `main` and pushed, through `77294b4` on 2026-10-02: the
Last.fm research, the silence-watch fix and socket alerting, the seasonal
emotes, and tier 5 names on the overlay. Checked after the pushes: the deployed
`/health` carries `liveSocket` with the live socket connected, the deployed
`/embed/watchers` links the `r2cdn` stylesheet, and its CSS carries the tier 5
drop-shadow rule.
`npm run build` succeeds. Both halves of the build are worth running before a
push: neither `astro build` nor `tsup` type-checks, so a build failure is a
different failure from a failing `check`.

**Both halves deploy themselves.** Netlify builds the frontend from `main`, and
a webhook rebuilds and redeploys the API stack, which applies migrations
`0019` through `0027` on startup. `docs/deployment.md` describes the setup and
the settings it depends on. `server/index.ts` awaits `migrate()` before it binds
a port, so a container that cannot migrate refuses to serve rather than starting
against a stale schema — which is why an API that answers at all is proof its
migrations applied.

`8e60c79` changes what `/health` returns. It is still `{ok: true, …}` and the
container healthcheck only reads the exit code, so nothing about the deploy
depends on it, but anything that asserts on that body will see a new
`liveSocket` field.

Run the two halves of `npm run check` separately, or at least do not truncate
their output: it is `astro check && tsc --noEmit`, and piping the pair through
`tail` shows only the first summary. A type error reached `main` that way.

`drizzle-kit generate` needs a TTY the moment a table both gains and loses a
column, because it stops to ask whether that is a rename. It cannot be piped an
answer. Split the change into two migrations that are each unambiguous —
`0026` and `0027` are that, additive then destructive — or ask the operator to
run it with `!` in the session.

### The station can see who is watching its stream

The newest and largest part of the station. When the radio streams to a Kick
channel it is watched through `destiny.gg/bigscreen#kick/dggJams`, and Destiny
chat knows who has that embed open. The API reads that and serves it to an OBS
overlay.

`docs/plans/bigscreen-watchers.md` is the plan and the record of every decision;
`docs/research/dgg-embed-watchers-websockets.md` is the measured behaviour of
both destiny.gg sockets. The plan's history graph was built and then removed
(migration `0028`): mitchdev.net/dgg/embeds already records every destiny.gg
embed over time, so the station keeps no history of its own and the admin page
links there instead. What is left is the tracker, the overlay, the emote
somebody last used, a source that keeps its settings, and the motion options.

**Two ways to configure the overlay, both meant.** A query string configures a
source that will then be left alone. `?profile=<the admin's own uuid>` reads
`watcher_embed_settings` instead, so the look can be changed from `/admin#obs`
without reaching the machine OBS runs on: the overlay polls that row once a
second, both ends send `no-store`, and a save lands in a running browser source
without a reload. `?profile=` wins where both are given. Under that link the
admin page also prints the frozen twin — the same settings written into a query
string, for a source that should never change again.

The options are `show`, `window`, `max`, `layout`, `names`, `color`, `enter`,
`motion`, `speed`, `size`, `roam` and `inset`. Seven layouts, and `bump` is the
odd one: bumper cars, everybody bouncing off the frame and off each other. It is
the only layout with a `requestAnimationFrame` loop behind it, because where
somebody goes next depends on where everybody else is; `src/components/bumperMotion.ts`
is the step, pure and tested without a browser.

**Nothing about watching is stored.** The live socket is still held for the
life of the process, because it says whether anybody is on the followed channel
and `/health` reports its state, but its embed list is read and dropped.
`enabled` names the one channel whose chat roster is read; the roster lives in
memory only.

Try it without the station at all:

```
npx tsx scripts/dgg-watch-probe.ts kick destiny
```

`kick/destiny` is the channel to develop against, because `dggJams` is dark most
of the time and a dark channel correctly shows nothing at all.

`stream_watch` is **switched on** in the local database for testing, pointed at
`kick/dariusirl`. Both sockets and the overlay were live on 2026-09-06. It had drifted to `kick/destiny` by
2026-10-02 and was set back to `kick/dariusirl` by hand, because that channel
had 270 watchers and `destiny` was dark. The switch at the top of `/admin#obs` turns the
chat socket off again; the live socket stays up either way, which is also how a
fresh deployment arrives.

### The archive is part of the station now

The QueUp years are no longer a separate list to look at. A track can be saved
to a playlist or requested out of the archive; because the archive holds a
provider id rather than a `media` row, the first person to reach for one pays
for the provider lookup the import skipped, and the answer carries the media id
back so the row stops being unresolved.

`/history` is two tabs — the station's own and QueUp's — with one search box that
queries both, numbered pages rather than a cursor, and the tab, search, genre
filter and page all in the address bar so a view can be sent to somebody.

`/stats` has tabs, a year-and-month filter over every table, and the QueUp years
beside the station's own wherever the two can honestly be counted apart. Every
track and every channel has a page: when it played in either history, who asked
for it, what it is, and what else is like it.

### Genre, and how much of it there is

`track_genres` (migration `0017`) is keyed by the provider's id, so one table
labels both histories. Two sources are kept side by side and never merged.

Against the whole archive:

| | tracks | of 34,248 |
| --- | --- | --- |
| Discogs | 12,320 | 36.0% |
| MusicBrainz | 17,952 | 52.4% |
| **Either** | **21,726** | **63.4%** |
| Both, so cross-checkable | 8,546 | 24.9% |
| About the track rather than its artist | 18,883 | 55.1% |

MusicBrainz doubled on 2026-09-04, and not because the catalogue got better.
The dumps match on an artist and a title read out of the upload title, and only
17,652 of 34,058 uploads are named `Artist - Title` at all. The ceiling was the
question, not the answer. `scripts/youtube-music-identities.ts` reads the Music
card off each video's watch page — 20,093 of 25,220, 79.7% — and hands the dump
importer those names instead. 10,764 matched, 9,694 carried a genre.

Discogs takes the same names by a second route, added 2026-09-05: where a
master carries no embedded video id, its own artist and release title are
matched instead. That is worth 1,840 tracks and no more, because a master in
the dump has no tracklist — only a release title, so it can answer for a single
or a title track and never for track nine of an album. The releases dump does
carry tracklists and is the way to do better; it is 10 GB and was not needed to
find that out.

Discogs otherwise comes from its CC0 monthly dump, joined exactly on the ids it
embeds in masters. MusicBrainz comes from its dumps too, and the interesting
part is *why*: its URL relations only reach 6.6% of the archive, and what
actually pays is a fuzzy match on artist and title parsed from the upload title
— worthless over an API at one request a second, free once the tables are local.
`docs/research/discogs-dump-genre-coverage.md` has the full table and the
correction it forced.

### Deploying carries the data

`data/legacy-plays.json.gz` (48,182 plays, 3 MB) and `data/genres.json` (31,926
answers, 9 MB) are committed, and `src/server/seed.ts` applies them at startup
right after migrations. So a deployment gets two years of history and everything
known about it without fetching a byte of anyone's data dump.

Each file is read once. `seed_state` (migration `0018`) holds a digest of the
bytes that were applied, because without it every restart offered 68,000 rows to
PostgreSQL to be told each one was already there — 3.7 seconds before the station
could serve, spent to change nothing. Regenerating a file changes its digest and
it applies again by itself. The log says which happened, so the skip is visible
rather than merely claimed.

Both seeds **only fill gaps**. A row the database already has is left exactly as
it is, so anything learned since — a play brought across last week, a genre
worked out against the running database — survives every later deploy. Verified
by editing a stored answer, deleting others, and redeploying: the edit stood and
the gaps filled.

### New tracks look themselves up

`src/server/enrichment.ts` runs the first time the station stores a track: identity
from the video's own YouTube Music card, falling back to splitting the upload
title, then MusicBrainz and Discogs, both stored. It is queued, bounded, and
never on the request path — a request is accepted, the station plays, and the genre
appears a poll or two later.

`/admin#server` has a button that brings across whatever QueUp has played since
last time. It reads the newest pages and stops at the first page it already
knows, so pressing it twice finds nothing the second time. Measured: 71 plays
across 5 pages, then 0 across 1.

### The stats page stopped being the slow one

`/api/stats` was 450ms, and `pg_stat_statements` put 435 of them in the genre
counts. It ran per play; genre is a property of the track. Labelling each track
once and weighting by its play count, and grouping where it used to `distinct
on`, took the page to 246ms and its month-filtered view from 86ms to 36ms.
Byte-identical over all 925 genres, not only the twenty a page shows.

`pg_stat_statements` is not in the repo. It was enabled on the local database
with `ALTER SYSTEM SET shared_preload_libraries` and a restart, which persists in
that volume; `ALTER SYSTEM RESET` and another restart undoes it. Worth the two
minutes before guessing at any query again — it named the query immediately, and
both standing theories about that query were wrong.

### A slow request says so, and only the deployed station says it

`src/server/app.ts` times `/api/*` and writes `api_request_slow` when a request
takes more than a second, and writes nothing otherwise. That is the whole design:
a healthy server is silent, which is what makes it free to sit in front of
`/api/station` at a poll every fifteen seconds per open station. In PostHog, insight
`qz51WBuF` counts the event hourly and an alert fires on any value above zero.

It measures the time the server spent producing a response, not the time anyone
waited for one. A response nobody receives still counts as delivered, which was
true of `data_exported` before this too.

Local development reports nothing at all, deliberately. `compose.test.yaml`
blanks `POSTHOG_PROJECT_KEY` for the API and `.env.development` blanks
`PUBLIC_POSTHOG_KEY` for the browser — the browser was the larger leak, since
`astro dev` had been sending pageviews, exceptions and session recordings to the
deployed project for as long as it has existed. Neither needed a code change:
both analytics modules already treat a missing key as send nothing. Source maps
needed nothing either, because `astro.config.mjs` reads `process.env`, which does
not carry `.env`.

The consequence is that analytics cannot be exercised locally at all. That is the
trade, and the point at which a second PostHog project earns its place — one
project per environment is PostHog's own recommendation. One project with an
environment property is the wrong shape: every insight and alert would silently
include development data unless each remembered to filter.

### The trackers went blind for days and nothing said so

On 2026-09-24 both destiny.gg sockets were dead in production while working
locally. It was not the socket code: **tailscaled on the host had an empty
upstream resolver list** and was answering `no upstream resolvers set, returning
SERVFAIL` to every public name. `*.ts.net` still resolved, so the box looked
fine. destiny.gg, PostHog and Cloudflare's own `argotunnel.com` lookups all
failed together; the tunnel kept serving because it holds established
connections. `sudo systemctl restart tailscaled` repopulated the list from the
system's `192.168.1.1` and both sockets recovered on their own within a minute.

Three things worth keeping from it.

**Only one socket was actually broken.** The chat socket being down is the
designed consequence of the live socket being down — `applyGate()` only holds
chat open while `embeds.entryFor(channel).count > 0` or an overlay is connected.
Diagnosing it as two faults wastes time.

**The host is still on the arrangement that failed.** MagicDNS with no tailnet
resolvers, forwarding to a `192.168.1.1` that tailscaled remembers rather than
re-reads, in `direct` mode because it could not identify a resolv.conf manager
(`dns: [rc=unknown ret=direct]`). There is no code path that re-derives that list
once it is empty, so nothing self-heals; it just serves SERVFAIL until somebody
restarts the daemon. The durable fixes are the systemd-resolved integration, or
tailnet-wide nameservers with Override DNS servers on. Neither is done. A
NextDNS entry exists in the tailnet but is inert while that toggle is off.

**A pushed alert cannot cover this class of failure.** The DNS outage that killed
the sockets killed PostHog by the same stroke, so any event about it was dropped
with everything else. `watch_socket_down` now fires once when the live socket has
been down five minutes, which covers destiny.gg going away or a wedged socket,
and `/health` carries `liveSocket` for something outside the host to poll, which
is the half that would have caught this one. **Nothing polls it yet.** That is an
uptime check somebody has to set up, and until it exists the station can still go
blind quietly.

## Waiting on a person

1. **The bumper layout has had a glance, and only a glance.** On 2026-09-24
   the operator looked at it moving and reported it fine. A hidden browser tab
   runs no animation, so before that it had never once been seen running.
2. **The overlay has been judged by one pair of eyes.** How it reads over a real
   stream, at a real size, is one operator's opinion so far. The four destiny.gg
   socket clients likewise have had one reviewer.
3. **Nothing polls `/health` from outside.** `watch_socket_down` covers a socket
   the station can still report on; the `liveSocket` field on `/health` covers the
   case where the host cannot reach PostHog at all, which is what happened. It
   is only useful once something checks it. Any uptime monitor that can assert
   on a JSON field will do, alerting when `liveSocket.connected` is false or
   `downSince` is more than a few minutes old.
4. **The slow-request alert has never seen real data.** `api_request_slow` has
   not been emitted anywhere, so `qz51WBuF` reads zero and the alert reads
   "Not firing" because there is nothing to fire on, not because it was
   checked. Its threshold was chosen against local timings and production adds
   the tunnel hop; if it nags on ordinary traffic the number to move is
   `SLOW_REQUEST_MS` in `src/server/analytics.ts`. The alert itself needs no
   edit, because it fires on any count above zero.
5. **The beta badge stays**, decided 2026-09-02. The archive and its genre are
   therefore still disposable data by the rule in `AGENTS.md`.
6. **Failed YouTube lookups are not cached.** Successful ones are, so a dead
   video is re-fetched against the metered quota on every playlist import
   containing it. Still a real bug, still unrelated to everything above.
7. **The seed files drift.** They are a snapshot: regenerate with
   `scripts/seed-export.ts` after topping up the archive or running a dump
   import, then commit what changed.
8. **The README says the Chrome extension cannot open a localhost page.** It
   can: `http://localhost:4321/embed/watchers` opened, screenshotted and
   scripted fine on 2026-09-05. `TEST_HOST` still earns its place for OBS on
   another machine, but that sentence is wrong and cost three rounds of blind
   fixes before anybody tried it.

## True but not visible in the code

- **A row count is an estimate, and had to be the second estimate tried.**
  There is no stored row count in PostgreSQL: under MVCC how many rows exist is
  a question about the asking transaction's snapshot, so every exact count is a
  scan and no index removes that. The storage page reads
  `pg_class.reltuples`. `pg_stat_user_tables.n_live_tup` was tried first and was
  wrong here — it is the statistics collector's running tally, a restart had
  reset it, and the two tables the seeds fill and nothing writes to again read
  as 0 and 36 rows beside 24 MB and 11 MB. `reltuples` lives in the catalogue,
  survives a restart, and was within 0.2% of both.
- **Storing Discogs API answers is a decision, not an oversight.** Their terms
  forbid keeping API content durably, which is why the durable table was built
  from the CC0 dump. The station's operator has confirmed permission, so the live
  lookup now writes what it finds like any other source.
- **Both destiny.gg sockets answer 403 to a foreign `Origin`.** They accept a
  request carrying none at all, which is why the tracker is server-side: a
  browser always sends its own origin and cannot be told not to, so the OBS page
  could never connect for itself. Nothing about this is CORS.
- **Chat never broadcasts a change of embed.** It is seen when that person next
  speaks, so `NAMES` on each connect is the only correction and a reconnect is a
  repair rather than a cost. Everything else about the two sockets, including
  why the site's count and the chat roster disagree, is in the research doc.
- **A prerendered island must render the same thing the server did.** The
  watchers overlay read its options out of the query string while rendering;
  the server has no query string, so React kept the server's class and the
  container stayed `watchers-float` however the browser source was configured,
  while its children were built for a row. Twelve absolutely positioned
  watchers with no coordinates stack in the top left corner. Options are read
  in an effect now.
- **A text-shadow hides a gradient name.** Tier 5 (`flair42`, `flair33`) is a
  rainbow gradient visible only through transparent text, and a text-shadow is
  painted over the element's background, so the overlay's black name shadow
  turned those names nearly black. They use `filter: drop-shadow` instead,
  which sits behind the colours. Any new gradient flair needs the same.
- **`zoom` is how an emote grows, not `scale`.** `scale` is painted, so the
  layout box stays 28 pixels and a row of them overlaps itself. `emotes.md` has
  the detail.
- **The overlay draws inside a `text` span because chat-gui does.** Parts of the
  CDN stylesheet are written against the container a chat message puts its
  emotes in: Chatting declares its whole 320px sprite sheet as its width and is
  cut back to one 32px frame only by `.text > .emote.Chatting`. The span takes no
  box of its own — `display: contents` — so it exists for the selectors and not
  for the layout.
- **A copied base rule has to weigh nothing.** chat-gui's `.emote` rule was
  copied in as `.watcher .emote`, which ties with every `.emote.<prefix>` rule
  the CDN declares, and our stylesheet is the one the browser reads second — so
  it won all 24 ties over `background-position` and CuckCrab played 22 frames of
  somebody else's cat followed by 22 of nothing. It is scoped with `:where()`
  now, which is where chat-gui's own sits.
- **destiny.gg's live emotes are on `r2cdn.destiny.gg`, not `cdn.destiny.gg`.**
  The chat page names its CDN in the `data-cdn` attribute of its script tag.
  `cdn.destiny.gg` is an older copy: on 2026-10-02 it still served the normal
  set while chat showed Halloween. Seasonal sets (Halloween, Pride, Christmas)
  are the same prefixes with new images and animations swapped in upstream,
  marked by a different `theme` number in `emotes.json`. The overlay picks them
  up with no change here.
- **Only what upstream repeats is looped, and the browser is asked which.**
  Looping every emote turned OBJECTION's slam and GIGACHAD's arrival into a
  twitch that never stopped. It used to be a hardcoded list in
  `WatchersOverlay.css`, but the Halloween swap changed about 25 emotes' answers
  (BLADE went from repeating to once, GIGACHAD the other way), so a list goes
  stale twice per event. `loopRepeating.ts` now reads each emote's animations
  with `getAnimations({ subtree: true })` and loops those with more than one
  iteration. jsdom has no `getAnimations`, so the DOM test stubs it.
- **A hidden browser tab runs no animation.** Not `requestAnimationFrame`, and
  not the CSS timeline either — a background tab reports zero frames in 600ms
  and `Animation.currentTime` frozen at 0. Every visual check of motion through
  the Chrome extension is therefore a check of a still frame; drive the
  animation by hand (`getAnimations()[0].currentTime = …`) or test it with
  hand-driven frames instead.
- **A chart's colour follows the channel, not its rank.** The period selector is
  a filter, and picking hues by this period's ranking would repaint every
  surviving line whenever it changed. The colour comes from the channel's name,
  with collisions taking the next free hue — the same probe that seats watchers
  on the overlay.
- **A bound parameter is not the same expression twice.** The history query
  buckets time with `floor(extract(epoch from …) / n)`, and binding `n` made the
  copy in `group by` a different expression from the one in `select`: Postgres
  answered by demanding the raw column be grouped, which reads as a broken query
  rather than a badly built one. The width is written into the statement.
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
- **The station's player is a cross-origin iframe**, so the video is a blank
  rectangle in every recording. Understood and accepted.
- **`CF-Connecting-IP` is believed only because the API publishes no port and
  answers nothing but the tunnel.** If a port is ever published, this stops
  being safe.
- **No Cloudflare limit is anywhere near.** The tunnel gives up on an origin
  after 125 seconds, refuses request bodies over 100 MB, and does not cap
  response bodies at all. The slowest endpoint is a quarter of a second and the
  largest response is the `archive` export at 11.66 MB. Checked because a
  timeout would make the server record a delivery nobody received — which it
  would, but nothing here comes close enough for it to happen.
- **`exportCsv` builds the whole CSV as one string in memory.** 11.66 MB for the
  archive today, and it grows with the station. Memory is what will bite first,
  well before anything Cloudflare enforces.
- **`/api/station` is deliberately exempt from rate limiting.** Every open station
  polls it every 15 seconds.
- **A dead session can be recovered from its own transcript.** Codex writes
  `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, one JSON object per
  event; reading back the `response_item` messages gives the whole conversation.

## A local symptom that looks like a station bug

An island that fails to hydrate leaves its prerendered shell on screen, and the
shell has no data. On `/player` that reads as **"The station is quiet. Add the
first track."** with "Reconnecting" in the header, while `/embed/player` carries
on playing correctly. Nothing has fetched `/api/station` on that page at all.

```
[astro-island] Error hydrating /src/components/RadioStation.tsx
TypeError: Failed to fetch dynamically imported module: .../RadioStation.tsx
```

It is a stale Vite module graph, only ever in development, after files have been
added, moved or renamed while `astro dev` was running. The quickest way to tell
is that `curl /api/station` shows the track the page claims does not exist. Restart
the dev server, clearing `node_modules/.vite` if it recurs.

## Mistakes worth not repeating

- **A number measured on the most played tracks is not the number.** The
  MusicBrainz URL join looked like 18% against a sample of the hundred most
  played and turned out to be 6.6% across the archive. The head of a play-count
  distribution is the best known music in the station.
- **A conclusion drawn from one half of a thing is not a conclusion.** That 18%
  was used to write a backlog item saying a MusicBrainz dump would not pay for
  itself. It pays for itself easily — the URL join was simply never the part
  worth having. Build the cheap measurement, not the argument.
- **MusicBrainz genres arrive only from a lookup with `inc=genres`.** The search
  endpoint never returns them, whatever is asked for.
- **Discogs coverage was once called contaminated** because YouTube ids appear
  in `<video>` description text as well as in `src`. The fix was right and moved
  coverage by 0.07 points; the mislabelling blamed on it was Discogs' own data.
- **A handoff outside the repository is one nobody reads.** `5c0e547` made
  `docs/handoff.md` the single rolling file and deleted `docs/handoffs/`, but it
  never touched `.claude/skills/handoff/SKILL.md`, which still said to write to
  the OS temporary directory. So `/handoff` correctly wrote
  `%TEMP%\dggradio-handoff-query-performance.md`, which no search scoped to the
  project can see, while `docs/handoff.md` went on claiming to be the only one.
  A convention changed in `docs/` and not in the skill that writes it is a
  convention that lasts one session. The skill now updates this file.
- **A watchdog that cannot tell connecting from connected reports the wrong
  error.** The silence watch read `lastFrameAt` alone, which survives a
  reconnect on purpose so the admin page can say when destiny.gg was last heard
  from. After any outage past 30 seconds that timestamp is already stale when
  the next attempt begins, so the watch terminated every attempt on its first
  check five seconds in, mid-handshake. Production therefore logged
  `live.destiny.gg closed before the connection was established` while the chat
  socket, which the watch happened not to reach first, logged the `EAI_AGAIN`
  that was the actual fault. The wrong error was on screen for six days.
  `shouldTerminateForSilence` is a pure function now, tested like the two delay
  functions beside it, and a connection still being established is the `ws`
  handshake timeout's to give up on.
- **Three fixes were shipped for a layout nobody had looked at.** The row
  overlay was wrong for one reason — a hydration mismatch meant its stylesheet
  never applied — and each round found a real, unrelated fault instead, because
  each round reasoned about CSS rather than opening the page. The browser was
  available the whole time. Open the thing before fixing the thing.
- **Measuring settled in one step what argument could not.** Whether a row fits
  is arithmetic: twenty-four watchers need 2668px of a 1888px line, twelve need
  1264px. Same for the overlay churn — three to ten of twenty-four slots
  swapping every second, counted off the live socket, which is what justified
  holding the drawn set steady.
- **Re-running a patch to see why it failed applies the parts that worked
  again.** That silently duplicated seventy lines of `contracts.ts`, which
  TypeScript accepted because identical interfaces merge.
- **A missing option is not zero.** `roam` and `inset` were the first overlay
  options whose valid range includes 0, and `Number(null)` is 0, so every source
  that had never named them would have been read as holding perfectly still
  against the frame edge. The test that caught it is the dull one asserting a
  default for every option.
- **A regex that reads "the selector" reads the first of them.** The emote loop
  generator (since deleted) tested each rule's whole selector string, so every
  alternative after a comma was invisible to it — which is how Chatting was
  classified as unanimated while a rule two commas along said otherwise.
- **The local API container is not rebuilt by editing code.** `astro dev`
  reloads the frontend on save and the Docker API does not, so a route added in
  a session answers 404 until `docker compose … up -d --build api`. It cost a
  round of puzzled staring at a settings panel that sat on "Loading…" for good,
  because the panel swallowed the 404 rather than saying it. This is a local
  development trap only — production redeploys itself.
- **Reading `compose.yaml` is not reading the deployment.** This file said, in
  its own "waiting on a person" list, that a push deploys the frontend and
  somebody must then rebuild the API by hand. That was inferred from the compose
  files and was simply wrong: `docs/deployment.md` and the README both say a
  webhook redeploys the API stack, and the deployed API had the new routes
  minutes after the push. A false blocker at the top of a handoff is worse than
  no handoff, because the next person acts on it. Check `docs/` before writing
  down how something is operated.

- **A page that says what the unmeasured remainder is has to be held to it.**
  The storage page ended by calling everything it had not measured PostgreSQL's
  own catalogues. Three features added tables without touching `storage.ts`, so
  that sentence quietly came to cover a quarter of the database, `track_genres`
  included — the second largest table in it. The fix that matters is not the
  grouping but the test that reads the table list out of the schema: a claim
  about a total needs something that fails when the total stops being true.
- **Measure the alternative before recommending against it.** "That is a lot of
  data" was asserted twice before anybody generated a year of synthetic rows and
  measured the shapes: 65 MB as text, 44 MB referenced, 11 MB hourly, 1.8 MB as
  an array per channel per day. The recommendation changed once the numbers
  existed, and so did the advice about which lever to pull first.

## Suggested skills

- **`diagnosing-bugs`** for anything slow or broken. Its measure-before-theorise
  order is what caught that both standing theories about the stats query were
  wrong; guessing has a poor record in this repository. It earned its place
  again on 2026-09-24: its insistence on a red loop before a hypothesis is what
  established that destiny.gg listed the followed channel while production
  claimed it did not, which is the comparison the whole diagnosis rested on. Its
  other rule — no regression test without a correct seam — is why the fix moved
  the watchdog's decision into a pure function instead of the test growing a
  WebSocket server to watch the bug indirectly.
- **`marcoshernanz`** before adding configuration or an abstraction. It is the
  argument against the speculative version of whatever is being built, and it is
  what settled blanking a key over standing up a second PostHog project.
- **`research`** when a question needs primary sources, such as a provider's
  limits or terms. It writes to `docs/research/`, which is where this project
  keeps that kind of finding.
- **`claude-in-chrome`** before changing anything visual. It opens a localhost
  page despite what the README says, and three rounds of overlay fixes were
  spent reasoning about CSS that a single screenshot disproved. It cannot show
  motion — see the hidden-tab note above — but computed styles read from the
  live page settle CSS arguments outright.
- **`dataviz`** before drawing anything. The station has no charts since the
  embed history went, and d3 went with it.
- **`unslop`** on anything written for a person to read, this file included.
- **Not `/handoff` from the user's global skills.** There are two, and they say
  opposite things. The global one at `~/.claude/skills/handoff` writes a new
  timestamped file under `handoffs/`; this repository's own, in `.claude/skills/`
  and `.agents/skills/`, says to update this file and to create no second
  handoff anywhere. The repository's wins — a folder of dated handoffs is
  exactly what `5c0e547` deleted. The global skill fires on the bare
  `/handoff`, so the next session will hit this too and should say so rather
  than quietly writing the second file.

## Next

**Set something to poll `/health`.** `8e60c79` is deployed, but on its own it
changes nothing an operator would notice, because the half of it that would have
caught the September outage is the `liveSocket` field, and nothing looks at that
field yet. An uptime check that alerts when
`liveSocket.connected` is false, or `downSince` is more than a few minutes old,
is the smallest thing that closes the loop. Until it exists the station can still
go dark quietly, which is the actual lesson from that week rather than the
socket bug.

The DNS arrangement underneath it is also unchanged. See the incident section
above: the restart cleared the symptom and nothing stops it recurring.

`watch_socket_down` needs an insight and an alert in PostHog, the way
`api_request_slow` has `qz51WBuF`. Neither event has ever fired in production,
so both alerts read "not firing" because nothing has tested them.

The overlay wants one honest look over a real stream at real size. The bumper
layout has now been seen moving and looks right, so what is left is how the
whole thing reads at broadcast size.

After that, the genre work below is still the larger prize.

The one thing that moves 37% upward: the per-track pass in
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

**Last.fm is researched and parked**, decided 2026-09-06. Not planned, not
queued, nobody waiting on it. `docs/research/lastfm-api-capabilities.md` has the
measurements, and the short version is that Last.fm has no playlist API at all,
that its track-level tags answer 3.3% of what the station cannot already label, and
that its artist-level tags answer 91.0% for eighty minutes of requests. A
username-only importer of loved and top tracks resolved 95.0% of 80 real tracks
to playable videos. `LASTFM_API_KEY` and `LASTFM_API_SECRET` are in `.env` and
the production callback is registered, so the flow is verified and idle rather
than half-built. Nothing in the repository imports either variable.

The prototypes under `scripts/*.prototype.ts` are superseded by the shipped
modules and can go.

Two smaller things the query work left on the table, both in stats and both
visible in `pg_stat_statements` once it is on: a track aggregate at 72ms and a
count at 55ms. Neither is worth the change on its own yet.
