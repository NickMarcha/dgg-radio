# Analytics was never reaching the server, and the API had no limits

Everything below is pushed to `main` and deployed. The working tree is clean.

```
a0a51ac  Limit what one caller can spend
1927744  Keep Netlify's GitHub token out of PostHog release metadata
f3ad610  Upload browser source maps to PostHog
48094a8  Read the PostHog project token, and refuse any other key
e35517e  Close six backlog items in one pass
```

`e35517e` is the earlier pass -- profile playlists, phone layouts, distinct
listener counting, the admin server-activity card, admin tabs, database storage,
and the listener notice when the room drops a pending request. The handoff it
replaced describes it; `git show e35517e` has the rest.

## The finding worth remembering

Eighteen server events had been instrumented since the project started. **None
had ever arrived.** Ninety days of data held browser events only.

`POSTHOG_API_KEY` held a `phs_` project *secret* key. Capture authenticates with
the `phc_` project token -- the same public value the browser is built with. The
failure is silent by construction: PostHog's capture endpoint answers `200 OK`
to any shape-valid key and drops the events downstream, and `posthog-node` logs
"Events sent successfully". Nothing anywhere reported it, which is why it lasted
the life of the project.

The knock-on mattered more than the events. `enableExceptionAutocapture` is set
on the server client, so there had been **no server-side error tracking at all**.

Two things came out of that:

- The variable is `POSTHOG_PROJECT_KEY` now, so its name says which key belongs
  in it, and `env.ts` requires the `phc_` prefix. A wrong key stops the container
  at boot with a message. That guard is the whole point: capture will never fail
  loudly on its own, so this is the only place the mistake can surface.
- Server and browser events land on the same person, because both halves key on
  the internal user UUID -- `room.me.id` in `RadioRoom.tsx`, `context.get('user').id`
  on the API. Nobody planned that; it happened to be right. PostHog's docs call
  orphaned backend events the usual failure, so do not break it.

## Source maps

Every browser stack trace was minified: one real exception reads
`i.getCurrentTime is not a function`. `.env.example` had declared upload
credentials from the beginning and nothing ever ran an upload.

`@posthog/rollup-plugin` in `astro.config.mjs` injects a chunk id into each
bundle, uploads the map, and deletes it from `dist`. That last part also stopped
the site publishing source: `vite.build.sourcemap` had been on all along with
nothing consuming it, so every deploy served the full TypeScript next to the
bundles -- 629KB for `RadioRoom` alone. The repository is public, so nothing
leaked, but nothing was gained by serving it either.

Two decisions in that file, both already commented there:

- The build runs unchanged without credentials rather than failing. A missing
  analytics credential must never be what stops a deploy.
- Astro builds more than once and the plugin uploads from each pass, so a deploy
  sends some chunks that only ran during prerendering. Telling the passes apart
  means reading `isSsrBuild`, which Astro leaves undefined for some of them.
  Getting that wrong uploads nothing and says nothing, which is the same
  silent-failure shape as the key bug, so the wasted upload is the better trade.
  This was tried and reverted deliberately -- do not "fix" it without a way to
  tell the passes apart that Astro actually guarantees.

`posthog-cli` describes each release with `git remote get-url origin` verbatim,
and Netlify clones with a short-lived GitHub token inside that URL, so the first
deploy wrote a live `ghs_` token into PostHog's release metadata. The Netlify
build command now strips any `user:password@` first. **Worth reporting upstream:**
any CI that clones with a token hits this, and PostHog can strip userinfo in one
line.

## Rate limiting

There was none. The sharpest exposure was not the YouTube quota: `/api/search`
scrapes youtube.com through `ytsr` from the API's own address, and enough of
that gets the server throttled, which stops search for the whole room. Queueing
spends one quota unit per uncached video, a playlist import one per fifty, and
the chat check proxies destiny.gg and can trip their limit on the room's behalf.

`src/server/rate-limit.ts` holds fixed windows in a `Map`. One API process holds
every socket and the playback clock, so that is the whole store, and counters
lost on restart cost nothing -- a limit stops a burst rather than keeping a
ledger.

| Route | Counted against | Per minute |
| --- | --- | --- |
| `/api/search` | user | 10 |
| `POST /api/queue`, playlist track add | user | 20 |
| `POST /api/queue/playlist` | user | 5 |
| `/api/me/chat-check` | user | 5 |
| `/api/history`, `/api/stats`, `/api/profiles/:username` | address | 60 |

`/api/room` is deliberately absent. Every open room polls it every 15 seconds
and refetches on each change, so an address shared by a household or a VPN would
trip any limit tight enough to be worth having. That one is Cloudflare's job.

`CF-Connecting-IP` is believed **only** because the API publishes no port and
answers nothing but the tunnel. On a directly reachable origin a caller could
write that header themselves and be counted as somebody else. If a port is ever
published, this stops being safe.

## Verification

Nothing here was taken on trust, because the bug being fixed was precisely that
nobody had checked:

- The key: two probe events, one per key type. Only the `phc_` one exists in the
  project. Then a real sign-in through the local OAuth stand-in against the
  rebuilt container produced `user_signed_in` tagged `service: dgg-radio-api`,
  the first server event the project had ever received.
- Source maps: the deployed bundle carries `//# chunkId=`, its `.map` returns
  404, and 40 symbol sets sit under release `dgg-radio-web@f3ad6109…`.
- The token scrub: the release for `19277448…` records
  `https://github.com/NickMarcha/dgg-radio.git`, clean.
- `npm run check` clean, 206 Vitest passing, `npm run build` passing.

`npm test` without `TEST_DATABASE_URL` silently skips the Postgres suites. The
working command takes `POSTGRES_PASSWORD` from `.env`, points at
`127.0.0.1:54329`, and names the database `dgg_radio_test`.

## Waiting on somebody, not on code

- **The Cloudflare rate-limiting rule has not been created.** `docs/backlog.md`
  carries the exact rule. The Free plan allows one rule, counts by IP only, and
  offers a ten-second period at most, so it is blunt on purpose: `/api/*`, 100
  requests per 10 seconds.
- **Test releases in PostHog.** `dgg-radio-web@local-host-test-ingestion` and
  `@local-verify` came from local builds while proving the upload worked. They
  are not deploys and can be deleted.
- **Saved PostHog queries** may still name `YOUTUBE_BLOCKED_IN_UAE`, renamed in
  `785775d`. Five minutes, inside PostHog rather than in this repository.

## Next

`docs/backlog.md` has six items. Only one is substantial, and it cannot start
yet: judging the PostHog event set needs a few weeks of the server events that
began arriving today. The questions are whether the properties are right,
whether anything should stop being sent, and what is missing -- the room's own
machinery is the likely gap, since a track failing its playback check, a provider
lookup timing out and a socket closing abnormally are where a diagnosis starts.
