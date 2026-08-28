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
                  +-- YouTube Data API and public web search
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

Mods and admins can reorder the room queue. This rewrites `users.rotation_seq`, not anyone's private track positions. The current DJ's next turn stays last until the playing track ends, preserving one turn per person. Both queue controls support moving one step or straight to the top or bottom.

## Identity and permissions

The local user key is Destiny's stable `userId`, not the username. Each login refreshes username, status, roles, and features.

Roles live in the database. Admins can assign listener, mod, or admin on `/admin`. Mods may block tracks, skip the current track, and reorder the room queue, but every admin endpoint still requires the admin role. Names in `ADMIN_DGG_USERNAMES` are root admins, and the API refuses to demote them.

Destiny `ADMIN` maps to admin and Destiny `MODERATOR` maps to mod. Sign-in only promotes. It never overwrites a higher role granted inside the radio.

Team is derived from `flair35` and `flair36` and never affects permissions. In practice the OAuth `features` array has not been observed to carry either flair, even for an account that has a team set, so auto-detection is written but unconfirmed.

The app discards Destiny access and refresh tokens after fetching user info. It issues an independent random 30-day session token, stores only its SHA-256 hash, and sends the token in an HTTP-only cookie. State-changing endpoints enforce the configured frontend origin.

Destiny redirects to `/auth/callback` on the frontend, which posts the code to the API. The registered redirect is therefore tied to the stable public site rather than to wherever the API happens to run.

## Rules

A rule is a named reason a mod or admin can block something. A `blocklist` rule accumulates the tracks and artists that broke it, so blocking a song under one teaches the room that rule. Admins alone create, edit, disable, and delete rules. An `advisory` rule keeps no list and exists to be read on the player.

`rule_entries` is unique on rule, provider, entry type, and provider ID, so one track can be listed under several rules and the room names every reason it was rejected. An `artist` entry covers a whole catalogue by provider artist ID; a collaboration released under someone else's channel needs its own `track` entry.

Switching a rule off hides it from listeners and stops it being enforced while keeping its list, so it can be paused and restored.

## Media lookups

The queue stores provider IDs rather than trusting arbitrary embed markup.

YouTube validation reads metadata from `videos.list`. The region check inspects `contentDetails.regionRestriction` against the room's `targetCountry`; `regionCode` cannot be combined with an ID lookup. The backend also checks embedding, age restriction, processing and privacy state, live status, and duration.

SoundCloud's documented API now requires a paid subscription, so `soundcloud.ts` talks to the same `api-v2` endpoints the website uses and discovers the public web client ID itself. That ID rotates, and the library only looks one up when it holds none, so a `401` forces a fresh one and retries once.

YouTube search goes through `@distube/ytsr`, which reads YouTube's public web response without spending Data API quota. This is an unofficial response format, so the search adapter treats failures as temporary and keeps them separate from validation. SoundCloud and YouTube searches run together; one provider can still return results if the other fails.

Selecting a YouTube result does not trust the search response. It enters the normal request path and calls `videos.list`, which costs one quota unit, before the track is stored. Playlist imports follow the same path for every item. `playlistItems.list` costs one unit per page.

Answers are cached in `media_lookups`, keyed by YouTube video ID or SoundCloud permalink path so URL variants collapse to one entry. SoundCloud entries do not expire; YouTube entries expire after 24 hours and are then rechecked and overwritten in place. A failed recheck leaves the old row and throws, so the next attempt checks again rather than serving something known to be stale.

Both providers are checked once at insertion and once before playback, but the second check usually hits the cache, so it only reaches YouTube for tracks queued more than a day. Runtime player failures are the backstop for a track that breaks in between.

## Statistics

Votes belong to a queue item, not just a media ID. This preserves how the room responded to each play over time. Nobody may vote on their own request. Enough downvotes skip a track, counted either absolutely or as a share of listeners depending on the room's `skip_mode`.

Jammer score is the sum of received votes across all started requests. The room snapshot returns the top ten users by score, then number of plays.

The public read model is exposed separately from the authenticated room snapshot:

- `/api/stats` returns room totals, the jammer leaderboard, and PEPE/YEE/unassigned team totals.
- `/api/history` returns completed and skipped tracks, newest first.
- `/api/profiles/:username` returns one listener's request totals, vote averages, and play history. Username lookup is case-insensitive.

The generated `/stats`, `/history`, and `/profile/*` pages consume those endpoints. Netlify rewrites profile paths to the single generated profile shell, so usernames can be linked directly without generating a page for every listener.

When `reveal_requester` is off, requesters are hidden from listeners across the current track and the queue, revealed on the current track in its closing seconds, and always visible to mods, admins, and the requester themselves.

## Project stage

The room header carries a `beta` badge. `AGENTS.md` treats it as the marker for when stored data starts mattering: while it is present, migrations may drop or rewrite tables.
