# Backlog

Work that is understood but deliberately not being done yet, and why. Items
leave this file when they ship or when they stop mattering.

## Team affiliation is never detected

**Closed.** Team is no longer read from OAuth at all. `flair35`/`flair36` never
arrived on any login, so `teamFromFeatures` was removed and team now comes from
counting yee and pepe messages in Destiny chat through `polecat.me`.

What remains worth knowing, if that source ever has to be replaced: the OAuth
`features` array does arrive populated — `{flair5, flair1, subscriber}` and the
like — so the mechanism was never broken. Those two particular flair ids simply
never appear, which may mean team is not expressed as a flair at all.


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
