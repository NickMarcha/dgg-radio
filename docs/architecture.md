# Architecture

## Runtime split

Netlify serves the generated Astro files. The browser calls one Hono API and keeps one WebSocket open to it. The Hono process owns the playback clock and writes durable state to Postgres.

```text
Browser on Netlify
  |-- HTTPS --> Hono API
  |-- WSS ----> station change notifications
                  |
                  +-- Postgres
                  +-- Destiny OAuth and user info
                  +-- YouTube Data API and public web search
                  +-- SoundCloud api-v2 through soundcloud.ts
```

WebSocket messages only announce a station revision. The browser then fetches its own station snapshot over authenticated HTTP. This avoids putting private user state into a shared broadcast and keeps one response schema for initial load, reconnects, and live changes.

The API, its Postgres, and a Cloudflare tunnel run as one compose stack; see the README for how it is deployed.

## Station state

Every page shows the same header: who is signed in, and how many people are listening across every station. `GET /api/me` answers exactly that from the session cookie. Only the station itself reads the whole snapshot, over its own WebSocket, so opening `/history` or `/playlists` does not pull down a queue, its votes, and the rule list to render a username.

`stations` names each station. `station_state`, `station_settings` and `stream_watch` hold one row per station, keyed by `station_id`. The main station's id is fixed by the migration that created `stations` and is `MAIN_STATION_ID` in `src/server/stations.ts`. Queue items, rotation seats and rules each belong to one station, and every queue transition names the station it acts on. A station's owner and mods can take it off air (`station_state.on_air`): it then refuses requests, playlist imports and queue moves with `STATION_OFF_AIR`, lets the track playing finish, and starts nothing after it. Waiting queues keep their place, and going back on air starts the next track straight away. Both switches are written to the moderation log. Someone a site admin has whitelisted creates a station on `/stations`, becomes its owner, and runs it from `/admin?station=:slug`, which shows an owner the Station and OBS tabs and keeps the site's own tabs for site admins. `MAX_STATIONS_PER_OWNER` in `src/server/stations.ts` is one, and is the only thing to change to allow more. A new station starts with the default settings, no rules, and no stream. `docs/plans/stations.md` is the plan for the rest.

A station is addressed by its slug. Routes that belong to one station sit under `/api/stations/:slug`, and the main station is `main`. Routes keyed by a queue item or a rule stay where they are and find the station from the item. The station socket names its station when it connects (`?station=`), so listener counts, skip ratios and change notices are all per station; a socket naming a station that does not exist is closed with code 4404, which the browser does not retry. Each station follows its own destiny.gg channel in `stream_watch`. One chat socket serves all of them, because every chat event says what its user is watching: the tracker keeps a roster per followed channel and feeds each frame to all of them, and the watcher overlay is pushed the snapshot of the station its URL names. An owner's saved overlay look stays theirs rather than the station's, since the overlay URL already names the station. The site serves stations other than the main one at `/s/:slug` from one generated page, and a page with no station of its own, such as history or playlists, queues into the station this browser last opened.

Queue transitions take a Postgres transaction-scoped advisory lock keyed by the station, so stations never wait on each other. A partial unique index also prevents two queue items in one station from holding `playing` status. The server clock checks every station once per second, marks an expired item as played, selects the next request, revalidates its media metadata, and starts it from one server timestamp.

The browser computes playback position as:

```text
server-adjusted current time - queue item started time
```

Players seek when drift exceeds 2.5 seconds and check drift every 10 seconds.

## The DJ rotation

Everyone keeps their own queue, ordered by `queue_items.position` and as long as they like. The station plays across those queues rather than through one shared list.

A `station_seats` row is a place in one station's rotation, numbered from the `dj_rotation_seq` sequence, and exists only while its holder has something waiting there. It is keyed by user, so a listener queues in one station at a time: queueing elsewhere while holding a seat is refused with `QUEUED_ELSEWHERE`, and the station page then offers to move the queue. `planQueueMove` says what would come along and what the new station would refuse, checked by the same `assertAdmissible` a request goes through; `moveQueue` moves the rest in order to the back of the new station's rotation and drops the refused tracks with a notice saying why. A track already playing in the old station finishes there. Queueing a track while holding no seat takes one at the back. The next track is always the front seat's lowest position.

