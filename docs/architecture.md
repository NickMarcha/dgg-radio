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
                  +-- SoundCloud API
```

WebSocket messages only announce a room revision. The browser then fetches its own room snapshot over authenticated HTTP. This avoids putting private user state into a shared broadcast and keeps one response schema for initial load, reconnects, and live changes.

## Room state

`room_state` and `room_settings` are singleton rows constrained to ID `1`. There is no room identifier anywhere else because this product has one room.

Queue transitions take a Postgres transaction-scoped advisory lock. A partial unique index also prevents two queue items from holding `playing` status. The server clock checks once per second, marks an expired item as played, selects the next request, revalidates its media metadata, and starts it from one server timestamp.

The browser computes playback position as:

```text
server-adjusted current time - queue item started time
```

Players seek when drift exceeds 2.5 seconds and check drift every 10 seconds.

## Round robin

Each user can hold up to five waiting requests. For the next turn, the server selects the user whose last play is oldest, with users who have never played first. It then takes that user's oldest request. For display, the same rule is simulated across the whole waiting queue, one request per user per pass.

## Identity and permissions

The local user key is Destiny's stable `userId`, not the username. Each login refreshes username, status, roles, and features.

The radio role is `admin` when DGG reports `ADMIN` or `MODERATOR`, or when the username is listed in `ADMIN_DGG_USERNAMES`. Everyone else is a listener. Team is derived separately from `flair35` and `flair36` and never affects permissions.

The app discards Destiny access and refresh tokens after fetching user info. It issues an independent random 30-day session token, stores only its SHA-256 hash, and sends the token in an HTTP-only cookie. State-changing endpoints enforce the configured frontend origin.

## Media restrictions

The queue stores provider IDs rather than trusting arbitrary embed markup. Exact provider-and-ID pairs can be blocked with a reason and moderator audit record.

YouTube validation reads metadata from `videos.list`. The UAE check inspects `contentDetails.regionRestriction` for ISO country code `AE`; `regionCode=AE` cannot be combined with an ID lookup. The backend also checks embedding, age restriction, processing/privacy state, live status, and duration.

SoundCloud URLs go through the official resolve endpoint. Only one streamable track is accepted.

Both providers are checked once at insertion and once before playback. A transient provider failure leaves the next request queued and retries on the next clock tick. A permanent failure removes the request with the reason recorded.

## Statistics

Votes belong to a queue item, not just a media ID. This preserves how the room responded to each play over time. Selector score is the sum of received votes across all started requests. The room snapshot returns the top ten users by score, then number of plays.
