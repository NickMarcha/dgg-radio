# Bigscreen watchers plan

Status: all five slices are built and committed.

## Outcome

The room's Kick stream is watched through `destiny.gg/bigscreen#kick/dggJams`.
Destiny chat knows who has that embed open. This feature reads that, and turns
it into an OBS overlay of the people currently watching, plus a number the
admin page can graph.

```text
wss://live.destiny.gg/          how many the site says, title, live or not
wss://chat.destiny.gg/ws        which chatters, their flairs, what they say
        |
        +-- one tracker in the API process
                |
                +-- /embed/watchers        the overlay, in OBS
                +-- /admin#obs             switch it on, pick the channel, graph it
                +-- stream_watch_samples   counts over time
```

`docs/research/dgg-embed-watchers-websockets.md` is the measured behaviour of
both sockets. Three findings from it shape everything below:

1. **Both sockets answer 403 to a foreign `Origin`.** A browser always sends
   one and cannot be told not to, so the OBS page can never connect for itself.
   The tracker is server-side because there is no other option.
2. **Chat is the only source with names on it.** The site's `count` and a tally
   of the chat roster disagree by a percent or two and both are right; only the
   chat side can be drawn as people.
3. **Switching embeds is not broadcast.** A watching change is seen when that
   person next speaks. Reconnecting re-seeds the whole roster from `NAMES`.

## Product decisions

1. One channel is tracked at a time: a platform and a channel id set on the
   admin page. The room has one stream, so a list of channels would be
   configuration nobody asked for.
2. The channel is matched case-insensitively. Chat reports ids lowercase and
   the bigscreen fragment is written `#kick/dggJams`.
3. The tracker holds the chat socket only while it is worth holding: tracking
   enabled, and either an overlay is connected or the last embeds message
   reported somebody on the channel. It drops the socket two minutes after both
   stop being true. The measured cost of the stream is small — 1.6 events a
   second, mostly `MSG` — so this is about not sitting on somebody else's chat
   connection for no reason, not about CPU. Slice 1 implements the site half of
   that condition; the overlay half arrives with the overlay.
4. Who the overlay draws is chosen per browser source, in the URL, because that
   is how an OBS source is configured and how `/embed/player?captions=on`
   already works. The admin page builds that link from toggles rather than
   listing every combination: the options are set on the row, the URL below it
   updates as they change, and the copy button takes whatever it currently
   says. A list of prebuilt variants only works while there is one option;
   this overlay has five, and their combinations are not a list anybody wants
   to read. Slice 5 adds the other half of that: an admin who wants to change
   the look without touching OBS saves it against their own account instead,
   and the URL never changes. The query string stays for a source configured
   once and left alone.
5. Names are coloured the way chat colours them. `resolveFlair` already takes a
   `features` array and the chat payload carries exactly that array, so no
   sign-in and no lookup is involved.
6. Nobody is stored. The roster lives in memory; what reaches Postgres is two
   counts a minute, plus the platform and channel those counts came from.
   This feature is not a chat log, and a watcher who leaves leaves no record.
7. The nine dancing emotes keep their meaning as avatars. No emote from the
   wider catalogue ever becomes somebody's profile picture; the full set exists
   on the overlay and only there.
8. The overlay links `https://cdn.destiny.gg/emotes/emotes.css` rather than
   mirroring 325 files. `EmbedLayout` imports neither `emotes.css` nor
   `flairs.css` — only `BaseLayout` does — so the overlay page carries the CDN
   rules alone and cannot collide with the local avatar rules. It imports
   `flairs.css`, which declares no emote rules, for the name colours.

## What the tracker knows

One entry per watcher, in memory:

```ts
interface Watcher {
  nick: string;
  flair: string | null;      // resolveFlair(features)
  subTier: number | null;    // subscription.tier
  lastSpokeAt: number | null;
  lastEmote: string | null;  // slice 3
}
```

Fed by, in order of trust:

