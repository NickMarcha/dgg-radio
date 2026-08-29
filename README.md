# DGG Radio

DGG Radio is one shared music room for the Destiny.gg community. Listeners sign in through Destiny, queue YouTube or SoundCloud tracks, and take turns: everyone in the DJ rotation plays one track before anyone plays a second. Mods handle tracks in the room, while admins manage the room from `/admin`.

The Astro frontend deploys to Netlify. A small Hono server owns OAuth, WebSockets, queue state, playback timing, and Postgres writes. Netlify cannot run the persistent WebSocket server, so that process needs an always-on Node host.

## What works

- Destiny's custom OAuth flow with one-use, five-minute login state, returning to a frontend callback
- Database-backed mods and admins, with root admins named in the environment who cannot be demoted
- A DJ rotation over unlimited per-person queues, reorderable by mods and admins; listeners reorder their own queue and can take a track back out before it plays
- Synchronized YouTube and SoundCloud playback from the server clock
- Region, embeddability, age restriction, live status, processing state, and duration checks, cached per track
- A playback region chosen from YouTube's own list of the countries it recognises
- Admin-managed rules, arranged in the order listeners read them, that accumulate the tracks and artists that broke them
- YouTube and SoundCloud search, and playlist import for both providers
- Private per-listener playlists, filled from the player, from history, or by searching or pasting a track or provider-playlist link on the playlists page, and queued one track or a whole playlist at a time
- A configurable wait before the same track can be requested again, from five minutes to 30 days
- Per-play upvotes and downvotes, no voting on your own request, and a configurable downvote skip
- Team YEE and Team PEPE read from Destiny chat, with each listener's most used dancing emote as their avatar
- Usernames coloured by Destiny flair, the same way they appear in chat
- Optionally hiding requesters until a track ends, so votes are cast on the track
- Volume and play state remembered per browser
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

4. Start the frontend and API together.

   ```sh
   npm run dev
   ```

The API applies pending migrations as it starts, so there is no separate migrate step. `npm run db:migrate` is still there for applying a migration to a running database without restarting.

The room opens at `http://localhost:4321`. The API and WebSocket server use `http://localhost:8787`.

### Test environment

`npm run dev` runs the API from source. To exercise the deployed shape instead — the same image, the same startup migrations, the same container — bring up the production stack locally, without the tunnel.

```sh
npm run stack:test        # Postgres, the API on 8787, the sign-in stand-in on 8789
npm run dev:web           # the frontend on its own, pointed at that API
npm run stack:test:down   # stops it, keeping the database volume
```

Run `dev:web` rather than `dev`: the API is already in a container and the two would fight over port 8787.

`compose.test.yaml` layers over `compose.yaml`. It publishes the API port production keeps closed, replaces the deployed origins with local ones, and parks the tunnel in a profile so `up` leaves it down. Everything else is what production runs, migrations on startup included. `.env.development` is the other half: `astro dev` reads it after `.env`, so the browser calls the local API instead of the deployed one, while `astro build` runs in production mode and never sees it.

Set `TEST_HOST` to reach the stack by network address instead of `localhost`. Both halves read the same variable, and the API has to be recreated for a change to take.

```powershell
$env:TEST_HOST = '192.168.1.9'; npm run stack:test
```

One thing to know before doing that: Docker publishes its ports through WSL's mirrored networking, which the Hyper-V firewall does not open to other machines, so an OBS box or a phone reaches the frontend but not the API until that port is allowed.

### Signing in locally

destiny.gg allows one application per account and has no test applications, so there is no second client to point a local room at, and the one that exists has the deployed site as its registered redirect. `npm run stack:test` starts a stand-in for Destiny's OAuth endpoints instead, `dev/dgg-oauth`, and the room signs in against that.

It is a replacement, not a bypass. The room's own OAuth code runs unchanged, and the stand-in verifies the secret-bound code challenge the way the archived PHP does, so a login that works here has been through every step but Destiny's own account check. **Sign in with Destiny** lands on a form asking for a username, an optional Destiny user id, the features that decide flair colour and team, and the roles to store on the account.

A username in `ADMIN_DGG_USERNAMES` signs in as an admin, the same as on the real site. The user id is what identifies the account: leaving it blank derives a stable one from the username and creates a fresh listener, and pasting an existing `dgg_user_id` signs in as a row that is already there.

```sh
docker compose -f compose.yaml -f compose.test.yaml exec db psql -U dgg_radio -d dgg_radio -c 'select username, dgg_user_id from users'
```

