ALTER TABLE "room_settings" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- The room's opening content, carried over from the queup room it replaces.
-- Rules that need a human to judge them are blocklists: an admin blocking a
-- track under one teaches it that track for good. The rest are advisory.
INSERT INTO "rules" ("name", "description", "enforcement", "position") VALUES
  (
    'No meme songs',
    'Unless a moderator or the broadcaster says otherwise. If you are asked to change your request, change it. Dicko Mode, The Glob, Thick of It, Big Booty Bitches, Chocolate Rain, Thomas the Tank Engine remixes, and anime or rap mashups all count.',
    'blocklist',
    0
  ),
  (
    'No Disney songs',
    'Songs from the Disney catalogue do not belong in the room.',
    'blocklist',
    1
  ),
  (
    'No rap battles involving Destiny',
    'Real or AI-generated, they cause the same chat spam every time.',
    'blocklist',
    2
  ),
  (
    'No music by enemies, exes, or former friends of Destiny',
    'Music by friends of Destiny is fine as long as it is not about him.',
    'blocklist',
    3
  ),
  (
    'No humorous or offensive music about race',
    'White & Nerdy is the standing exception.',
    'blocklist',
    4
  ),
  (
    'Nothing that reliably spams chat',
    'If a track turns the chat into a single copypasta every time it plays, it does not get another turn.',
    'blocklist',
    5
  ),
  (
    'Link the song, not the video',
    'Prefer the track as it appears on the album. Avoid music videos with long intros or outros, and scenes from film or television, unless the song is unique to that work.',
    'advisory',
    6
  ),
  (
    'Keep the room civil',
    'Do not spam sexual or otherwise inappropriate media around the room.',
    'advisory',
    7
  )
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE "room_settings" SET "description" =
'DGG Radio is one shared music room for the Destiny.gg community. Sign in with Destiny, queue YouTube or SoundCloud tracks, and take turns: everyone in the rotation plays one track before anyone plays a second.

Allowed and encouraged: Weird Al, 100 gecs, Death Grips and other abrasive or experimental music, nerdcore, music from composition challenges, Neil Cicierega, and anything you produced yourself.

Tracks are checked before they enter the queue for availability in the playback region, embedding, age restriction, and the length limit. If a track is skipped mid-play it usually became unavailable after it was queued.'
WHERE "id" = 1 AND "description" = '';