| event | what it does |
| --- | --- |
| `NAMES` | replaces the map wholesale |
| `JOIN` | adds one, already carrying `watching` 215 times out of 216 |
| `MSG` | updates one, and is the only way a switch is ever seen |
| `UPDATEUSER` | updates one, but never carried a change in ten minutes |
| `QUIT`, `USERSDELTA.removed` | removes one |

The reducer is a pure function over parsed events. That is what gets tested,
against frames recorded off the real socket, so no test needs the network.

## Data model

Two tables, both disposable while the beta badge is up.

### `stream_watch`

Singleton on `id = 1`, the shape `room_settings` already uses.

| column | meaning |
| --- | --- |
| `enabled` | whether the tracker connects at all |
| `platform` | `kick`, `youtube`, `twitch`, `angelthump` |
| `channel` | the id as it appears in `watching`, stored lowercase |
| `updated_at`, `updated_by_user_id` | the audit pair the room settings carry |

### `stream_watch_samples`

One row a minute while tracking is on, keyed on the minute and target.

| column | meaning |
| --- | --- |
| `sampled_at` | truncated to the minute |
| `platform`, `channel` | the selected target when the sample was taken |
| `site_count` | `count` from `dggApi:embeds`, null when the channel is absent |
| `chat_count` | watchers in the roster |
| `live` | whether the embeds list carried the channel at all |

Both counts are kept because they measure different things. The site count can
be missing because a channel nobody is watching does not appear in
`dggApi:embeds` at all. That list is also the only signal that a non-Destiny
channel is live. `dggApi:streamInfo` answers for Destiny's own streams and
nothing else. So
`live` here means "the site reported at least one person on it", and the graph
should say that rather than claim to know Kick's state. If that turns out to
matter, `kick.com/api/v2/channels/<slug>` answers without a key, and that is a
later slice rather than a dependency now.

## Server modules

- `src/server/dgg-socket.ts` — one reconnecting client for both sockets. No
  `Origin` header, an honest `User-Agent`, the application-level `PING`
  answered with `PONG`, and chat-gui's own backoff, which encodes problems
  already met in production: a handshake that completes before authentication,
  so a connection only counts as healthy after five seconds; close code 1001
  retried fast but jittered; full jitter over a window doubling to a sixty
  second cap.
- `src/server/dgg-embeds.ts` — the live socket. Parses `dggApi:embeds`, ignores
  every other type, reports the entry for the tracked channel.
- `src/server/dgg-chat.ts` — the chat socket and the roster reducer above.
- `src/server/watchers.ts` — what the rest of the app talks to: reads and
  writes `stream_watch`, decides when the sockets should be up, samples into
  `stream_watch_samples`, and answers with a snapshot.

Nothing else imports the two socket modules. `chat.ts` keeps its current
meaning — counting how somebody talks, through polecat — and is not touched.

## API and socket contract

```
GET   /api/watchers          public snapshot for the overlay and the admin page
GET   /api/watchers/history  admin, samples over a period, for the graph
GET   /api/stream-watch      admin, current settings and socket state
PATCH /api/stream-watch      admin, enable or disable, set platform and channel
```

The snapshot:

```jsonc
{
  "channel": { "platform": "kick", "id": "dggjams" },
  "live": true,
  "siteCount": 41,
  "chatCount": 44,
  "watchers": [{ "nick": "…", "flair": "flair8", "subTier": 2,
                 "emote": "catJAM", "lastSpokeAt": "…" }]
}
```

The overlay opens the existing `/ws` with a new connection kind,
`embed-watchers`, added to `embedConnectionKinds` in
`src/shared/roomConnection.ts`. The room socket announces a revision and makes
the browser fetch its own snapshot, to keep private state out of a shared
broadcast; this one pushes the snapshot itself, because every field in it is
already public in chat. Pushes are throttled to one a second, and the existing
`ConnectionRegistry` counts these connections like any other, which is how the
tracker knows whether anything is listening.