Three separate things keep it out of production. `dev/` is excluded from the API image by `.dockerignore`, the service is declared only in `compose.test.yaml`, and `DGG_ORIGIN` and `DGG_AUTHORIZE_ORIGIN` default to `https://www.destiny.gg` and are refused any other value once `APP_ORIGIN` is https — the API will not start, rather than quietly trusting a stand-in.

## Provider setup

### Destiny

Create an application at `https://www.destiny.gg/profile/developer`. Register the exact callback in `DGG_REDIRECT_URI`. An account gets one application and one redirect, which is the deployed site's, so local development signs in against the [stand-in](#signing-in-locally) rather than a second registration.

The callback is a frontend route, not an API route. Destiny redirects the browser to `/auth/callback` on the Netlify site, which strips the code from the address bar and posts it to `POST /api/auth/callback`. The API keeps the client secret, owns the login transaction, and sets the session cookie. Registering a frontend URL means the API can move hosts without re-registering anything with Destiny.

Destiny's flow is not standard PKCE. The backend implements the secret-bound challenge described in the project's [OAuth research](docs/research/dgg-oauth-netlify.md). Keep the client secret on the API host.

Admins assign listener, mod, and admin roles on `/admin`. The only role sign-in grants is admin, to a username in `ADMIN_DGG_USERNAMES`. These are root admins and the API refuses to demote them.

Destiny's own `ADMIN` and `MODERATOR` roles are deliberately not read. The mapping existed but no login has ever arrived carrying either, so it was never confirmed against a real response and is switched off until it can be; see the [backlog](docs/backlog.md). The identity's `roles` array is still stored, so the first sign-in by a real Destiny moderator will show what it actually contains.

Signing in never overwrites a role granted on the admin page.

### YouTube

Enable YouTube Data API v3 in a Google Cloud project and set `YOUTUBE_API_KEY`. Restrict the key to that API. The backend rejects a video when the room's playback region is blocked, an explicit country allow-list omits it, embedding is disabled, the video is age-restricted or live, processing is incomplete, or its duration exceeds the room setting.

That playback region is picked on `/admin` from YouTube's own `i18nRegions` list, which is the set of countries its availability checks recognise, rather than typed as a bare ISO code. The list is cached in `playback_regions` and refreshed after 30 days.

### SoundCloud

