# DGG Radio

DGG Radio is one shared music room for the Destiny.gg community. Listeners sign in through Destiny, request YouTube or SoundCloud tracks, take turns through a round-robin queue, and vote on the track that is playing. Moderators can skip, remove, block, and change the room's maximum track length.

The Astro frontend deploys to Netlify. A small Hono server owns OAuth, WebSockets, queue state, playback timing, and Postgres writes. Netlify cannot run the persistent WebSocket server, so that process needs an always-on Node host.

## What works

- Destiny's custom OAuth flow with one-use, five-minute login state
- DGG `ADMIN` and `MODERATOR` roles plus configured radio admins
- Team PEPE and Team YEE from DGG flair features
- YouTube and SoundCloud metadata checks before insertion, cached per track
- UAE YouTube region checks, embeddability, age restriction, live status, processing state, and duration checks
- A second media check immediately before playback
- Fair turns when one person has several requests waiting
- Synchronized YouTube and SoundCloud playback from the server clock
- Per-play upvotes and downvotes with all-time selector scores
- Admin skip, removal, exact-track block, maximum duration setting, and moderation history
- Responsive desktop and mobile room layouts

## Local setup

Requirements: Node 22.12 or newer and Docker.

1. Install packages.

   ```sh
   npm install
   ```

2. Start local Postgres.

   ```sh
   npm run db:up
   ```

3. Copy `.env.example` to `.env` and fill in the provider credentials. The local database URL is:

   ```text
   postgresql://dgg_radio:local_only@127.0.0.1:54329/dgg_radio
   ```

4. Apply the database migration.

   ```sh
   npm run db:migrate
   ```

5. Start the frontend and API together.

   ```sh
   npm run dev
   ```

The room opens at `http://localhost:4321`. The API and WebSocket server use `http://localhost:8787`.

## Provider setup

### Destiny

Create an application at `https://www.destiny.gg/profile/developer`. Register the exact callback in `DGG_REDIRECT_URI`. For local development it is `http://localhost:4321/auth/callback`.

The callback is a frontend route, not an API route. Destiny redirects the browser to `/auth/callback` on the Netlify site, which strips the code from the address bar and posts it to `POST /api/auth/callback`. The API keeps the client secret, owns the login transaction, and sets the session cookie. Registering a frontend URL means the API can move hosts without re-registering anything with Destiny.

Destiny's flow is not standard PKCE. The backend implements the secret-bound challenge described in the project's [OAuth research](docs/research/dgg-oauth-netlify.md). Keep the client secret on the API host.

Radio admin access is granted when either condition is true:

- Destiny returns `ADMIN` or `MODERATOR` in the user's roles.
- The username appears in `ADMIN_DGG_USERNAMES`.

The second option covers room-specific moderators who do not moderate the full DGG site.

### YouTube

Enable YouTube Data API v3 in a Google Cloud project and set `YOUTUBE_API_KEY`. Restrict the key to that API. The backend rejects a video when `AE` is blocked, an explicit country allow-list omits `AE`, embedding is disabled, the video is age-restricted or live, processing is incomplete, or its duration exceeds the room setting.

### SoundCloud

SoundCloud's own API needs a paid subscription, so track metadata comes from the `automation-lab/soundcloud-scraper` actor on Apify. Set `APIFY_API_TOKEN`. Each submitted SoundCloud link is one synchronous actor run in `trackUrl` mode, taking roughly two seconds and costing well under a cent. The backend accepts items whose type is `track` and which the actor reports as streamable.

A track is looked up twice: once when it is submitted and once again just before it plays. Both go through the `media_lookups` cache, so the second one usually costs nothing.

### Lookup cache

Provider answers are stored in `media_lookups`, keyed by YouTube video ID or SoundCloud permalink path, so the same track submitted through different URL forms is one entry.

SoundCloud entries never expire, because an actor run costs money and reports nothing that changes on its own. YouTube entries expire after 24 hours, because a video can become region blocked, age restricted, or non-embeddable after it was accepted. An expired entry is rechecked and overwritten in place; a recheck that fails throws and leaves the previous row untouched, so the next attempt checks again rather than serving a known-stale answer.

One consequence worth knowing: the check just before playback only reaches YouTube for tracks that have been queued more than a day. Anything queued and played inside 24 hours serves the cached answer. Runtime player failures remain the backstop for a video that breaks in between.

## Commands

```text
npm run dev          start Astro and the room server
npm run check        run Astro and TypeScript diagnostics
npm test             run unit and database tests
npm run build        build the Netlify site and Node server
npm run db:generate  create a migration after a schema change
npm run db:migrate   apply pending migrations
npm run db:up        start local Postgres
npm run db:down      stop local Postgres without deleting its volume
npm run stack:up     build and start Postgres, the API, and the tunnel
npm run stack:down   stop the stack without deleting the database volume
```

## Testing

`npm test` runs the unit tests on their own. The room transition tests need a real Postgres, so they skip unless `TEST_DATABASE_URL` points at one. They apply the migrations themselves and truncate every table between cases, so give them a throwaway database.

```sh
npm run db:up
TEST_DATABASE_URL=postgresql://dgg_radio:local_only@127.0.0.1:54329/dgg_radio npm test
```

On PowerShell, set the variable first:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://dgg_radio:local_only@127.0.0.1:54329/dgg_radio'; npm test
```

## Deployment

Netlify serves the static frontend. The API, its Postgres, and a Cloudflare tunnel run as one Docker stack on a self-hosted machine. Netlify cannot hold the WebSocket connections or run the playback clock, so the API is not deployed there.

### API stack

Fill in `.env`, then bring up all three containers.

```sh
npm run stack:up     # db, api, and the cloudflared tunnel
npm run db:migrate   # against the exposed port on the host
npm run stack:down
```

`compose.yaml` overrides `DATABASE_URL` to reach Postgres over the compose network, so the value in `.env` stays pointed at the port published on the host for `db:migrate` and the tests.

The API binds to `127.0.0.1:8787` and reaches the internet only through the tunnel. Set `CLOUDFLARE_TUNNEL_TOKEN` to a named tunnel's token; its public hostname route belongs in the Cloudflare dashboard, pointing at `http://api:8787`. Confirm the tunnel with `docker compose logs tunnel`, which reports one `Registered tunnel connection` line per edge connection.

### Frontend

`PUBLIC_API_URL` is read at build time, so the site must be rebuilt whenever the API origin changes.

```sh
netlify init
netlify env:set PUBLIC_API_URL https://api.example.com
netlify deploy --prod
```

### Origins

Three values must agree, and two of them are only knowable after the first deploy:

- `APP_ORIGIN` on the API is the exact Netlify origin. CORS rejects other origins, and the session cookie only becomes `SameSite=None; Secure` when this is `https`.
- `PUBLIC_API_URL` on Netlify is the tunnel hostname.
- `DGG_REDIRECT_URI` is the frontend callback route, registered byte-for-byte in Destiny's developer page. Register it with no query string: Destiny appends `?code=...&state=...` itself.

## Current limits

- The Team PEPE and Team YEE mapping comes from the current production flair catalog. Verify it with real OAuth responses before using it in public profiles. Team never grants permissions.
- The YouTube Data API check cannot promise playback. A rights holder can add a domain restriction or change availability after validation. The player reports runtime failures so a moderator can skip.
- There is one room by design. The backend serializes its transitions with a Postgres advisory lock. One backend instance is enough; Redis is not part of this version.
