# Architecture

## Runtime split

Netlify serves the generated Astro files. The browser calls one Hono API and keeps one WebSocket open to it. The Hono process owns the playback clock and writes durable state to Postgres.

```text
Browser on Netlify
  |-- HTTPS --> Hono API
  |-- WSS ----> room change notifications
                  |
                  +-- Postgres
                  +-- Destiny OAuth and user info
                  +-- YouTube Data API
                  +-- SoundCloud api-v2 through soundcloud.ts
```

WebSocket messages only announce a room revision. The browser then fetches its own room snapshot over authenticated HTTP. This avoids putting private user state into a shared broadcast and keeps one response schema for initial load, reconnects, and live changes.

The API, its Postgres, and a Cloudflare tunnel run as one compose stack; see the README for how it is deployed.

## Room state

`room_state` and `room_settings` are singleton rows constrained to ID `1`. There is no room identifier anywhere else because this product has one room.

Queue transitions take a Postgres transaction-scoped advisory lock. A partial unique index also prevents two queue items from holding `playing` status. The server clock checks once per second, marks an expired item as played, selects the next request, revalidates its media metadata, and starts it from one server timestamp.

The browser computes playback position as:

```text
server-adjusted current time - queue item started time
```

Players seek when drift exceeds 2.5 seconds and check drift every 10 seconds.

## The DJ rotation

Everyone keeps their own queue, ordered by `queue_items.position` and as long as they like. The room plays across those queues rather than through one shared list.

`users.rotation_seq` is a place in the rotation, taken from the `dj_rotation_seq` sequence, or null for someone with nothing waiting. Queueing a track while holding no seat takes one at the back. The next track is always the front seat's lowest position.

A finished track sends its requester to the back if they still have something waiting, and otherwise gives up their seat until they queue again. Cycling deliberately happens when the turn **ends**, not when it starts: someone whose queue is briefly empty would otherwise leave the rotation and rejoin an empty back, taking two turns in a row. Because the playing DJ still holds their seat, the room queue sorts them last for display, which is where they are about to be.

The room queue shows one track per person in turn order. A listener's own queue comes down separately in `myQueue`, and they can reorder it.

## Identity and permissions

The local user key is Destiny's stable `userId`, not the username. Each login refreshes username, status, roles, and features.

Admins live in the database. Names in `ADMIN_DGG_USERNAMES` are root admins: always admins, and the API refuses to demote them. Sign-in only ever promotes, never demotes, or anyone granted admin on the admin page would lose it at their next login.

Team is derived from `flair35` and `flair36` and never affects permissions. In practice the OAuth `features` array has not been observed to carry either flair, even for an account that has a team set, so auto-detection is written but unconfirmed.

The app discards Destiny access and refresh tokens after fetching user info. It issues an independent random 30-day session token, stores only its SHA-256 hash, and sends the token in an HTTP-only cookie. State-changing endpoints enforce the configured frontend origin.

Destiny redirects to `/auth/callback` on the frontend, which posts the code to the API. The registered redirect is therefore tied to the stable public site rather than to wherever the API happens to run.

## Rules

A rule is a named reason an admin can act on. A `blocklist` rule accumulates the tracks and artists that broke it, so blocking a song under one teaches the room that rule. An `advisory` rule keeps no list and exists to be read on the player.

`rule_entries` is unique on rule, provider, entry type, and provider ID, so one track can be listed under several rules and the room names every reason it was rejected. An `artist` entry covers a whole catalogue by provider artist ID; a collaboration released under someone else's channel needs its own `track` entry.

Switching a rule off hides it from listeners and stops it being enforced while keeping its list, so it can be paused and restored.

## Media lookups

The queue stores provider IDs rather than trusting arbitrary embed markup.

YouTube validation reads metadata from `videos.list`. The region check inspects `contentDetails.regionRestriction` against the room's `targetCountry`; `regionCode` cannot be combined with an ID lookup. The backend also checks embedding, age restriction, processing and privacy state, live status, and duration.

SoundCloud's documented API now requires a paid subscription, so `soundcloud.ts` talks to the same `api-v2` endpoints the website uses and discovers the public web client ID itself. That ID rotates, and the library only looks one up when it holds none, so a `401` forces a fresh one and retries once.

Search is SoundCloud only. YouTube's `search.list` costs 100 quota units against 10,000 a day, where a link lookup costs 1 and `playlistItems.list` costs 1 a page, which is why playlists can be imported in bulk but titles cannot be searched.

Answers are cached in `media_lookups`, keyed by YouTube video ID or SoundCloud permalink path so URL variants collapse to one entry. SoundCloud entries do not expire; YouTube entries expire after 24 hours and are then rechecked and overwritten in place. A failed recheck leaves the old row and throws, so the next attempt checks again rather than serving something known to be stale.

Both providers are checked once at insertion and once before playback, but the second check usually hits the cache, so it only reaches YouTube for tracks queued more than a day. Runtime player failures are the backstop for a track that breaks in between.

## Statistics

Votes belong to a queue item, not just a media ID. This preserves how the room responded to each play over time. Nobody may vote on their own request. Enough downvotes skip a track, counted either absolutely or as a share of listeners depending on the room's `skip_mode`.

Jammer score is the sum of received votes across all started requests. The room snapshot returns the top ten users by score, then number of plays.

When `reveal_requester` is off, requesters are hidden from listeners across the current track and the queue, revealed on the current track in its closing seconds, and always visible to admins and to the requester themselves.

## Project stage

The room header carries a `beta` badge. `AGENTS.md` treats it as the marker for when stored data starts mattering: while it is present, migrations may drop or rewrite tables.