A finished track sends its requester to the back if they still have something waiting, and otherwise gives up their seat until they queue again. Cycling deliberately happens when the turn **ends**, not when it starts: someone whose queue is briefly empty would otherwise leave the rotation and rejoin an empty back, taking two turns in a row. Because the playing DJ still holds their seat, the station queue sorts them last for display, which is where they are about to be.

The station queue shows one track per person in turn order. A listener's own queue comes down separately in `myQueue`, where they can reorder it or take a track back out before it plays. Withdrawing records no moderation action, refuses anything that is already playing, and gives up the rotation seat when it was the last queued track, the same as finishing one.

A station's mods and owners can reorder its queue. This renumbers `station_seats`, not anyone's private track positions. The current DJ's next turn stays last until the playing track ends, preserving one turn per person. Both queue controls support moving one step or straight to the top or bottom.

## Identity and permissions

The local user key is Destiny's stable `userId`, not the username. Each login refreshes username, status, roles, and features.

Roles live in the database, at two levels. `users.role` is site-wide and is listener or admin. Running a station is a station role in `station_members`: an `owner` changes the station's settings, rules, stream and overlays and picks its moderators, and a `mod` blocks tracks, skips the current one, reorders the station queue, and edits the station's rule lists. A site admin acts as an owner in every station without a membership row. `users.can_create_stations` is the whitelist of who may create a station, and only a site admin changes it. Names in `ADMIN_DGG_USERNAMES` are root admins, and the API refuses to demote them.

A route that acts on a queue item or a rule is judged by the station that item or rule belongs to, not by a station named in the request, so moderating one station never reaches into another. The server, the exports, the archive, the moderation log and the people list stay with site admins.

Sign-in grants exactly one role, admin, and only to a configured root admin. Destiny's own `ADMIN` and `MODERATOR` roles are read from the identity and stored, but not acted on: no login has yet delivered either, so the mapping was never confirmed and is off until it can be. Signing in never overwrites a role granted inside the radio.

Team is read from how someone talks in Destiny chat rather than from OAuth, which never delivered a team flair. The `features` array itself arrives populated, and username colours are read straight out of it, so the mechanism was never the problem: `flair35` and `flair36` simply never appear in it, which may mean team is not expressed as a flair at all. On the first sign-in, and on request from your own profile at most once a day, `polecat.me` is asked how many times that username has said each counted word. Someone whose yee and pepe messages are at least three quarters one way takes that side; anyone more mixed, or silent, has none. Team never affects permissions.

Usernames are coloured the way Destiny chat colours them, from the flairs in the
OAuth `features` array. Which flair wins is decided by the source order of the
upstream stylesheet rather than by anything explicit; `flairs.md` covers the
trap in that. The winner is resolved once at sign-in and stored on
`users.flair`.

The same pass counts nine dancing and music emotes, and the most used one becomes that person's avatar wherever a name appears. Every raw count is kept in `user_chat_counts` rather than only the two values derived from it, so a surprising team or emote can be read back instead of guessed at.

That is eleven requests per person against an API allowing sixty a minute, which shapes the design: checks run one at a time process-wide, they stop rather than wait when a window is exhausted, and the first one runs *behind* the login instead of in front of it. A chat search that is slow or down must never be why nobody can sign in, so a failed check leaves the stored counts alone and the person keeps whatever they had, defaulting to the `MMMM` emote until a check succeeds.

The app discards Destiny access and refresh tokens after fetching user info. It issues an independent random 30-day session token, stores only its SHA-256 hash, and sends the token in an HTTP-only cookie. State-changing endpoints enforce the configured frontend origin.

Destiny redirects to `/auth/callback` on the frontend, which posts the code to the API. The registered redirect is therefore tied to the stable public site rather than to wherever the API happens to run.

## Rules

A rule belongs to one station and is a named reason that station's mods can block something. A `blocklist` rule accumulates the tracks and artists that broke it, so blocking a song under one teaches the station that rule. The station's owner alone creates, edits, reorders, disables, and deletes its rules; its mods add to and remove from the lists. An `advisory` rule keeps no list and exists to be read on the player.

`rule_entries` is unique on rule, provider, entry type, and provider ID, so one track can be listed under several rules and the station names every reason it was rejected. An `artist` entry covers a whole catalogue by provider artist ID; a collaboration released under someone else's channel needs its own `track` entry.

