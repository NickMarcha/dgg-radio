-- Clears the room's played history, every vote cast on it, and the moderation
-- log describing it, so testing done before the room opens does not become the
-- first thing real listeners see.
--
-- ONLY WHILE THE ROOM IS IN BETA. `AGENTS.md` makes the badge in the room
-- header the line: while it is there the stored data is disposable, and once it
-- is gone the data belongs to the community and anything destructive has to be
-- raised before it is written. If the badge is gone, do not run this.
--
-- Deleted:
--   * every queue item, whatever its status, including anything playing now
--   * every vote, which the foreign key removes along with its queue item
--   * each person's place in the turn rotation, so nobody starts owed a turn
--   * every moderation record, which is the log the admin panel's Log tab
--     shows. All of it describes moderating tracks that are being deleted here,
--     so leaving it would fill that tab with entries pointing at nothing
--
-- Kept:
--   * personal playlists and their tracks, which point at `media` rather than
--     at the queue, so nobody loses a saved track
--   * the track catalogue and provider cache, so the room does not re-look-up
--     what it already knows and spend YouTube quota doing it
--   * accounts and roles, so nobody has to be made an admin again
--   * rules and their entries, so a blocklist built while testing still blocks
--
-- The repeat cooldown works by finding when a track last started, so clearing
-- history makes every track immediately requestable again. That is the point,
-- but it is worth knowing before the room is busy.
--
-- Run it against the API's database, from the repository root:
--
--   docker compose exec -T db psql -U dgg_radio -d dgg_radio \
--     -v confirm=yes -f - < scripts/clear-beta-history.sql
--
-- Without `-v confirm=yes` it refuses and changes nothing.

\if :{?confirm}
\else
\echo ''
\echo 'Refusing: this deletes every queue item and vote in this database.'
\echo 'Re-run with -v confirm=yes once you are sure, and only while the room is in beta.'
\echo ''
\quit
\endif

\echo 'Before:'
SELECT
  (SELECT count(*) FROM queue_items) AS queue_items,
  (SELECT count(*) FROM votes) AS votes,
  (SELECT count(*) FROM moderation_actions) AS moderation_actions,
  (SELECT count(*) FROM media) AS media_kept,
  (SELECT count(*) FROM playlist_items) AS playlist_tracks_kept;

BEGIN;

-- Both of these point at queue items without a cascade, so they have to go
-- first or the delete below fails on the foreign key. `room_state` lets go of
-- the playing track; the moderation records are deleted outright, since every
-- one of them describes a track that is about to stop existing.
UPDATE room_state SET current_queue_item_id = NULL WHERE id = 1;
DELETE FROM moderation_actions;

DELETE FROM queue_items;

-- Turn order is held on the user, not in the queue, so it outlives the history
-- it was built from and would seed the first real rotation with test data.
UPDATE users SET last_played_at = NULL WHERE last_played_at IS NOT NULL;

COMMIT;

\echo 'After:'
SELECT
  (SELECT count(*) FROM queue_items) AS queue_items,
  (SELECT count(*) FROM votes) AS votes,
  (SELECT count(*) FROM moderation_actions) AS moderation_actions,
  (SELECT count(*) FROM media) AS media_kept,
  (SELECT count(*) FROM playlist_items) AS playlist_tracks_kept;

\echo 'Done. The room clock starts the next queued track on its own; there is none, so the room is idle.'
