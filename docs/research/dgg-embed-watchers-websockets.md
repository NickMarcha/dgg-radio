# Who is watching a destiny.gg embed

Checked 2026-09-05 against live connections to both sockets, and against
`destinygg/chat-gui` at `cfa9036` (2026-08-30).

The question behind this: `https://www.destiny.gg/bigscreen#kick/dggJams` is
where the room's Kick stream gets watched, and both the number of people on it
and which chatters they are can be read without asking anyone for an API key.

## The two sockets

Both accept an anonymous connection. No cookie, no token, nothing to register.

**Both refuse a foreign `Origin` with HTTP 403.** Tested on 2026-09-05: an
`Origin` of `https://dggradio.netlify.app` is rejected by each socket at the
handshake, `https://www.destiny.gg` is accepted, and **no `Origin` header at
all** is accepted by both.

This is not CORS and cannot be worked around in a browser. A browser always
sends `Origin` on a WebSocket handshake and never lets a page change it, so a
page on any other origin — the OBS browser source included — gets a 403 and
never opens the socket. Only a non-browser client can connect, and the honest
way for it to do so is to send no `Origin` rather than to claim to be
destiny.gg.

### `wss://live.destiny.gg/`

Plain JSON frames, `{"type": ..., "data": ..., "cacheable": ...}`. On connect it
sends the current state of everything: `dggApi:streamInfo`, `dggApi:hosting`,
`dggApi:videos`, `dggApi:youtubeVods`, `dggApi:events`, `dggApi:bannedEmbeds`,
`livestream`. Then `dggApi:embeds` repeats every 17–32 seconds, each one a
complete list rather than a delta.

An entry is one embed being watched:

```json
{"platform":"kick","id":"drt0123","count":6,
 "mediaItem":{"identifier":{"platform":"kick","mediaId":"drt0123"},
 "metadata":{"previewUrl":"…","displayName":"drt0123","title":"…",
 "createdDate":"…","live":true,"viewers":10}}}
```

`count` is people on the destiny.gg embed. `viewers` is the platform's own
number for the whole stream.

No REST equivalent was found: `/api/embeds` and `/api/embeds/all` are 404s.
`/api/info/stream` exists but only answers for Destiny's own streams, not for
embeds. The socket is the only way in.

### `wss://chat.destiny.gg/ws`

The golang chat service's `EVENT {json}` line protocol, parsed in chat-gui's
`assets/chat/js/source.js`. An anonymous connect answers `ME null`, then
`HISTORY` (recent messages as raw event strings), then `NAMES`, and then the
live event stream.

`NAMES` is the whole roster. One capture: 1,258 users, 2,364 connections,
227 KB, of whom 1,241 carried a `watching`.

```json
{"id":149440,"nick":"TheResized","roles":[],"features":[],
 "createdDate":"2022-04-04T17:35:40Z",
 "watching":{"platform":"kick","id":"destiny"},"subscription":null}
```

Every event that carries a user carries the same shape, `watching` included:
`NAMES`, `JOIN`, `QUIT`, `MSG`, `UPDATEUSER`, and `USERSDELTA` (`users` and
`removed`). chat-gui keeps one map of users and refreshes it from whatever
arrives — `chat.js` `onDISPATCH` harvests the user out of any event, `onQUIT`
deletes — which is exactly the model a tracker here needs:

- `NAMES` seeds the map.
- `JOIN`, `MSG`, `UPDATEUSER` set or update one user.
- `QUIT` and `USERSDELTA.removed` delete.

`UPDATEUSER` is broadcast for other people, not only for yourself; chat-gui
ignores everyone else's, which is why its handler looks private.

**But switching embeds is not broadcast.** Over ten minutes: 529 `MSG`, 216
`JOIN`, 193 `QUIT`, 14 `UPDATEUSER`, and 16 changes of `watching`. Every one of
the 16 was noticed because the person spoke; not one of the 14 `UPDATEUSER`
events carried a changed `watching`. A silent lurker who switches embed stays on
the list until they quit chat.

Reconnecting re-seeds the map from `NAMES`, which is the only correction
available and costs 227 KB. 215 of 216 `JOIN` events already carried a
`watching`, so people arrive with an embed selected rather than picking one
afterwards.

The whole event stream is about 1.6 events a second at that time of day, and
`MSG` is most of it.

Platforms seen in `watching`: `kick`, `youtube`, `twitch`, `angelthump`, and
`kick-vod`, whose id carries slashes — `kick-vod/destiny/ca2db779-f470-…`. Ids
appear lowercase throughout, while the bigscreen fragment is written
`#kick/dggJams`, so any match on a configured channel has to be
case-insensitive.

## The site's count and the chat's count are different numbers