A station can also follow another station's rule (`rule_follows`): the rule is then enforced there exactly as its home station keeps it, tracks blocked later included, and the follower cannot edit it. Copying a rule instead makes an independent rule of the station's own from that list. Who may edit a list is asked of the rule, not of a station role: the home station's owner and mods, anyone granted it by name, and the owner and mods of a station granted it (`rule_editors`). Blocking under a rule drops the covered tracks waiting in every station that enforces it. Every add and remove on a list is logged in `rule_changes` with who made it, and the home station's owner can undo any logged change once.

`rules.position` holds the order admins arrange, and the admin list and the player both read it, so the station can lead with the rule that matters most. A reorder sends the whole list and is refused unless it names every rule, so a rule created or deleted in another tab cannot half-apply an order built from a stale list.

Switching a rule off hides it from listeners and stops it being enforced while keeping its list, so it can be paused and restored.

## Repeat cooldown

`station_settings.repeat_cooldown_seconds` is how long the station waits before the same track can be requested again. It defaults to 90 minutes and a database check keeps it between five minutes and 30 days, which is what the admin form offers as minutes, hours, or days.

The clock starts at `queue_items.started_at`, not at the end of a track. A skipped song therefore counts as played, so downvoting something is not a way to queue it again straight away. A repeat is matched by provider and provider media ID through the `media` row, so the same video submitted under a different URL form is still the same track.

`enqueueMedia` checks the window after the active-duplicate check, which keeps `ALREADY_QUEUED` for a track that is still waiting or playing and `TRACK_RECENTLY_PLAYED` for one that already had its turn. `startNextTrack` runs the same check with its own candidate excluded, so raising the cooldown while a request waits drops it at playback time rather than letting it through. Both call one helper, which takes an optional current time so the boundary can be tested exactly rather than approached with sleeps.

## Personal playlists

`playlists` and `playlist_items` hold a private, ordered library per listener. Every query names both the playlist and the owner, and a playlist belonging to someone else answers the same `PLAYLIST_NOT_FOUND` as one that does not exist, so the API never confirms that another listener's playlist is there.

`playlist_items` stores only a `media` reference and a position. Nothing about a track is copied, so a title or artwork refreshed by a later lookup appears in every playlist holding it. The composite primary key on playlist and media makes saving and removing idempotent and rules out the same track twice in one playlist. Membership changes lock the playlist row first, so two tabs cannot claim one position or push the 50-track limit past itself.

Saving is deliberately not admission. It runs no duration check, blocklist check, repeat cooldown, or active duplicate check, so a blocked or recently played song stays saved and can be queued once the station allows it again. The heart control on the player and on history saves an existing `media.id` and asks no provider anything. Pasting a link or saving a search result from the playlists page goes through `resolveMediaForLibrary`, which looks the track up and stores it: an unknown link has no title, artist, or duration until a provider answers for it. A link naming a whole YouTube playlist or SoundCloud set takes `resolvePlaylistForLibrary` instead, which lists its tracks, warms them through one parallel inspection, and stores each one; the caller reports the tracks a provider could not describe and stops storing once the 50-track limit is reached rather than failing the whole import. Both paths read the inspection rather than the admission view, so a track that is region blocked, age restricted, or not embeddable still saves. Only a link a provider cannot describe at all fails, because there is nothing to save.

Queueing goes back through `enqueueMedia`, the same function a pasted link uses; no playlist route writes to `queue_items` itself. A whole playlist walks its tracks in position order and may partly succeed, reporting each rejected track with its reason and leaving the saved playlist alone. Only a queue action bumps the station revision and broadcasts: renaming, saving, reordering, and deleting are private and never reach the station socket.

## Media lookups

The queue stores provider IDs rather than trusting arbitrary embed markup.

YouTube validation reads metadata from `videos.list`. The region check inspects `contentDetails.regionRestriction` against the station's `targetCountry`; `regionCode` cannot be combined with an ID lookup. That `targetCountry` is chosen from YouTube's own `i18nRegions` list rather than typed as an ISO code, because that list is the set of countries its checks recognise, and it is shorter than the ISO table. The backend also checks embedding, age restriction, processing and privacy state, live status, and duration.

SoundCloud's documented API now requires a paid subscription, so `soundcloud.ts` talks to the same `api-v2` endpoints the website uses and discovers the public web client ID itself. That ID rotates, and the library only looks one up when it holds none, so a `401` forces a fresh one and retries once.

