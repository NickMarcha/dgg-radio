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
- The room's QueUp years imported and readable in their own history tab, with a
  search across both histories, numbered pages, and a self-service import for
  anyone bringing their own QueUp playlists across
- A history page whose tab, search and page number live in the address bar, so
  what somebody is reading can be sent to somebody else
- A genre on tracks either MusicBrainz or Discogs knows, each source in its own
  words and labelled with what it actually describes, clickable to narrow either
  history to it
- A genre breakdown on `/stats`, and top tracks and top jammers for the QueUp
  years beside the room's own, all of it narrowable to a year or a month
- A page for every track and every channel, with when it played, who asked for
  it, and what else is like it
- Blocklists an admin can add to by link or by search, before anyone plays the
  thing
- CSV exports of the history, the archive, the catalogue, the provider cache and
  the stats

- Any played track saved to a playlist or requested again, from either history
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

A blocklist rule can be added to from `/admin` without waiting for somebody to play the thing: paste a link, or search, and choose whether to block the one track or everything by whoever published it. On YouTube that is the channel; on SoundCloud it is the account that uploaded the track. Blocking an artist also drops anything already waiting in the queue that it now covers.

There is no channel search. The library the room searches YouTube with reads videos and playlists only, and YouTube's own channel search costs a hundred quota units a query for something any video by that channel already answers for nothing — so a channel is blocked from one of its videos.

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

### Genre

Tracks carry a genre where anyone knows one, shown on the player and in both
histories. It comes from two sources kept deliberately apart, because their
vocabularies are different by design: Discogs has about fifteen broad genres
plus a sharper style list, MusicBrainz a folksonomy of hundreds. Merging them
would invent both agreement and conflict, so each keeps its own words, its own
link, and its own row in `track_genres`.

Genre is keyed by the provider's id rather than by a `media` row, which is what
lets the QueUp archive be labelled too.

Two scripts fill it, and neither runs on its own:

```sh
npx tsx scripts/discogs-dump-import.ts discogs_20260901_masters.xml.gz
npx tsx scripts/enrich-genres.ts --limit 500
```

