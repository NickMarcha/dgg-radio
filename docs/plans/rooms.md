# Rooms plan

Status: step 1 is built.

## Outcome

The site has one main room at `/` and any number of other rooms, each with its
own queue, settings, rules, Kick channel, and OBS overlays. A room is run by
its owner and the moderators they pick. The site admin decides who may own
rooms.

The room's own embed history goes away. mitchdev.net/dgg/embeds already
records every destiny.gg embed over time, so the room only needs to know who is
watching now.

## Roles

Two levels, kept apart:

| Level | Who | Can |
| --- | --- | --- |
| Site admin | Root admins from `ADMIN_DGG_USERNAMES` | Whitelist room creators, act in every room |
| Room creator | Users the site admin whitelists | Create a room they then own |
| Room owner | The creator of a room | Settings, channel, overlays, rules, and that room's moderators |
| Room moderator | Users the owner whitelists | Block, skip, reorder, and edit that room's rule lists |

Most of what needs `admin` today moves to the room owner. `users.role` stops
meaning anything per room; room-level roles live in `room_members`. The main
room is owned by the site admin, and today's mods become its moderators.

`rooms.owner_user_id` is not unique, so the schema allows several rooms per
owner. Creating a room is refused while the owner already has one; that check
is the only thing to remove when several are allowed.

## Rules

There are no site-wide rules for the admin to curate. Every rule belongs to
one room, and that room's owner and moderators edit its list. Rules are public,
so any room can use any other room's rule in one of two ways:

- **Follow.** The rule is enforced in the following room exactly as its home
  room keeps it, including tracks blocked later. The follower cannot edit it.
- **Snapshot.** The rule and its entries are copied into the room as a new rule
  of its own, editable there and independent from then on.

The home room can grant edit access on a single rule to others, so a list
several rooms rely on can be kept by more than one team without those people
gaining anything else in the home room. A grant names either one user or a
whole room, whose owner and moderators can then all edit the rule. Both kinds
exist from the start; which one gets used is something to watch rather than
guess.

Because a followed list changes other rooms, every change to a rule's entries
is logged with who made it and why. The home room's owner and the site admin
can revert any logged change; editors can make changes but not revert them.
`moderation_actions` is the starting point for that log.

## Queues

A listener can listen to any number of rooms but queue in only one at a time.
The rotation seat moves from `users.rotation_seq` to a `room_seats` table keyed
by user, which makes "one room at a time" a primary key rather than a check.

Queueing in a second room asks first. Confirming moves the listener's waiting
tracks to the new room in their order and puts them at the back of its
rotation. The prompt lists any track the new room would refuse (its rules,
duration limit, or cooldown); those are left out of the move. A track already
playing in the old room finishes there.

## Build order

Each step leaves a working site.

1. **Drop embed history.** Remove `stream_watch_samples`,
   `stream_watch_channels`, the sampler and its timers, the history and
   channels routes, the admin graph, and its `storage.ts` entry. The live site
   socket stays: it supplies live status, the site count, and the chat gate.
2. **Add `rooms` with only the main room.** Key `room_settings`, `room_state`
   and `stream_watch` by room. Nothing visible changes.
3. **Scope the room.** `room_id` on `queue_items` and `rules`; `room_seats`;
   one playing item per room; per-room queue lock; the clock loops rooms; the
   socket subscribes to a room.
4. **Room-level roles.** `room_members`, the creator whitelist, and moving
   admin actions to owners and moderators.
5. **Room URLs and overlays.** `/r/:slug` through one generated page, embed
   pages take the room, saved overlay settings keyed by room and owner.
6. **Many channels.** One chat socket feeds a roster per followed channel.
7. **Room creation, rule following and snapshots, the revertable rule log,
   combined stats.**