SoundCloud closed its documented API behind a paid subscription. Track metadata comes from [`soundcloud.ts`](https://github.com/Moestash/soundcloud.ts), which talks to the same `api-v2` endpoints the SoundCloud website uses. There is nothing to configure: the library finds the public web client id itself, so the radio stores no SoundCloud credentials.

That client id rotates. The library only looks one up when it has none, so the backend catches a `401`, forces a fresh id, and retries once.

The backend accepts resolved objects whose kind is `track` and which SoundCloud reports as streamable and not `BLOCK` policy.

A track is looked up twice: once when it is submitted and once again just before it plays. Both go through the `media_lookups` cache, so the second one is usually free.

### Lookup cache

Provider answers are stored in `media_lookups`, keyed by YouTube video ID or SoundCloud permalink path, so the same track submitted through different URL forms is one entry.

This is the per-track cache. YouTube's region list is cached separately in `playback_regions`, on its own much longer schedule, because it is a property of the API rather than of any track.

SoundCloud entries never expire, because nothing they report changes on its own and the api-v2 endpoint is unofficial enough to be worth asking sparingly. YouTube entries expire after 24 hours, because a video can become region blocked, age restricted, or non-embeddable after it was accepted. An expired entry is rechecked and overwritten in place; a recheck that fails throws and leaves the previous row untouched, so the next attempt checks again rather than serving a known-stale answer.

One consequence worth knowing: the check just before playback only reaches YouTube for tracks that have been queued more than a day. Anything queued and played inside 24 hours serves the cached answer. Runtime player failures remain the backstop for a video that breaks in between.

## Commands

```text
npm run dev              start Astro and the room server
npm run check            run Astro and TypeScript diagnostics
npm test                 run unit and database tests
npm run build            build the Netlify site and Node server
npm run db:generate      create a migration after a schema change
npm run db:migrate       apply pending migrations
npm run db:up            start local Postgres
npm run db:down          stop local Postgres without deleting its volume
npm run stack:up         build and start Postgres, the API, and the tunnel
npm run stack:down       stop the stack without deleting the database volume
npm run stack:test       run that stack locally without the tunnel, API port published
npm run stack:test:down  stop the local stack, keeping the database volume
```

## Testing

`npm test` runs the unit tests on their own. The integration tests need a real Postgres, so they skip unless `TEST_DATABASE_URL` points at one.

They truncate every table between cases, so the database name must end in `_test` or they refuse to run. That guard exists because pointing them at the development database once was enough to wipe its users and history.

Create it once:

```sh
npm run db:up
docker compose exec db createdb -U dgg_radio dgg_radio_test
```

Then run against it:

```sh
TEST_DATABASE_URL=postgresql://dgg_radio:local_only@127.0.0.1:54329/dgg_radio_test npm test
```

On PowerShell, set the variable first:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://dgg_radio:local_only@127.0.0.1:54329/dgg_radio_test'; npm test
```

## Pages

| Path | |
| --- | --- |
| `/` and `/player` | the room: player, room queue, your own queue, request form |
| `/admin` | room settings, rules with their order and blocklists, roles, clearing queues |
| `/stats` | room totals, teams, most played tracks, and top jammers |
| `/history` | completed and skipped tracks |
| `/playlists` | your own playlists: create, reorder, and queue saved tracks |
| `/profile/:username` | one listener's stats and play history |
| `/embed/player` | control-free synchronized video and audio for an OBS Browser Source |
| `/embed/playing` | transparent current-track details for OBS |
| `/embed/queue` | transparent upcoming room queue for OBS |
| `/auth/callback` | where Destiny returns after sign-in |

### OBS browser sources

Use `/embed/player` at a 16:9 size such as 1920 by 1080 or 1280 by 720. Turn on `Control audio via OBS` and `Shutdown source when not visible`. Leave `Refresh browser source when scene becomes active` off. YouTube fills the source with its control-free video player. SoundCloud has no video, so its official visual audio player fills the source instead.

`/embed/playing` is a separate transparent overlay sized for a wide 1200 by 240 source. It shows artwork, a scrolling title when needed, artist, requester, vote counts, and synchronized time. `/embed/queue` fills the Browser Source width and scrolls only the titles that do not fit. A height of 600 works for the full upcoming queue. Neither overlay loads a provider player or produces audio. The [OBS embed research](docs/research/obs-embed-playback.md) records the browser and provider constraints behind this setup.

## Deployment

Netlify serves the static frontend. The API, its Postgres, and a Cloudflare tunnel run as one Docker stack on a self-hosted machine. Netlify cannot hold the WebSocket connections or run the playback clock, so the API is not deployed there.

Both halves deploy themselves from `main`. Netlify builds the frontend on push, and a webhook rebuilds and redeploys the API stack. Neither needs a manual step, which is why the API applies its own migrations on startup. [Production deployment](docs/deployment.md) describes the running setup and the settings it depends on.

### API stack

Fill in `.env`, then bring up all three containers.

```sh
npm run stack:up     # db, api, and the cloudflared tunnel
npm run stack:down
```

`compose.yaml` overrides `DATABASE_URL` to reach Postgres over the compose network, so the value in `.env` stays pointed at the port published on the host for the tests.

`POSTGRES_PASSWORD` has no default and is read by both the database and the API's `DATABASE_URL`. Postgres only applies it when the data directory is first created, so pointing a new password at an existing volume fails to authenticate — match the value the volume was created with, or start from an empty volume.

Migrations are **not** a separate deployment step. The API applies pending migrations on startup, and refuses to serve if they fail — deploys are automated from `main`, so no operator is around to run them by hand. `npm run db:migrate` still exists for applying a migration to a local database without restarting the stack.

### Public origin

The API reaches the internet only through the tunnel and publishes no host port. Set `CLOUDFLARE_TUNNEL_TOKEN` to a named tunnel's token; its public hostname route belongs in the Cloudflare dashboard, pointing at `http://api:8787` over the compose network. Confirm the tunnel with `docker compose logs tunnel`, which reports one `Registered tunnel connection` line per edge connection.

The tunnel is outbound-only, so it needs no inbound firewall rule and works from behind CGNAT. Fronting the API with Cloudflare also keeps its DDoS protection and WAF ahead of a process that would otherwise be directly exposed.

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

- Team comes from counting yee and pepe messages through `polecat.me`, a third-party API with no uptime guarantee and a sixty-a-minute limit. A check is eleven requests, so they are queued one at a time and run behind sign-in rather than blocking it. A failed check changes nothing. Team never grants permissions.
- The YouTube Data API check cannot promise playback. A rights holder can add a domain restriction or change availability after validation. The player reports runtime failures so a moderator can skip.
- There is one room by design. The backend serializes its transitions with a Postgres advisory lock. One backend instance is enough; Redis is not part of this version.