**Discogs** publishes a monthly masters dump under CC0, and embeds YouTube video
ids in its masters — 5.76 million of them. Joining on that id is exact and needs
no API request at all. It reaches about a third of the archive, which is far
more than any other route: going through MusicBrainz's Discogs relations reaches
1.4%, and the Discogs API cannot be queried by video id, so the dump is not a
cheaper way to get this data, it is the only way. Get the file from
[data.discogs.com](https://data.discogs.com/) and run the import again each
month.

**MusicBrainz** comes from its database dumps, matched offline:

```sh
npx tsx scripts/musicbrainz-dump-import.ts --core mbdump.tar.bz2 --derived mbdump-derived.tar.bz2
```

It takes the 2,257 tracks MusicBrainz happens to link to YouTube by URL, then
matches the rest on an artist and title parsed out of the upload title — which
is fuzzy, and only affordable because a local dump can be asked 34,000 times for
nothing. That reaches 24.2% of the archive on its own and, more to the point,
covers 4,030 tracks Discogs does not, taking the two together from 30.8% to
42.6%.

It wants 7.6 GB of dumps from [data.metabrainz.org](https://data.metabrainz.org/pub/musicbrainz/data/fullexport/),
about 17 GB of extracted tables, `bzip2` and `tar` on the path, and
`--max-old-space-size` at 12 GB or more.

**None of that ever touches a deployment.** The answers are committed to this
repository as `data/genres.json`, and the API applies them when it starts, right
after its migrations. A deploy therefore carries every genre the archive has
been labelled with, and the deployment host downloads nothing.

Refreshing it is a job for a workstation, and the only step that reaches a
database is the last one:

```sh
npx tsx scripts/musicbrainz-dump-import.ts --core ... --derived ...
npx tsx scripts/discogs-dump-import.ts discogs_20260901_masters.xml.gz
npx tsx scripts/genre-transfer.ts export --out data/genres.json
```

Then commit `data/genres.json`. The seed only fills gaps — a track the database
already has an answer for is left alone — so anything worked out against a
running room survives every later deploy, and re-running the importers there is
always safe.

A machine that has the dumps but not the room can still do the work —
`genre-transfer.ts tracks --out tracks.json` writes the 3 MB of track ids and
titles the matching needs, and both importers take `--tracks` and `--out` so
they run against files and no database at all.

**`scripts/enrich-genres.ts`** asks MusicBrainz's API a track at a time instead,
one request a second. It is now the follow-up rather than the main route: it
reads the video's own YouTube Music card, which identifies a track better than a
parsed upload title, so it can reach what the dump could not. It takes the most
played first and is safe to stop.

A genre that MusicBrainz only knows for the artist is stored and shown as an
artist genre, never as a description of the track: every Boards of Canada track
carries the same artist genres whichever one played.

Every genre on a history row narrows that history to it, and `/stats` counts
plays by genre with the two histories kept apart — the room has a few hundred
plays against the archive's tens of thousands, so adding them together would be
a chart of QueUp with a rounding error on the end. The stats leave artist-level
genres out, because they describe a catalogue rather than what played; the
filter includes them, because a reader clicking a tag marked `artist` is asking
for exactly what it says.

Every track title goes to the room's own page for it rather than out to the
provider; the two-letter badge beside it is the way out. Those pages are keyed
by the provider's id rather than by a row in `media`, so a track that only ever
played on QueUp has one too. An artist page needs a `media` row to exist at all,
because the archive recorded who requested a play and never who made the track.

`/track` and `/artist` are single prerendered shells serving every id beneath
them, the way `/profile` already was. `public/_redirects` does that on Netlify
and `src/middleware.ts` does it in local development; they have to stay in step.

For a track playing now that neither source covered, Discogs' search API is
asked once and the answer is cached in memory for an hour. Nothing from the API
is written to `track_genres`: its terms forbid storing their content or showing
it once it is six hours stale, and the stored table is built from the CC0 dump
instead. `DISCOGS_CONSUMER_KEY` and `DISCOGS_CONSUMER_SECRET` are optional and
only raise that search from 25 requests a minute to 60.

[The coverage research](docs/research/discogs-dump-genre-coverage.md) has the
measurements behind all of this.

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

Two scripts fill in what tracks are, both described under [Genre](#genre):

```text
npx tsx scripts/discogs-dump-import.ts <masters.xml.gz>   label from the monthly Discogs dump
npx tsx scripts/musicbrainz-dump-import.ts --core ...     label from the MusicBrainz dumps
npx tsx scripts/enrich-genres.ts --limit 500              label from the MusicBrainz API, most played first
npx tsx scripts/genre-transfer.ts tracks --out ...        carry genre between machines
```

`scripts/clear-beta-history.sql` deletes every queue item, every vote, and the
moderation log describing them, so testing done before the room opens is not the
first thing real listeners see. It keeps personal playlists, the track
catalogue, accounts and rules. It refuses to run
without `-v confirm=yes`, and it is only for the beta stage described in
`AGENTS.md`: once the badge leaves the room header the stored history belongs to
the community, and this stops being a thing to run.

```shell
docker compose exec -T db psql -U dgg_radio -d dgg_radio -v confirm=yes   -f - < scripts/clear-beta-history.sql
```

It leaves the QueUp archive alone: `legacy_plays` records another site's room,
not testing done in this one.

## Moving in from QueUp

The room ran on [QueUp](https://queup.net/join/dgg-radio) before this one
existed, so there are two things worth bringing across: what the room played,
and what people saved. QueUp's own data export is gone, but its web client's API
answers well enough for both, in two different ways — room data is public, and
personal playlists are not.

### The room's history

`scripts/queup-export-room.ts` reads everything the room's own pages read. It
needs no login and works against any public room:

```shell
npx tsx scripts/queup-export-room.ts dgg-radio          # writes queup-dgg-radio.json
npx tsx scripts/queup-export-room.ts dgg-radio --pages 5 --out sample.json
```

The file holds every play (who requested it, when it played, its votes, whether
it was skipped), everyone the room has a record of, and the moderation log with
the ban and staff lists folded into it. For dggJams that is 47,982 plays across
34,114 distinct tracks by 1,050 people, back to the room's first day in October
2024, in about 26 MB.

`scripts/queup-import-room.ts` loads the plays into `legacy_plays`:

```shell
npx tsx scripts/queup-import-room.ts queup-dgg-radio.json
```

It writes that one table and nothing else. No accounts are created, no `media`
rows are added, and no provider is asked anything, so a full import takes
seconds. Rows are keyed by QueUp's own id for the play, so running it again
brings across whatever is new and rewrites nothing — which is how a room still
running on QueUp gets topped up later.

The archive is the second tab on `/history`, beside the room's own. It is
another service's records: the requesters are QueUp names with no Destiny
account behind them, and the votes were cast somewhere else, so stats, profiles,
the DJ rotation and the repeat cooldown all ignore it on purpose.

What it is not is a dead end. An archived track can be saved to a playlist or
requested like any other, and because the archive holds a provider id rather
than a row in `media`, the first person to reach for one is what pays for the
provider lookup the import deliberately skipped. A request out of the archive is
an ordinary request: the rules, the length limit, the repeat cooldown and the DJ
rotation all apply to it.

Bans, roles and the moderation log are exported but not imported. This room has
no concept of a banned user, and a QueUp name is not a Destiny identity, so
importing them would mean inventing both a feature and a mapping. QueUp has no
song blocklist at all — the room's disallowed-song list only ever existed as
prose in the room description — so nothing there maps onto rules either.

### Personal playlists

Playlists are private. QueUp answers for them only with the owner's login cookie
and only when the request comes from queup.net itself, so there is no way to
fetch somebody's playlists on their behalf: they have to run the export in their
own browser. `public/queup-export-playlists.js` is that export, served at
`/queup-export-playlists.js` and linked from the playlists page.

Anyone moving their library:

1. Signs in at queup.net.
2. Opens the browser console and pastes the snippet in. Chrome asks them to type
   "allow pasting" first.
3. Gets `queup-playlists.json`, and chooses it under **Import from QueUp** on
   `/playlists`.

The import creates each playlist and saves its tracks, reporting anything it
could not take. A playlist whose name they already have is added to rather than
duplicated, so importing again after adding tracks on QueUp brings across only
what is new.

QueUp stored SoundCloud tracks by numeric id, which names nothing on its own, so
those are resolved through SoundCloud during the import. YouTube tracks cost
quota, and `videos.list` bills one unit per call for up to fifty ids, so an
import asks about fifty at a time: a 500-track library costs ten units rather
than five hundred.

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
| `/admin` | room settings, rules with their order and blocklists, roles, clearing queues, CSV exports |
| `/stats` | room totals, teams, most played tracks, and top jammers |
| `/history` | completed and skipped tracks, then the archive imported from QueUp |
| `/playlists` | your own playlists: create, reorder, and queue saved tracks |
| `/profile/:username` | one listener's stats and play history |
| `/track/:provider/:id` | one track: when it played in either history, its genre, and what else is like it |
| `/artist/:provider/:id` | one channel or account: its tracks, and how often each has played |
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
