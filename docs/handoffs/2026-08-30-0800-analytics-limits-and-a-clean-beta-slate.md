# Analytics reached the server for the first time, and the room got limits

Everything below is pushed to `main` and deployed. The working tree is clean.

```
db5357e  Show the moderation log, which nothing has ever read
4d1d70e  Add a script to clear the beta room's history
f3986db  Keep a session replay when something breaks
a0a51ac  Limit what one caller can spend
1927744  Keep Netlify's GitHub token out of PostHog release metadata
f3ad610  Upload browser source maps to PostHog
48094a8  Read the PostHog project token, and refuse any other key
e35517e  Close six backlog items in one pass
```

`e35517e` is a separate pass -- profile playlists, phone layouts, distinct
listener counting, the admin server-activity card, admin tabs, database storage,
and the listener notice when the room drops a pending request. `git show e35517e`
has it.

## The finding worth remembering

Eighteen server events had been instrumented since the project started. **None
had ever arrived.** Ninety days of data held browser events only.

`POSTHOG_API_KEY` held a `phs_` project *secret* key. Capture authenticates with
the `phc_` project token, the same public value the browser is built with. The
failure is silent by construction: PostHog's capture endpoint answers `200 OK`
to any shape-valid key and drops the events downstream, and `posthog-node` logs
"Events sent successfully". Nothing reported it, which is why it lasted the life
of the project.

The knock-on mattered more than the events. `enableExceptionAutocapture` is set
on the server client, so there had been **no server-side error tracking at all**.

Two things came out of that, and both are load-bearing:

- The variable is `POSTHOG_PROJECT_KEY`, so its name says which key belongs in
  it, and `env.ts` requires the `phc_` prefix. A wrong key now stops the
  container at boot. Capture will never fail loudly on its own, so that guard is
  the only place this mistake can ever surface.
- Server and browser events land on the same person, because both halves key on
  the internal user UUID -- `room.me.id` in `RadioRoom.tsx`, `context.get('user').id`
  on the API. Nobody planned that. PostHog's docs call orphaned backend events
  the usual failure, so do not break it.

## Error tracking

Source maps upload from the Netlify build via `@posthog/rollup-plugin`, which
injects a chunk id, uploads the map, and deletes it from `dist`. That last part
also stopped the site publishing source: `vite.build.sourcemap` had been on all
along with nothing consuming it, so every deploy served the full TypeScript next
to the bundles. The repository is public, so nothing leaked.

Two decisions in `astro.config.mjs`, both commented there:

- A build without upload credentials runs unchanged rather than failing. A
  missing analytics credential must never stop a deploy.
- Astro builds more than once and the plugin uploads from each pass, so a deploy
  sends chunks that only ran during prerendering. Telling the passes apart means
  reading `isSsrBuild`, which Astro leaves undefined for some of them. **This was
  tried and reverted.** Getting it wrong uploads nothing and says nothing, which
  is the same silent-failure shape as the key bug. Do not "fix" it without a way
  to name the browser pass that Astro actually guarantees.

`posthog-cli` describes each release with `git remote get-url origin` verbatim,
and Netlify clones with a token in that URL, so the first deploy wrote a live
`ghs_` token into PostHog's release metadata. The build command strips any
`user:password@` first. Reporting it upstream was considered and deliberately
not done; `docs/backlog.md` says why.

Session replay is on, gated by an `$exception` trigger in the project's replay
settings: the recorder holds each session in memory and uploads only the ones
where an exception was captured, so a visit where nothing broke is never sent
and the lead-up to one that did survives. That trigger lives in PostHog, not in
the repo, which is why `src/client/analytics.ts` reads as "record everything" on
its own. Input values are masked and stay masked; a search failure now carries
its query on the exception instead, which is exact and costs nobody else their
privacy.

The room's player is a cross-origin iframe, so the video is a blank rectangle in
every recording. Understood and accepted.

## Rate limiting

There was none. The sharpest exposure was never the YouTube quota: `/api/search`
scrapes youtube.com through `ytsr` from the API's own address, and enough of
that gets the server throttled, which stops search for the whole room.

`src/server/rate-limit.ts` holds fixed windows in a `Map`. One API process holds
every socket and the playback clock, so that is the whole store, and counters
lost on restart cost nothing.

| Route | Counted against | Per minute |
| --- | --- | --- |
| `/api/search` | user | 10 |
| `POST /api/queue`, playlist track add | user | 20 |
| `POST /api/queue/playlist` | user | 5 |
| `/api/me/chat-check` | user | 5 |
| `/api/history`, `/api/stats`, `/api/profiles/:username` | address | 60 |