## The overlay

`src/pages/embed/watchers.astro` on `EmbedLayout`, rendering
`WatchersOverlay.tsx`. Transparent, silent, no page chrome, like the other
overlays. Options in the query string:

| option | values | default |
| --- | --- | --- |
| `show` | `speakers`, `all`, `members` | `speakers` |
| `window` | minutes, for `show=speakers` | `10` |
| `max` | how many to draw | `12` |
| `layout` | `float`, `row` | `float` |
| `names` | `under`, `beside`, `off` | `under` |
| `enter` | `fade`, `spin`, `slide`, `random` | `fade` |

`show=speakers` draws people who have spoken inside the window, which is also
the set whose watching state is known to be current. `show=all` draws the
roster, newest first, capped at `max` — honest about scale, but most of them
are silent and some will have switched away. `show=members` draws only watchers
who have an account in this room, who already have an avatar emote, a flair and
a profile page.

Which emote a watcher gets, in order: the last one they used in chat (slice
3), then their stored avatar emote if they are a room member, then `MMMM`. Emotes are
matched the way chat matches them — whitespace-delimited, case-sensitive,
against the manifest prefixes — and gated on `minimumSubTier` against the
`subscription.tier` in the same payload, so the overlay never renders an emote
its author could not have used.

`layout=float` gives each watcher a slow drift with its own phase; `layout=row`
spaces them along the bottom. Both are CSS animation over an absolutely
positioned list, so neither needs a frame loop.

Three things only using it revealed:

- **The overlay must paint nothing of its own.** `EmbedLayout` leaves the page
  colour to the component, and the transparency rule lives in `EmbedView.css`,
  which this page does not load. Without its own copy the overlay covers every
  layer beneath it in OBS.
- **Emotes are sized with `zoom`, not `scale`.** `scale` is a painted
  transform: the emote gets bigger while its layout box stays 28 pixels, so a
  row of them sits on top of itself. `zoom` scales the layout with it and
  scales every length in the subtree together, which keeps the sprite strips in
  step where a changed `background-size` would not.
- **Nobody appears or vanishes.** `show=speakers` is a moving window, so people
  stop being drawn mid-stream the moment their last message ages out of it.
  The rendered list keeps whoever has just left for as long as their entrance
  takes, played backwards, and somebody who returns mid-fade is simply drawn
  again. `random` picks an entrance per watcher rather than per appearance, so
  a person always arrives the same way.
- **The drawn set is sticky, and has to be.** The snapshot is ordered by who
  spoke last, so taking the top `max` of it puts a busy chat in a blender:
  measured on `kick/destiny`, three to ten of twenty-four slots swapped every
  second or two, the same names leaving and returning within seconds. Whoever
  is on screen now stays until they really go — out of the window, or out of
  chat — and newcomers only fill free slots.
- **A row only spreads if it fits, and two dozen do not.** Flex distributes
  space that is left over, so the whole question is arithmetic. Measured
  against the live drawn set and each emote's declared width: twenty-four
  watchers need 2668px of a 1888px line and overflow by 780px, leaving nothing
  to spread; twelve need 1264px and leave about 48px between each. Hence a
  default `max` of twelve. Two earlier attempts at this — `zoom` instead of
  `scale`, then `nowrap` instead of wrapping — were both real fixes for real
  faults and neither touched the cause, because neither was measured first.
- **The base `.emote` rule is not decoration.** Copied from chat-gui's own
  stylesheet, it carries `position: relative` and `overflow: hidden`, and some
  emotes decorate themselves with absolutely positioned pseudo-elements that
  need both — GSN's dolphins are drawn on `::before` and `::after` and swim
  *through* the frame, which only works when the frame clips them. Their
  animations need looping as well, for the same reason the dances do.
- **The Astro dev toolbar renders into a browser source.** `EmbedLayout` hides
  it, because a source is captured as it is drawn and in development that
  included a cropped toolbar in the corner.

