# Bigscreen watchers plan

Status: all eight slices are built and committed.

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
| `enabled` | whether one channel's chat roster is read, which is what the overlay draws |
| `platform` | `kick`, `youtube`, `twitch`, `angelthump` |
| `channel` | the id as it appears in `watching`, stored lowercase |
| `updated_at`, `updated_by_user_id` | the audit pair the room settings carry |

### `stream_watch_samples`

One row a quarter of an hour per embed, keyed on that interval and the target. Every embed the site listed gets a row, not only the one the room
follows: the list arrives twice a minute anyway, and throwing away everything
but one line of it was the only reason the rest was not recorded.

| column | meaning |
| --- | --- |
| `sampled_at` | truncated to the quarter hour it was taken in |
| `channel_id` | into `stream_watch_channels`, which names it once |
| `site_count` | the mean of that interval's readings of `dggApi:embeds` |

`platform` is text here rather than the enum the settings use. The room can
only be pointed at platforms it knows about; the site lists whatever it lists,
and a platform nobody here has heard of is worth recording rather than dropping.

Both counts are kept because they measure different things, and a missing site
count says something: a channel nobody is watching does not appear in
`dggApi:embeds` at all. That list is also the only signal that a non-Destiny
channel is live — `dggApi:streamInfo` answers for Destiny's own streams and
nothing else — so a row means "the site reported somebody on it", and the graph
says that rather than claiming to know Kick's state. If that turns out to
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
GET   /api/watchers/channels admin, every channel a window saw, for the picker
GET   /api/watchers/history  admin, samples over a window, for the chart
GET   /api/stream-watch      admin, current settings and socket state
PATCH /api/stream-watch      admin, enable or disable, set platform and channel
```

Both history routes take the window as `from` and `to` rather than a length,
because the chart and the strip under it are the same query over two different
windows. `history` also takes `channels`, up to eight `platform/channel` keys;
without it the server ranks and picks the busiest, and either way it says in
`channels` which ones it drew.

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
| `layout` | `float`, `safe`, `rail`, `column`, `sides`, `climb`, `bump` | `float` |
| `names` | `under`, `beside`, `off` | `under` |
| `enter` | `fade`, `spin`, `slide`, `random` | `fade` |
| `motion` | `drift`, `bob`, `orbit`, `sway` | `drift` |
| `speed` | percent of the standard pace, 10 to 400 | `100` |
| `roam` | percent of the standard distance, 0 to 300 | `100` |
| `inset` | percent of the frame kept clear at every edge, 0 to 25 | `4` |

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

A layout decides where somebody sits; `motion`, `speed` and `roam` decide how
they move once they are there, and `inset` how much of the frame is left alone.

`float` scatters them and lets each wander from their own spot. `safe` seats
them around the edges and keeps the middle clear. `rail` is a line along the
bottom, `column` a line down the right, `sides` two lines down both — and
`climb` is `sides` with the motion switched on, which is the only difference
between them. Every one of these is CSS animation over an absolutely positioned
list, so none of them needs a frame loop.

The four motions are one set of keyframes shared by every layout, scaled by
`roam` and by how much room the layout has to spare — a rail has less than a
free float, so it wanders less for the same setting. They animate margins
rather than `translate` or `transform`, because a layout may be using both to
seat somebody, and the emote underneath may be animating a transform of its own.

`bump` is the exception to all of it, and the one layout with a loop behind it.

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
- **A base rule has to weigh nothing.** The copy of chat-gui's `.emote` rule
  was written `.watcher .emote`, which ties with every `.emote.<prefix>` rule
  the CDN declares — and our stylesheet is the one the browser reads second, so
  it won all 24 ties over `background-position`. CuckCrab is 92 frames of a
  2944px strip, declared to start at `704px` and step to `-2240px`; forced to
  start at zero it played 22 frames of somebody else's cat and then 22 of
  nothing. Wrapping the scope in `:where()` puts the base rule back below every
  per-emote rule, where chat-gui's own sits. The deliberate overrides still name
  their class twice and still win.
- **The base `.emote` rule is not decoration.** Copied from chat-gui's own
  stylesheet, it carries `position: relative` and `overflow: hidden`, and some
  emotes decorate themselves with absolutely positioned pseudo-elements that
  need both — GSN's dolphins are drawn on `::before` and `::after` and swim
  *through* the frame, which only works when the frame clips them.
- **Looping every emote was wrong.** A dance stops after a dozen or so
  iterations upstream because a chat message settles down once it has been
  read, and an overlay has nothing to settle into — so the overlay looped them.
  Applied to every emote, that also caught the 42 destiny.gg declares to run
  exactly once: OBJECTION slams in and GIGACHAD arrives, and both did it
  forever. Only what the CDN already repeats is looped now, read out of its own
  stylesheet by `scripts/dgg-emote-loops.ts`. GSN's dolphins swim past once
  again, which is what they do in chat.
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
source picks up within about a second. Under it is the same settings written
out as a query string — the frozen twin of that link, for a source that should
keep working exactly as it is however the saved row changes later.

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

`stream_watch_samples` stores the site's count once a quarter hour with the platform
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

### Slice 6: motion worth choosing, and bumper cars — done

Every layout moved at one pace, along one path, inside one margin, all three
of them decided here rather than by whoever was running the overlay. Four
options now say otherwise: `motion` picks the path, `speed` the pace, `roam`
the distance, and `inset` how much of the frame is kept clear at every edge.

They are worth having as numbers rather than as a few named presets because the
frame they are being fitted to is not ours: a 1920 × 1080 source with a webcam
in one corner wants a different inset from a full-bleed one, and neither is a
preset anybody could have guessed. `roam=0` also falls out of it for free,
which is the only way to ask for an overlay that holds perfectly still.

The motions are one set of keyframes shared by every layout, so a layout added
later gets all four without writing any. They animate margins because
`translate` and `transform` are both spoken for — `translate` seats the slotted
layouts, `transform` shifts the safe frame's edges, and the emote inside may be
animating a transform of its own.

`bump` is the bumper cars: everybody drifts at a steady pace, bounces off the
frame, and bounces off each other. It is the one layout that cannot be a
keyframe, because where somebody goes next depends on where everybody else is,
so it is the one with a `requestAnimationFrame` loop behind it. The step is a
pure function in `bumperMotion.ts` and tested without a browser; the loop writes
positions straight onto the elements, because putting them through React would
re-render the overlay sixty times a second to move six things.

Bodies are boxes rather than circles, because that is the shape of an emote with
a name under it, and two circles drawn around those would stop short of touching
by a visible margin. Where they meet, they trade the velocity along whichever
axis they overlap least and are pushed apart by that overlap, so the next frame
does not read as a second collision.

Two things the build settled.

A missing option is not zero. `roam` and `inset` are the first options whose
range includes it, and `Number(null)` is 0, so every source that had never
named them would have been read as holding still against the frame edge. The
test that caught it is the one that asserts a default for every option.

A hidden browser tab runs no animation at all — no `requestAnimationFrame`, and
no CSS timeline either. That is why the bumper layout is covered by a test
driving its own frames rather than by a screenshot: a tab this session can open
is a tab the browser has already stopped animating. An OBS source is never
hidden in that sense.

### Slice 7: every embed, not only ours — done

The live socket sends the whole list twice a minute and always did; only one
line of it was ever written down. Now every embed in that list is stored each
minute. (The followed channel carried a chat count too until slice 10, which
took that back out.)

That makes the graph a picture of what destiny.gg was watching rather than of
one channel, which is worth having for the same reason the room keeps any
history: it answers questions nobody thought to ask at the time.

Two things had to change to survive the extra rows.

The history is grouped before it is sent. A week of minutes is 10,080 points per
channel and there are as many channels as the site is listing, so a period picks
a bucket — never finer than the sampling interval, then thirty and 120 — and each
bucket keeps the busiest reading in it, which is the thing worth seeing at that
width. Only the eight busiest channels are drawn.

The chart's rule for breaking a line was written for one-minute samples: points
more than ninety seconds apart were treated as a gap in the record. Half-hour
buckets are all further apart than that, so a week would have been drawn as a
field of isolated dots. The rule now follows the width of a point.

The bucket width is written into the statement rather than bound as a parameter.
A bound parameter makes the copy in `group by` a different expression from the
one in `select`, and Postgres answers by asking for the raw column to be grouped
instead — which reads as a bug in the query rather than in how it was built.

### Slice 11: what a reading is, and how long it stays one — done

Three changes to the same table, all about it being a record that runs forever
rather than a picture of today.

**A reading is now the mean of an interval, not an instant in it.** The list is
read every minute into a running total in memory and one row is written when the
interval rolls over. A channel missing from a reading counts as zero — the site
lists an embed only while somebody has it open, so absence is a measurement —
and the divisor is how many times the list was read, not how many times that
channel was in it. That is what keeps a channel watched by four hundred people
for one minute of the quarter hour from reading as four hundred, while also not
punishing a channel for the minutes nobody was looking. Nothing is written until
an interval ends, so a restart loses the part-interval it was accumulating: a
gap rather than a wrong number, and one write per interval instead of fifteen
updates to the same row.

**The channel is named once.** `stream_watch_channels` holds `(platform,
channel)` and the samples hold an integer into it. Measured on synthetic rows —
a year of seventeen channels at a quarter-hour — text on every row is 65 MB and
the reference is 44 MB. On the real table it took a row from 129.6 bytes to
84.4, visible only after a `vacuum full`: `drop column` does not return the
space, and the backfill rewrote every row besides. Migration `0026` creates and
backfills, `0027` drops the text columns and moves the primary key, split that
way because one migration doing both makes drizzle-kit ask whether it is a
rename.

**Detail expires.** `downsampleStreamWatchSamples` averages readings older than
`DETAIL_DAYS` down to one an hour, in place, at startup and once a day. It is
two statements rather than a data-modifying CTE, which would not see its own
delete and would aggregate an on-the-hour row while removing it; averaging first
and then deleting only what is not on the hour is also idempotent, which matters
for something that runs at every startup. Steady state is about 11 MB for the
rolling ninety days plus 11 MB a year of hourly history.

Ninety days is chosen against the UI: the longest period the chart offers is
thirty days, drawn at two-hour buckets, so quarter-hour detail beyond about
thirty-five days cannot be displayed at all.

### Slice 10: the roster stops being history — done

The stored chat count went out, and with it every trace of a followed channel in
this half of the feature. `stream_watch_samples` holds one number per embed now:
destiny.gg's own count of who has it open. Migration `0025` drops `chat_count`,
and `site_count` becomes `not null` in the same breath — it was nullable only to
carry the followed channel through a minute the site did not list it, which was
a row that existed to hold a roster count and measured nothing else. Those rows
are deleted first, which the beta badge allows.

The reason is that the two numbers were never the same measurement. The site's
count is a fact about the site, sampled every minute for every channel. The
roster is who is in Destiny chat with an embed selected — a live thing the
overlay draws from a socket, for one channel, and only while somebody is
following it. Keeping a broken record of the second inside a complete record of
the first made the followed channel a special row, gave it priority in the
ranking, gave it a second dashed line, and put a badge in the picker — four
distinctions across the chart and its controls, all of them carrying one thing
nobody wanted to look at over time.

What went with it: the dashed line and its styles, the `followed` flag on a
listed channel and the badge that drew it, the followed-first ranking, the
`WatchersSnapshot` argument to `recordStreamWatchSample`, the metric parameter
threaded through the chart's series code, and the "record the followed channel
in a minute the site did not list it" branch. The overlay is untouched: it reads
the roster live, the way it always did.

### Slice 9: the history is its own tab, and its own question — done

Three things moved at once because they are one change.

**The recording stopped depending on the overlay.** `enabled` used to gate both
sockets, so the room's record of destiny.gg existed only while somebody was
being followed — and a minute nobody was connected is a minute that cannot be
recovered afterwards. The live socket is now held for the life of the process
and the sampler runs beside it; `enabled` names the one channel whose chat
roster is also read, which is the only part that needs a chat connection and
the only part the overlay can draw. The cost is that a fresh deployment now
connects to destiny.gg's live socket without being asked, which is a real change
from "nothing connects until an admin switches it on" and was made deliberately:
the alternative is a second switch for a thing nobody would ever want off.

**The chart is its own tab.** It had been a block at the bottom of the OBS card,
which is where it belonged while it was a picture of the room's own stream. It
is not that any more, so `/admin#embeds` holds the chart, the channel picker and
the live socket's state, and `/admin#obs` keeps what configures the overlay: the
followed channel, the roster counts, the chat socket and the sources.