`/api/room` is deliberately absent: every open room polls it every 15 seconds
and refetches on each change, so an address shared by a household or a VPN would
trip any limit tight enough to be worth having.

`CF-Connecting-IP` is believed **only** because the API publishes no port and
answers nothing but the tunnel. On a directly reachable origin a caller could
write that header themselves and be counted as somebody else. If a port is ever
published, this stops being safe.

## The moderation log

Six places write to `moderation_actions` -- skips, removals, blocks, cleared
queues, queue reorders, settings changes -- and outside tests nothing had ever
read one back. A complete record of who did what, to whom and why had been
accumulating since launch with no way to see it.

`/api/moderation` is admin-only and resolves what was stored as ids: the actor,
the track, and the person whose queue was cleared. `clear_queue` records a raw
user id, so that name comes from one lookup per page rather than a join through
JSON that a malformed value would break -- there is a test for a record whose
`userId` is not a uuid. An action the panel has no caption for is still shown,
spelled as stored.

It is the fifth admin tab, Log, loaded when that tab first opens.

## The beta slate was cleared

`scripts/clear-beta-history.sql` ran against production. Before and after:

```
queue_items 285 -> 0     votes 2 -> 0     moderation_actions 18 -> 0
media 204 (kept)         playlist_items 115 (kept)
```

Four people's rotation positions reset. Five accounts, nine rules, the catalogue
and every saved playlist track survived. The public endpoints were checked
afterwards and the empty state holds: `/api/room`, `/api/history`, `/api/stats`
and `/api/rules` all answer 200 with zeros rather than errors.

The repeat cooldown has no memory now, so everything in the catalogue is
immediately requestable again. That is intended.

The script refuses without `-v confirm=yes`, is a no-op on a second run, and its
header says plainly that it belongs to the beta stage only: `AGENTS.md` makes
the badge in the room header the line after which the stored data is the
community's rather than ours to drop.

## Verification

Nothing was taken on trust, because the bug being fixed was that nobody had
checked:

- The key: two probe events, one per key type -- only the `phc_` one exists in
  the project. Then a real sign-in through the local OAuth stand-in produced
  `user_signed_in` tagged `service: dgg-radio-api`, the first server event the
  project had ever received.
- Source maps: the deployed bundle carries `//# chunkId=`, its `.map` returns
  404, and symbol sets sit under the real commit SHA.
- The token scrub: the release for `19277448…` records a clean remote URL.
- The clear script: run against `dgg_radio_test` first, with its refusal path
  and a second run both checked, before it was ever pointed at production.
- `npm run check` clean, 215 Vitest passing, `npm run build` passing.

`npm test` without `TEST_DATABASE_URL` silently skips the Postgres suites. The
working command takes `POSTGRES_PASSWORD` from `.env`, points at
`127.0.0.1:54329`, and names the database `dgg_radio_test`.

Production is not reachable from a development machine: it is a separate
always-on host behind the tunnel, and its Postgres is bound to `127.0.0.1`
there. The local compose stack is not it.

## Waiting on a person, not on code

- **The Cloudflare rate-limiting rule has not been created.** `docs/backlog.md`
  carries it: `/api/*`, 100 requests per 10 seconds by IP. The Free plan allows
  one rule, counts by IP only, and offers no period longer than ten seconds.
That is the only one left. Two other things were on this list and were dealt
with:

- **The test releases from proving the upload worked** are deleted, along with
  the symbol sets PostHog had auto-created with a failure when it tried to
  resolve a trace and found no matching chunk. Every set now in the project
  traces to a real deploy commit, and none is invalid.
- **Saved queries naming the old `YOUTUBE_BLOCKED_IN_UAE` code** turned out not
  to exist. The project holds eight insights, all PostHog's own onboarding
  templates, no alerts, and nothing referencing any event this room sends, so
  the rename in `785775d` broke nothing. Checked rather than assumed, and the
  item was dropped rather than carried.

Source-map uploads leave about forty symbol sets per deploy, which is the Astro
multi-pass upload described above rather than anything going wrong. Expect that
list to grow at that rate.

## Next

`docs/backlog.md` has seven items and none of them block anything. The
substantial one cannot start yet: judging the PostHog event set needs a few
weeks of the server events that began arriving today. The questions are whether
the properties are right, whether anything should stop being sent, and what is
missing -- the room's own machinery is the likely gap, since a track failing its
playback check, a provider lookup timing out and a socket closing abnormally are
where a diagnosis starts.
