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