YouTube search goes through `@distube/ytsr`, which reads YouTube's public web response without spending Data API quota. This is an unofficial response format, so the search adapter treats failures as temporary and keeps them separate from validation. SoundCloud and YouTube searches run together; one provider can still return results if the other fails.

Selecting a YouTube result does not trust the search response. It enters the normal request path and calls `videos.list`, which costs one quota unit, before the track is stored. Playlist imports follow the same path for every item. `playlistItems.list` costs one unit per page.

Answers are cached in `media_lookups`, keyed by YouTube video ID or SoundCloud permalink path so URL variants collapse to one entry. A row keeps the metadata, the playback issue if there was one, and the countries YouTube allowed or blocked.

Nothing stored is about one region. `videos.list` returns the whole `regionRestriction`, so a single lookup already answers for every country; the row keeps those lists and the verdict is worked out on each read against the station's current `targetCountry`. Moving the playback region therefore re-reads the same rows instead of asking YouTube about every track again.

How long a row stands:

1. A row recording a playback issue stands for an hour. A video being non-embeddable or age restricted, or a track not streaming, is the kind of answer most likely to change on its own, and an hour is long enough that repeatedly queueing a saved playlist full of unplayable tracks costs one lookup each rather than one per press.
2. Any other row stands for a day, because a track can be pulled, made private, or restricted after it was accepted and neither provider says when. A video blocked in the station's region keeps this ordinary life: nothing about the video is wrong, and its country lists rarely move.

A failed recheck leaves the old row and throws, so the next attempt checks again rather than serving something known to be stale.

Both providers are checked once at insertion and once before playback, but the second check usually hits the cache, so it only reaches a provider for a track that waited more than a day. Runtime player failures are the backstop for a track that breaks in between.

A provider answers two questions at once: what a track is, and whether this station can play it. `inspectMedia` keeps them apart, returning metadata alongside a `playbackIssue` for a video that is not embeddable, is age restricted, is blocked in the playback region, or is a SoundCloud track that will not stream. `lookupMedia` is the admission view over it and throws that issue, so every queue path behaves as before. The personal library reads the inspection directly and saves the track anyway.

An issue is cached alongside the metadata, so a refused track costs one lookup rather than one per attempt, and a cache hit refuses it again rather than letting it through.

The region list has its own cache in `playback_regions`, refreshed after 30 days and replaced wholesale so a country YouTube has withdrawn disappears rather than lingering. A refused request throws and leaves the stored rows alone, so a quota failure keeps serving the previous list instead of emptying the field. It lives in the database rather than in memory so restarting the API does not spend another request.

## Statistics

Votes belong to a queue item, not just a media ID. This preserves how the station responded to each play over time. Nobody may vote on their own request. Enough downvotes skip a track, counted either absolutely or as a share of listeners depending on the station's `skip_mode`.

Jammer score is the sum of received votes across all started requests. The station snapshot returns the top ten users by score, then number of plays.

The most played list counts the same started requests, grouped by media rather than by requester, so a track queued by several people accumulates one total. A skipped play still counts: the station heard it and voted on it.

Every stats and history read takes an optional `?station=<slug>`; without one it covers every station together. The QueUp archive is the main station's past (`archiveCountsFor` in `src/server/stations.ts`), so it counts for the main station and for the site, and is empty for any other station. A station's listener count is the people who have had a track play there, since an account belongs to no station; site-wide it is every account. The station page's Top Jammers counts that station alone.

The public read model is exposed separately from the authenticated station snapshot:

- `/api/stats` returns station totals, the jammer leaderboard, PEPE/YEE/unassigned team totals, and the most played tracks.
- `/api/history` returns completed and skipped tracks, newest first.
- `/api/profiles/:username` returns one listener's request totals, vote averages, and play history. Username lookup is case-insensitive.

The generated `/stats`, `/history`, and `/profile/*` pages consume those endpoints. Netlify rewrites profile paths to the single generated profile shell, so usernames can be linked directly without generating a page for every listener.

When `reveal_requester` is off, requesters are hidden from listeners across the current track and the queue, revealed on the current track in its closing seconds, and always visible to the station's mods and owners and to the requester themselves.

## Project stage

The station header carries a `beta` badge. `AGENTS.md` treats it as the marker for when stored data starts mattering: while it is present, migrations may drop or rewrite tables.
