# Stations plan

Status: steps 1 to 6 are built, and from step 7 everything but per-station and site-wide stats.

## Outcome

The site has one main station at `/` and any number of other stations, each with its
own queue, settings, rules, Kick channel, and OBS overlays. A station is run by
its owner and the moderators they pick. The site admin decides who may own
stations.

The station's own embed history goes away. mitchdev.net/dgg/embeds already
records every destiny.gg embed over time, so the station only needs to know who is
watching now.

## Roles

Two levels, kept apart:

| Level | Who | Can |
| --- | --- | --- |
| Site admin | Root admins from `ADMIN_DGG_USERNAMES` | Whitelist station creators, act in every station |
| Station creator | Users the site admin whitelists | Create a station they then own |
| Station owner | The creator of a station | Settings, channel, overlays, rules, and that station's moderators |
| Station moderator | Users the owner whitelists | Block, skip, reorder, and edit that station's rule lists |

Most of what needs `admin` today moves to the station owner. `users.role` stops
meaning anything per station; station-level roles live in `station_members`. The main
station is owned by the site admin, and today's mods become its moderators.

`stations.owner_user_id` is not unique, so the schema allows several stations per
owner. Creating a station is refused while the owner already has one; that check
is the only thing to remove when several are allowed.

## Rules

There are no site-wide rules for the admin to curate. Every rule belongs to
one station, and that station's owner and moderators edit its list. Rules are public,
so any station can use any other station's rule in one of two ways:

- **Follow.** The rule is enforced in the following station exactly as its home
  station keeps it, including tracks blocked later. The follower cannot edit it.
- **Snapshot.** The rule and its entries are copied into the station as a new rule
  of its own, editable there and independent from then on.

The home station can grant edit access on a single rule to others, so a list
several stations rely on can be kept by more than one team without those people
gaining anything else in the home station. A grant names either one user or a
whole station, whose owner and moderators can then all edit the rule. Both kinds
exist from the start; which one gets used is something to watch rather than
guess.

Because a followed list changes other stations, every change to a rule's entries
is logged with who made it and why. The home station's owner and the site admin
can revert any logged change; editors can make changes but not revert them.
`moderation_actions` is the starting point for that log.

## Queues

A listener can listen to any number of stations but queue in only one at a time.
The rotation seat moves from `users.rotation_seq` to a `station_seats` table keyed
by user, which makes "one station at a time" a primary key rather than a check.

Queueing in a second station asks first. Confirming moves the listener's waiting
tracks to the new station in their order and puts them at the back of its
rotation. The prompt lists any track the new station would refuse (its rules,
duration limit, or cooldown); those are left out of the move and dropped from
the queue with a notice, since the old station is no longer the listener's. The
history and playlist pages queue into the station this browser last opened and do
not offer the move; queueing from the station itself does. A track already
playing in the old station finishes there.

## Build order

Each step leaves a working site.

1. **Drop embed history.** Remove `stream_watch_samples`,
   `stream_watch_channels`, the sampler and its timers, the history and
   channels routes, the admin graph, and its `storage.ts` entry. The live site
   socket stays: it supplies live status, the site count, and the chat gate.
2. **Add `stations` with only the main station.** Key `station_settings`, `station_state`
   and `stream_watch` by station. Nothing visible changes.
3. **Scope the station.** `station_id` on `queue_items` and `rules`; `station_seats`;
   one playing item per station; per-station queue lock; the clock ticks every station;
   repeat cooldown and blocking are per station. Queueing in a second station is
   refused for now (`QUEUED_ELSEWHERE`); the prompt that moves a queue comes
   with station creation.
4. **Station-level roles.** `station_members`, the creator whitelist, and moving
   admin actions to owners and moderators. Until stations have their own pages
   the admin page is still site admins only; it manages the main station's mods
   and the whitelist.
5. **Station URLs and overlays.** `/s/:slug` through one generated page, the API
   and the station socket take the station, embed pages take the station.
6. **Many channels.** One chat socket feeds a roster per followed channel.
   Saved overlay looks stay keyed by owner rather than by station and owner: the
   overlay URL names the station, so a second key would add nothing.
7. **Station creation, moving a queue between stations, rule following and
   snapshots, the revertable rule log, per-station and combined stats.** Stats and
   the jammer board still count every station together until then.