Counting `watching` across the chat roster and comparing with the same
minute's `dggApi:embeds`:

| | site `count` | chat roster |
| --- | --- | --- |
| kick/destiny | 715 | 730 |
| kick/destiny, 30s later | 720 | 732 |
| kick/destiny, 60s later | 723 | 729 |
| youtube/MeEuTKCtDF0 | 293 | 290 |
| kick/drt0123 | 6 | 7 |

Close, never equal, and neither is wrong: the site counts embeds open and the
chat counts people in chat who have that embed selected. For an overlay that
names people, only the chat number can be drawn — the site number counts
watchers there is no name for.

## The embeds list only carries live streams

`kick/anythingelse` had 49 chatters watching it and appeared in no
`dggApi:embeds` message at all. Kick's own API answers `"livestream": null` for
that channel: it is offline, and those 49 are sitting on an embed of nothing.

So for a channel this room cares about:

- While it is **live**, `dggApi:embeds` carries it with a count, and chat names
  the watchers.
- While it is **offline**, the live socket says nothing about it, and chat still
  reports people watching it.

An overlay that waits for the live socket to mention the channel will render
nothing during a stream that Kick has not marked live, and an overlay driven by
chat alone never has that dependency. The live socket is worth having anyway,
because it is the only source for the title, the preview image and the
platform's own viewer count.

## Keeping a connection up

`source.js` is worth reading before writing a reconnect loop; it encodes
problems already met in production:

- The backend completes the WebSocket handshake **before** it authenticates, so
  a connection it then rejects fires `onopen` first. It only counts a connection
  as healthy after 5 seconds.
- Close code 1001 is routine — Cloudflare cycling a server closes every client
  at the same instant — and is retried fast but with jitter.
- Retry is full jitter over a window doubling to a 60 second cap, floor 500 ms.

Keep-alive is not the application-level `PING` that chat-gui answers with
`PONG`. Both servers send **protocol-level WebSocket ping frames**: chat every
10 seconds, the live socket every 30. Measured 2026-09-05 over a long capture.

That is invisible to a browser, which answers control frames itself, and it is
handled for free by `ws` on the server. It is also a much better liveness
signal than an idle timer: chat is silent for ten seconds at most, so a
connection with no frame of any kind for thirty seconds is dead and can be
replaced without waiting minutes to find out.

chat-gui's `PING` handler is a separate, application-level event. None arrived
in the captures here, so it is rare rather than periodic — worth answering,
never worth relying on.

## Emotes, if the overlay renders all of them

`public/emotes/emotes.css` is a 251 KB snapshot covering 325 emotes, and its
`background-image` URLs are **relative** — `url("66596c571d8e5.png")`. Served
from this origin they resolve to nothing. Two ways out:

- Link `https://cdn.destiny.gg/emotes/emotes.css` directly. The relative URLs
  then resolve against `https://cdn.destiny.gg/emotes/`, which answers 200 for
  those hashed filenames. Images in CSS are not CORS-gated, so the CDN's
  `Access-Control-Allow-Origin: https://www.destiny.gg` on the image responses
  does not block them. That is one line and no mirroring, at the price of a
  runtime dependency on their CDN and no control over when it changes.
- Mirror the images and rewrite the URLs, which is what this repository already
  does for the nine avatar emotes.

`public/emotes/emotes.json` cannot substitute for the stylesheet. It carries
absolute, versioned image URLs but nothing about animation, and the sprite
sheets (`catJAM`, `RaveDoge`) and the transform animations (`pepeJAM`, `YAM`)
exist only as CSS keyframes. Generating CSS from the manifest produces 325
still images. `emotes.md` has the detail.

## One user at a time, over HTTP

`https://www.destiny.gg/api/chat/userinfo?username=<nick>` answers with that
user's `id`, `roles`, `features`, `createdDate` and `watching`, and needs no
authentication. It is a spot check rather than a source — there is no listing
form — but it is the way to confirm one person's state without a socket.

Its answer for `Destiny` also spells the roles `ADMIN` and `MODERATOR`, which is
the spelling `docs/backlog.md` records as never having been confirmed. That is
this endpoint's own vocabulary, not proof that the OAuth identity uses the same
strings, so it settles nothing on its own.

## How to check any of this again

Open both sockets with `ws`, log every frame, and read the log:

```js
new WebSocket('wss://chat.destiny.gg/ws', { headers: { Origin: 'https://www.destiny.gg' } })
new WebSocket('wss://live.destiny.gg/', { headers: { Origin: 'https://www.destiny.gg' } })
```

Reconciling the two is what produced the table above: keep a map from `NAMES`,
update it from the chat events, and tally it each time `dggApi:embeds` arrives.