## Admin

A `Stream watch` section at the top of the `OBS` tab: the enable switch,
platform and channel, whether each socket is up, the two live counts, and the
names the roster currently has. The graph is below the live state. It can show
six hours, one day, three days or one week, and draws a separate chart for every
target in that period.

`Your watcher source` is the admin's own saved source: the same options as
form controls, one URL that never changes, and a save that a running browser
source picks up within about a second.

The overlay also joins the browser sources further down the same tab, as one row
with its options as toggles above a URL that updates with them. The existing
`Player variants` list folds into the same control: `?captions=on` becomes a
toggle on the player's own row, and the separate entry goes. That is one fewer
thing to keep in step, and it is the only shape that survives an overlay with
five options.

## Tests

Unit, against frames recorded from the live socket and committed as fixtures:

- the roster reducer: `NAMES` seeds, `JOIN` and `MSG` update, `QUIT` and
  `USERSDELTA.removed` remove, an unknown event changes nothing
- case-insensitive channel matching, including a `kick-vod` id with slashes
- a watching change seen through `MSG`, and one only a reconnect can catch
- backoff: unstable connections escalate, a stable one resets, 1001 is fast
- `PING` answered with the same payload
- emote extraction: whitespace delimiting, case sensitivity, tier gating

Integration, against the local Postgres:

- settings round-trip, and admin-only access on both endpoints
- one sample a minute, with a null `site_count` when the channel is absent
- two targets selected inside one minute keep two rows
- the history endpoint over a period, including its admin-only boundary

## Trying it locally

`dggJams` is dark most of the time, so develop against a channel that is not.
`kick/destiny` carries several hundred watchers whenever Destiny is live and
exercises every path, including the disagreement between the two counts.
`kick/anythingelse` is the offline case: chatters watching a channel the embeds
list never mentions.

```
npm run db:up
npm run dev
# /admin#obs: enable, platform kick, channel destiny
# /embed/watchers?show=speakers&layout=float in a browser tab
```

The tracker runs inside `dev:api`, so `tsx watch` restarts it on every save and
each restart is a fresh `NAMES`. Worth watching for while developing: reconnect
storms from repeated saves, and whether the two-minute idle drop actually fires
when the overlay tab is closed.

`scripts/dgg-watch-probe.ts` prints the roster tally and the embeds counts for
one channel without starting the app. It is how the numbers in the research doc
were produced, and the fastest way to tell a tracker bug from a quiet chat.

## Risks

- **The Origin allowlist is theirs to change.** They 403 a foreign origin today
  and accept no origin at all. If that tightens, the feature stops working and
  there is no browser-side fallback.
- **Holding somebody else's socket.** Permission to use these sockets is
  confirmed. What is left is manners: one connection, an honest user agent,
  their own backoff, and dropped when nothing is listening.
- **A connection can die quietly.** Both servers send protocol-level ping
  frames, chat every 10 seconds and the live socket every 30, which `ws`
  answers by itself. The client treats those as its liveness signal and
  reconnects after thirty seconds of complete silence, rather than guessing at
  an idle timeout.
- **A stale roster is invisible.** Nothing marks a watcher whose state is old,
  so `show=all` will draw people who have left the embed. The window in
  `show=speakers` is the honest version of the same list.

## Delivery slices

Each slice leaves something that works.

### Slice 1: the tracker and the numbers — done

Both sockets, the reducer, `stream_watch`, the settings endpoints, and the
admin section showing the two counts live. No overlay.

Verified against `kick/destiny` while Destiny was streaming: the site said 865
and the chat roster 875, both sockets connected, names and flairs resolved, and
disabling it closed both. `scripts/dgg-watch-probe.ts` prints the same thing
without the room.

One thing that verification changed. The gate is applied whenever an embed list
arrives rather than only on the 15 second refresh, because the first list
decides whether the chat socket is wanted and arrives seconds after the live
socket opens: waiting for the next tick left the room blind for a quarter of a
minute every time an admin switched it on.