**The controls became a way of looking rather than a period selector.** A period
dropdown is fine for "what happened lately" and useless for "what happened at
half past two". So the period is now drawn twice: the whole of it as a strip at
the bottom, and whatever window is brushed on that strip as the chart above.
Brushing refetches only the brushed window, which the server then buckets at
whatever detail that window has stored — an hour picked out of a month arrives
at full detail rather than per two hours. With nothing brushed there is one request
and the chart is the strip drawn large.

Beside it is a picker listing every channel the window saw, ranked by peak, with
search. Choosing sends those keys to the server, which draws them and sums
everything else into the same one line as before — so a narrow choice still says
how much of the site it is a part of. The list is deliberately uncapped: a chart
can only tell eight channels apart, but the reason to choose at all is to reach
a quiet channel, and a list cut to the busiest could never offer one. The eight
the server picked when nobody chose come back in `channels`, and the strip and
the chart are always asked for the same ones, so brushing never silently swaps
which lines are drawn.

One thing the picker broke and had to fix. A channel's colour comes from its
own name, but eight hues and any number of channels means collisions, and
resolving one by taking the next free hue made the answer depend on who else was
drawn — so switching a channel off repainted its neighbours. That was invisible
while the drawn set only changed with the period; with a picker beside the chart
it is the main thing anybody does. The hues are held above the charts now: a
channel keeps its colour for as long as it is drawn, and one is handed on only
once nothing is using it. Found by toggling the real page and reading the
computed colours back, not by reasoning about the function.

