# Backlog

Work that is understood but deliberately not being done yet, and why. Items
leave this file when they ship or when they stop mattering.

## Destiny roles do not grant radio roles

`radioRole` used to map Destiny's `ADMIN` to radio admin and `MODERATOR` to
radio mod at sign-in, so a real destiny.gg moderator would arrive already able
to block and skip. That mapping is switched off: only `ADMIN_DGG_USERNAMES`
grants anything at sign-in, and every other role is given on `/admin`.

It was never known to be wrong. It was never known to be right either, because
`dgg_roles` has been `{}` for every login so far — which is the correct answer
for the three accounts on record, since none of them is a Destiny moderator or
admin. The mapping simply never had an opportunity to run, and shipping an
unexercised path that hands out moderation powers is the wrong way round.

The identity's `roles` array is still stored on every login. The first sign-in
by an actual Destiny moderator will show what it really contains, and whether
the strings are spelled `ADMIN` and `MODERATOR`. Turning it back on is a small
change to `radioRole` in `src/server/auth.ts`; `git log` has the version that
did it.

## A cooldown rejection at playback time tells the requester nothing

`startNextTrack` rechecks the repeat cooldown with its own candidate excluded,
so raising the setting while a request waits drops that request. The queue item
is marked `removed` with the ordinary automatic-playback reason, and playback
moves on. The person who queued it sees their track disappear with no
explanation anywhere.

This is rare by construction: the active-duplicate rule means no second copy of
a track can be waiting, so the only way to reach it is an admin raising the
cooldown over a pending request, or a matching track starting first. It is the
case the recheck exists for, and it works. Only the telling is missing.

Doing it properly means a place to put a message for one listener, which the
room does not have yet. Worth building alongside the first other thing that
needs one, rather than inventing a notification channel for this alone.

## Save controls are not on profile history

`/history` carries the heart control; `/profile/:username` does not, though it
renders the same entries. `SaveToPlaylistButton` and `usePlaylistLibrary` take a
`RoomMedia` and a list of media IDs and nothing else, so adding it is the same
few lines `CommunityPage` uses.

Left out of the first release to keep the surface small while the shape of the
feature settled. Nothing blocks it now.

## PostHog queries may still name the old region error

`YOUTUBE_BLOCKED_IN_UAE` became `YOUTUBE_REGION_BLOCKED` in `785775d`, and its
message names the configured region rather than always saying the UAE. Nothing
in the repository refers to the old spelling. Any saved PostHog query, insight,
or alert keyed on it went quiet at that deploy and needs updating by hand.

## Fifty tracks per playlist is a guess, not a decision

`MAX_PLAYLIST_TRACKS` is 50 in `playlists.ts`, mirrored by the `.max(50)` on
`playlistOrderSchema` and by the same cap on provider-playlist imports in
`room.ts`. It was picked because it matches the import limit and because it lets
"add playlist to queue" mean the whole playlist: no paging, no background job,
one request that either finishes or reports what it skipped.

Nothing has tested it against real use. Nobody has hit it yet, and it is not
known whether people want a handful of short themed playlists or one long
library of everything they have ever liked.

Raising it is not free. Queueing a whole playlist walks every track through
`enqueueMedia` in one request, so the ceiling is also how long that request can
run and how many provider lookups it can spend. Past a few hundred it stops
being one request and becomes a job with progress to report, which is a
different feature.

Leave it at 50 until somebody complains, then decide with that complaint in
hand rather than in advance.

## PostHog is wired up but never reviewed

`posthog-node` on the API and `posthog-js` in the browser, keyed by
`POSTHOG_API_KEY` and `PUBLIC_POSTHOG_KEY` and silently inert without them.
Nineteen server events across `app.ts`, two client events, exception autocapture
on both halves, and `.env.example` carries CI credentials for source-map
uploads.

That is the whole of it. The event names grew one at a time alongside the
features that emit them; no one has looked at whether they answer any question
worth asking, whether the properties are the right ones, or whether the
groupings and funnels PostHog offers would suit this room. None of the product
features -- session replay, feature flags, experiments, surveys -- has been
considered, turned on, or ruled out.

Worth a session of its own: read what PostHog actually offers, look at what the
existing events have collected so far, and decide what this project should use
and what it should stop sending. Until then the wiring stays as it is, which
costs nothing and keeps collecting.

## The listener count counts sockets, not listeners

`listenerCount` is `clients.size` in `server/index.ts`, where `clients` is the
set of open `/ws` connections. Two tabs are two listeners. So is a phone left on
the room overnight, and so is every OBS Browser Source, because `/embed/player`,
`/embed/playing` and `/embed/queue` all open the same socket through
`useRoomSnapshot`. The number in the topbar is closer to "open sockets" than to
"people here".

This is not only cosmetic. In ratio skip mode `downvotesForceSkip` divides
downvotes by this number, so every duplicate socket raises the bar for a skip
that should have passed. Whoever is running OBS is quietly making the room
harder to skip.

The identity needed to fix it is already there and thrown away: the connection
handler resolves the session user to decide the `authenticated` flag, then keeps
only the socket. Counting distinct signed-in users, and falling back to
something per-connection for anonymous ones, is a change to what `clients`
holds. What to do about anonymous viewers is the open question -- an IP is the
obvious grouping and is also wrong for anyone behind a shared address -- and it
should be settled before the count starts feeding a skip threshold differently
than it does today.

## No view of what the API is actually serving

Nothing in `/admin` shows what the server is doing: how many sockets are open,
who holds them, whether they are room pages or OBS sources, how long they have
lasted, how often the room clock is doing real work.

Everything above is answered by hand today, by reading the number in the topbar
and guessing. The listener-count item above is the first thing that needs it,
and a repeat cooldown or a blocklist rule going wrong would be the next.

Worth building once there is a second reason to want it, and worth deciding
first whether this belongs in the admin panel or in PostHog, which is already
wired into both halves and is the other item in this file waiting to be looked
at properly.

## The mobile layout has not been looked at since the site grew

Every page is responsive in the sense that nothing overflows the viewport, and
that is about as far as it was taken. Three things are wrong on a phone.

**The room player dominates.** Below 900px `.room-layout` becomes one column and
the player panel is ordered first, at full width, with no cap on its height. It
arrives before the queue, the request form, and everything else worth reaching,
so the parts people actually use start below the fold.

**History and stats scroll sideways.** `.community-table td` is
`white-space: nowrap`, and the track cell on both tables is pinned to
`min-width: 330px` at 50% width. On a 360px screen that one column is wider than
the phone, so `.community-table-wrap` scrolls horizontally for every row. The
nowrap suits a desktop table; it is the wrong shape for a phone, where these
probably want to stop being tables at all.

**The account block disappears.** At 620px `SiteHeader.css` hides
`.account-name`, `.account .avatar`, `.admin-label` and `.text-button`. That rule
was written when the header lived only on the room page and had to give its
width to the connection state and listener count. The header now carries the
account on every page, so on a phone there is nowhere at all to see who you are
signed in as or to sign out. Only the signed-out login button survives, which is
the one case that did not need the room.

The third is the smallest and the most annoying. Worth doing all three in one
pass on a real phone rather than at a narrowed desktop window, since the room
page in particular reads differently when the player is actually playing.

