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

## The PostHog event set has never been judged against real data

Server events only started arriving on 2026-08-30, when `POSTHOG_PROJECT_KEY`
replaced a key the capture endpoint silently rejected. Before that the project
had browser events only, so nobody could tell whether the eighteen server events
answer anything worth asking. Now they can, but not yet: there is no history to
judge them by.

Worth revisiting once a few weeks of server events exist. The questions are
whether the properties are the right ones, whether any event should stop being
sent, and what is missing -- the room's own machinery is the likely gap, since
a track failing its playback check, a provider lookup timing out, and a socket
closing abnormally are the things a diagnosis actually starts from.

Session replay is off (`disable_session_recording: true`) and autocapture is off
deliberately, the explicit events being better than guessed ones. Replay is the
one product feature worth reconsidering, because "it just stopped playing" is
answered faster by watching one session than by any dashboard. Feature flags,
experiments and surveys have no use here yet.

## The Cloudflare rate-limiting rule has not been created

The API now limits itself per caller, in `src/server/rate-limit.ts`. That covers
what an account can spend but not what a flood of anonymous requests costs, and
the room only has one rule to spend on the second problem.

The API is published through a named tunnel, so it sits behind Cloudflare's WAF
already and a rule needs no new infrastructure. The Free plan allows exactly one
rate-limiting rule, counts by IP only, and offers a ten-second period and no
longer one, so the rule has to be blunt on purpose:

- Match `http.request.uri.path starts_with "/api/"` on the tunnel hostname.
- Count by IP, 100 requests per 10 seconds, then block for a minute.

That is far above real use and still stops a script. The only chatty endpoint is
`/api/room`, which each open room polls every 15 seconds and refetches whenever
the room changes; a household or a VPN exit sharing one address stays well under
100 in ten seconds, and it is deliberately not limited per address inside the API
for the same reason.

Worth revisiting if the room ever outgrows the Free plan: a longer period and
counting by cookie would let the rule follow a person instead of an address.

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