**The chart is d3 now**, and TypeScript throughout. d3 does the arithmetic —
`scaleTime`, `scaleLinear().nice()`, `line().defined()` for the breaks, tick
choice and time formatting, `bisectCenter` for the crosshair — and React does
the DOM, so the chart still renders identically on the server and is asserted
against as markup. The one exception is `brushX`, which owns the handful of
nodes it drags; it lives in an effect against a ref and React owns nothing under
it. `line().defined()` replaced the hand-rolled segment splitting outright: a
break is now a null point in one array rather than a second array, and one path
carries a channel however often it stops.

### Slice 8: one chart, every channel — done

A chart per channel was fine while there was one channel. Over a week the site
lists hundreds, and as separate charts that is a page nobody scrolls — worse, it
answers the wrong question. Who was watched, and when, against everybody else,
only has an answer when the lines share an axis. So it is one chart now, with
every drawn channel on it.

The eight hues are a categorical palette stepped for this dark surface and
checked against `#1f2023` by the validator in the `dataviz` skill — lightness
band, chroma floor, contrast, and colour-vision separation, all passing. Eight is
what can be told apart, which is what fixes the number of channels drawn: the
server sums everything past it into one grey line and says how many channels
that is, rather than reaching for a ninth colour.

A channel's colour comes from its own name, not from where it ranked. Ranking
would repaint every surviving line whenever the period changed or a channel went
quiet, and a colour that moves is worse than no colour. Two names wanting the
same hue is settled by taking the next free one, the same probe the overlay uses
to seat watchers.

Under the chart is a table of every line, its peak and its latest reading. That
is the accessible half of a chart whose identity is carried by colour, and it is
also the thing to read when two lines sit on top of each other.

The period selector goes to 30 days, in two-hour buckets. Hovering anywhere on
the plot puts a crosshair on the nearest bucket and lists what every line read
there, busiest first.
