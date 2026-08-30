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

## Database storage has no history and no owner view

`/admin#server` measures the whole database and six named groups on load or on
a manual refresh. Two things named in the item that shipped it were left out.

Growth is invisible. One total and one row per group written once a day would
give a real seven-day and thirty-day change for almost no storage, and without
writing a metric on every request. Worth doing when a figure on that card
starts moving fast enough to care about.

There is no playlist-owner drilldown. Playlist and item counts per owner are
straightforward. PostgreSQL page bytes per owner are not, because several
owners' rows share the same pages, so a per-user byte figure would be an
estimate dressed up as a measurement. Counts only, if it is built at all.