### Slice 2: the overlay — done

`/embed/watchers` on `EmbedLayout`, the `embed-watchers` connection kind, the
CDN stylesheet through a new `head` slot, all five options, both layouts, and
the room's own people resolved so a member is drawn as their own emote.

The link builder came with it, since this is what needed it: the options are
toggles on the source's row in the `OBS` tab and the URL under them follows,
with a default never written into it. The `Player variants` list is gone and
`?captions=on` is a toggle on the player's own row.

Three things the build settled that the plan had left open.

The chat socket is now held while an overlay is connected, which is the other
half of the gate: opening the browser source is what starts the tracker on a
channel nobody is watching yet. Verified on `dggjams` while it was dark — chat
socket down, overlay connected, socket up, and the two minute grace held it
after the overlay closed.

The snapshot caps at 100 watchers but never at a member's expense, because a
plain cut keeps the most recently active and `show=members` would then miss the
people it exists to draw.

Members are resolved by reading the whole `users` table once per refresh and
intersecting in memory, rather than querying per nick. The table is small and a
roster is not: 928 watchers against a few dozen accounts.

### Slice 3: the last emote used — done

`src/server/dgg-emotes.ts` reads the catalogue from
`cdn.destiny.gg/emotes/emotes.json` — beside the stylesheet the overlay draws
with, so the two stay in step — and matches a message the way chat does:
whitespace either side, case sensitive, Twitch-only emotes excluded, and gated
on the author's sub tier so the overlay never shows an emote its author could
not have used. The last emote in a message wins, being the one they finished
on, and a later message of plain words leaves it alone.

Failing to load the catalogue is not an error worth breaking anything over:
nothing matches, watchers keep whatever their account gives them, and the next
refresh tries again.

On live traffic this filled in at once — 64 of the 100 drawn watchers had an
emote within seconds, because the backlog chat sends on connect is read too.

The bug worth remembering: the trailing separator in that pattern is a
lookahead, so it is not consumed. An attempt to rewind `lastIndex` past it
turned the first match into an infinite loop, on a code path a live overlay
would have hit within a second.

### Slice 4: completed graph

`stream_watch_samples` stores the two counts once a minute with the platform
and channel that produced them. Its key is the minute plus that target, so a
quick switch does not overwrite either reading. A repeat for the same target
and minute updates the row with the latest figures.

`GET /api/watchers/history` is admin-only and returns at most one week. The OBS
tab offers six hours, one day, three days and one week. Each target gets its own
chart, source counts break where destiny.gg did not list the embed, and both
lines break across missing minutes rather than pretending the process was
sampling while it was down.

Verified against the local Postgres. The populated and empty chart states were
also opened in the local admin page. A 24-hour axis originally printed the same
clock time at both ends. The browser check caught it, and periods of a day or
longer now include the date.

### Slice 5: a source that keeps its settings — done

An OBS source configured through the query string can only be changed by
editing the source, which means reaching the OBS machine. `watcher_embed_settings`
(migration `0021`) stores one row per admin account, keyed by their user id,
and `/embed/watchers?profile=<uuid>` reads it.

The id in that URL is the admin's own random UUID, which is what makes the
public read safe to leave unauthenticated: it addresses a row of display
choices and nothing else, and only the signed-in owner can write it, through
`GET`/`PATCH /api/watcher-embed`. An unknown id is a 404 rather than a row
created on somebody else's behalf.

The overlay polls that row once a second and both ends send `no-store`, so a
save reaches a running browser source without a reload and without OBS being
touched. It is a poll rather than a push because the settings belong to one
source rather than to the room: the watchers socket sends one message to every
overlay, and a per-source payload does not belong on it.

The query-string form is unchanged and still the way to configure a source that
will then be left alone. `?profile=` wins where both are given, because a saved
source quietly obeying a stale query string is the harder of the two to explain.
