# DGG Radio

DGG Radio is one shared music room for the Destiny.gg community. Listeners sign in through Destiny, request YouTube or SoundCloud tracks, take turns through a round-robin queue, and vote on the track that is playing. Moderators can skip, remove, block, and change the room's maximum track length.

The Astro frontend deploys to Netlify. A small Hono server owns OAuth, WebSockets, queue state, playback timing, and Postgres writes. Netlify cannot run the persistent WebSocket server, so that process needs an always-on Node host.

## What works

- Destiny's custom OAuth flow with one-use, five-minute login state
- DGG `ADMIN` and `MODERATOR` roles plus configured radio admins
- Team PEPE and Team YEE from DGG flair features
- YouTube and SoundCloud metadata checks before insertion
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

Create an application at `https://www.destiny.gg/profile/developer`. Register the exact callback in `DGG_REDIRECT_URI`. For local development it is `http://localhost:8787/api/auth/callback`.

Destiny's flow is not standard PKCE. The backend implements the secret-bound challenge described in the project's [OAuth research](docs/research/dgg-oauth-netlify.md). Keep the client secret on the API host.

Radio admin access is granted when either condition is true:

- Destiny returns `ADMIN` or `MODERATOR` in the user's roles.
- The username appears in `ADMIN_DGG_USERNAMES`.

The second option covers room-specific moderators who do not moderate the full DGG site.

### YouTube

Enable YouTube Data API v3 in a Google Cloud project and set `YOUTUBE_API_KEY`. Restrict the key to that API. The backend rejects a video when `AE` is blocked, an explicit country allow-list omits `AE`, embedding is disabled, the video is age-restricted or live, processing is incomplete, or its duration exceeds the room setting.

### SoundCloud

Create a SoundCloud API application and set `SOUNDCLOUD_CLIENT_ID`. The backend accepts resolved objects whose kind is `track` and which SoundCloud reports as streamable.

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

Build and deploy the API first. The host must support a normal Node process, HTTPS, and WebSockets.

- Build command: `npm ci && npm run build:api`
- Start command: `npm run start:api`
- Health check: `/health`
- Required environment: every server-side value in `.env.example`, except `PUBLIC_API_URL`

Set `APP_ORIGIN` to the exact public Netlify origin and set `DGG_REDIRECT_URI` to the API's public callback. Register that callback in Destiny's developer page.

For Netlify, set `PUBLIC_API_URL` to the public API origin. The repo's `netlify.toml` builds the static Astro site from `dist`.

```sh
netlify init
netlify env:set PUBLIC_API_URL https://api.example.com
netlify deploy
netlify deploy --prod
```

These commands create and publish external resources. Run them only after the API hostname and production credentials are ready.

## Current limits

- The Team PEPE and Team YEE mapping comes from the current production flair catalog. Verify it with real OAuth responses before using it in public profiles. Team never grants permissions.
- The YouTube Data API check cannot promise playback. A rights holder can add a domain restriction or change availability after validation. The player reports runtime failures so a moderator can skip.
- There is one room by design. The backend serializes its transitions with a Postgres advisory lock. One backend instance is enough; Redis is not part of this version.
