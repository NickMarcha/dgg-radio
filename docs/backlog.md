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

## The MusicBrainz dump import is memory hungry

`scripts/musicbrainz-dump-import.ts` needs `--max-old-space-size` at 12 GB or
more; Node's default 4 GB dies partway through the `track` scan, which peaks
around 14 GB. The heap grows with rows scanned rather than with rows kept, so
it is the scanning that costs, not the filtering.

Nothing depends on fixing it — the run takes 25 minutes on a workstation and
happens perhaps monthly — but it is the reason the script cannot simply be run
without thinking about it, and the reason `--tracks`/`--out` exist so it never
has to run anywhere near the deployment host.

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

## Session replay records every exception, including other people's

Replay is on and gated by an `$exception` trigger in the project's replay
settings: a visit where nothing broke is never uploaded, and one that did keeps
the in-memory lead-up. There is no sampling and no minimum duration, because at
eleven exceptions in three days there is nothing to sample.

`capture_exceptions` catches whatever reaches the window, which includes browser
extensions and third-party scripts the room did not load. None of that is worth
a recording, and each one spends a session on somebody else's bug.

Leave it alone until there is enough history to say what the noise actually is.
The fix is then one of three, in order of preference: name the offenders in
`autocapture_exceptions_errors_to_ignore` so they never become events at all;
add a minimum duration so a page that broke instantly and was closed is dropped;
or sample. Sampling is last because it discards real errors at the same rate as
noise.

The room's own player is a cross-origin iframe, so the video is a blank
rectangle in every recording. That is understood and accepted -- the controls,
the queue and the console around it are the parts worth watching.

## posthog-cli writes CI credentials into release metadata, unreported

`posthog-cli` describes each release with `git remote get-url origin` exactly as
git returns it. Netlify, and most CI, clones over HTTPS with a token inside that
URL, so `metadata.git.remote_url` on every release holds a live credential that
anyone with project access can read. Here it was a GitHub App installation
token, good for an hour, rewritten on every deploy.

This room is not affected any more: the Netlify build command strips any
`user:password@` from the remote before the build runs, and the release recorded
for `19277448` is clean. The rest is somebody else's bug.

Reporting it upstream is **not planned**. It is a real issue for anyone whose CI
clones with a token, and stripping the userinfo at the point of capture would
fix it for every provider at once, but chasing another project's fix is not this
room's work. Anyone who wants to raise it can: PostHog take reports through the
`agent-feedback` channel in their CLI, and there is a drafted version of this in
the session that found it.

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
