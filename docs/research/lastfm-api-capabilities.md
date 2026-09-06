# What Last.fm's API is worth to this room

Status: parked on 2026-09-06, the day it was written. Nothing here is planned or
queued. The credentials are in `.env` and the production callback is registered,
so any of it can start whenever somebody wants it to. The build order near the
end is what I would do if asked, not a commitment anybody has made.

Checked 2026-09-06 against Last.fm's own documentation, 1,198 live calls made
with the room's key, and 68 YouTube searches through the room's own search path.
Every sample comes from the archive or from real Last.fm accounts.

## Answer

**On playlists first, since that is the obvious thing to want.** Last.fm has no
playlist API. The `playlist` package and `user.getPlaylists` were retired years
ago and that URL answers 404 today. What a person can bring across instead is
their loved tracks, their top tracks over a chosen period, and anything they
have personally tagged, all readable from a username with no login. The catch is
that Last.fm gives names and never provider ids, so an importer has to search
for each one. I measured that: 95.0% of 80 tracks from two real lists resolved
to a playable YouTube video, and both remaining misses were my automatic check
being stricter than a person would be. The section below has the numbers and the
two traps.

Beyond playlists, Last.fm is two useful things and one disappointment.

The disappointment is genre at track level. Of 300 archive tracks no source has
ever labelled, only 10 have a single track tag on Last.fm. That is 3.3%, and the
dedicated `track.getTopTags` returns exactly the same 10 as the tags embedded in
`track.getInfo`, so it is not a weak field but an empty shelf. Discogs and
MusicBrainz already answer for tracks this obscure far more often.

The first useful thing is genre at artist level. The same 300 tracks get artist
tags 91.0% of the time, and 89.0% of them include a term already in the 1,058
Discogs and MusicBrainz words the room uses. That fills a gap the dumps cannot,
and it costs 4,788 requests rather than 7,426 because the unit is the artist.
Roughly eighty minutes against the sixteen hours the per-track pass in
`scripts/enrich-genres.ts` needs. It is the coarse kind of genre, the kind
`genre_level` already calls `artist` and warns must never be shown as though it
described the track.

The second useful thing is similarity, and it surprised me. A support thread
claims `track.getSimilar` stopped answering in 2025. It answers. Sixty
well-known archive tracks all got a full list, median 20 results, and on average
5.5 of those 20 are tracks this archive already holds. Similar artists do better
at 10.5 of 20. So a "play something like this" button could be answered out of
the room's own history most of the time, which is a different and better product
than sending people to YouTube.

Scrobbling works too, and is the thing the callback URL is for. I verified the
key and secret sign a request correctly: `auth.getToken` returned a 32-character
token. Whether the room should scrobble is a product question rather than a
technical one, and it has a trap in it. See below.

## What the API gives you

Eight packages. `album`, `artist`, `chart`, `geo`, `library`, `tag`, `track`,
`user`, plus `auth`. Everything reads over `https://ws.audioscrobbler.com/2.0/`
with `format=json`, and only the writing methods need a signature.
[Method list](https://www.last.fm/api/intro)

Three of the packages matter here.

**`track` and `artist` answer questions about music.** `track.getInfo` returns
listeners, global playcount, duration, album, an MBID when it has one, and the
user's own playcount and loved flag if you pass a `username`. `track.getSimilar`
and `artist.getSimilar` return ranked lists with a `match` score.
`track.getTopTags` and `artist.getTopTags` return the folksonomy.
[track.getInfo](https://www.last.fm/api/show/track.getInfo),
[track.getSimilar](https://www.last.fm/api/show/track.getSimilar)

**`user` answers questions about a person, without any authentication at all.**
`user.getRecentTracks` takes a username and returns up to 200 plays a page, with
`from` and `to` timestamps and a `nowplaying` flag on the current one.
`user.getTopArtists`, `user.getTopTags`, `user.getLovedTracks` and the weekly
charts are the same shape. A DGG Radio profile could show what somebody has been
listening to elsewhere from nothing but a username they type in.
[user.getRecentTracks](https://www.last.fm/api/show/user.getRecentTracks)

**`auth` plus `track.scrobble` writes.** The web flow is short: send the user to
`https://www.last.fm/api/auth/?api_key=…`, receive a `token` on the callback URL,
exchange it through `auth.getSession` for a session key. Tokens last 60 minutes,
session keys have an infinite lifetime until the user revokes access, and the
signature is an MD5 of the parameters sorted by name, concatenated as
`<name><value>`, with the shared secret appended.
[Web auth](https://www.last.fm/api/webauth)

A scrobble needs artist, track and a UNIX timestamp, and takes optional album,
`albumArtist`, `duration`, `mbid` and `chosenByUser`. Up to 50 per request.
Last.fm's own rule for when a play counts: the track must be longer than 30
seconds, and must have played for at least half its length or four minutes,
whichever comes first. Ignored scrobbles come back with a code, and code 5 is
the daily limit.
[Scrobbling rules](https://www.last.fm/api/scrobbling),
[track.scrobble](https://www.last.fm/api/show/track.scrobble)

## Measured against this archive

Names came from the YouTube Music identity cache, the same 20,093 `Artist -
Title` pairs that made the dump imports work. Asking Last.fm with a raw upload
title would have measured our parser instead of their catalogue.

Two samples, spread deterministically across the whole list rather than its
head, because the head of a play-count distribution is the best known music in
the room and flatters every source.

| | tracks no source has labelled | already labelled |
| --- | --- | --- |
| sampled | 300 | 200 |
| Last.fm has the track | 286 (95.3%) | 197 (98.5%) |
| any track tag | 10 (3.3%) | 33 (16.5%) |
| a track tag the room's vocabulary knows | 10 (3.3%) | 32 (16.0%) |
| carries an MBID | 115 (38.3%) | 150 (75.0%) |
| median listeners | 4,435 | 55,579 |

The 17 tracks Last.fm did not have came back as error 6, track not found, which
is 3.4% of the 500.

Track tags are the headline and they are bad. Artist tags are a different story,
measured on the same 300 unlabelled tracks:

| | tracks |
| --- | --- |
| `track.getTopTags` returns anything | 10 (3.3%) |
| `artist.getTopTags` returns anything | 273 (91.0%) |
| artist tag already in the room's vocabulary | 267 (89.0%) |

Where both Last.fm and an existing source knew something, they agree: 28 of 33
comparable tracks share at least one term, 84.8%. Small sample, but it is the
right direction.

Similarity, on the 60 most-listened tracks in the labelled sample:

| | result |
| --- | --- |
| `track.getSimilar` answered | 60 of 60 |
| `artist.getSimilar` answered | 60 of 60 |
| median similar tracks returned | 20 |
| of those 20, already in this archive | 5.5 on average |
| of 20 similar artists, already in this archive | 10.5 on average |

Both "already in this archive" numbers are floors. They match exact `Artist -
Title` strings against the 20,093 identified tracks, and the archive holds
34,248.

## What this would do to genre coverage

Coverage today is 21,726 of 34,248, or 63.4%. The unlabelled remainder is
12,522 tracks, and 7,426 of them have a YouTube Music identity to ask with. At
the measured 91.0% that is about 6,758 more tracks labelled, taking coverage to
roughly 83%.

Read that number carefully. All of it is artist-level, so the honest split moves
from 55.1% track-level and 8.3% artist-level to 55.1% and about 28%. The room
already has 5,563 artist-level rows from MusicBrainz and already draws the
distinction in the schema, so this is not a new compromise, just more of an
existing one.

The cost is the reason to like it. 4,788 distinct artists, one request each,
about eighty minutes at a request a second. The per-track pass that moves
track-level coverage costs sixteen hours and three requests a track. These are
not alternatives, they answer different questions, and the cheap one has never
been run.

## The constraints that actually bite

**Non-commercial by default, and the room should stay that way.** Any commercial
use without a separate agreement is a material breach, and the contact is
partners@last.fm. [Terms](https://www.last.fm/api/tos)

**A 100 MB storage cap.** Last.fm calls it the Reasonable Usage Cap. Artist tags
for 8,874 artists are nowhere near it. Storing scrobble history or user listening
data would need the arithmetic doing first.

**Attribution is required.** Artist, album and track names have to link back to
the matching Last.fm page, and a "powered by AudioScrobbler" mark belongs
somewhere visible. This is the same shape as the MusicBrainz and Discogs links
already stored in `source_url`, so `track_genres` has the column for it.

**Termination means deletion.** Last.fm can end the agreement at any time with
or without cause, and on termination you delete all Last.fm data you hold. That
is a stronger claim than Discogs makes, and it is the argument for keeping
Last.fm answers in their own rows rather than merging them into a shared genre
column. The existing one-row-per-source design already does exactly this.

**Rate.** No published number. The documentation says an account may be
suspended for continuously making several calls per second, and asks for an
identifiable User-Agent. I ran at four a second across 1,198 calls with no
throttling, but a request a second is the neighbourly choice for a batch pass.

## Traps

**The tag `count` is not a number of people.** In every response sampled, both
track and artist, the top tag's count is exactly 100. It is a weight normalised
to the leader, so one person's joke tag on an obscure track reads as 100. LCD
Soundsystem's "Home" comes back tagged `poptron` at 100 ahead of `electronic` at
8. Any threshold like "keep tags above 50" keeps the joke and throws away the
genre. Rank position and the shape of the whole list are the usable signals.

**Tags are not a controlled vocabulary.** `seen live`, `favorites`, `90s`,
`female vocalists` and `mommy issues fml` all appear in the sample. Intersecting
against the 1,058 terms Discogs and MusicBrainz already gave us is the cheap
filter, and it kept 89.0% of the artist answers, so it costs almost nothing.

**Last.fm knows a track without knowing anything about it.** 95.3% "found" and
3.3% tagged is the same population. `found` here means an entry exists because
somebody once scrobbled it, not that there is metadata behind it. Do not report
the first number as coverage.

**A scrobble has to be something the person actually heard.** The room plays one
track to everybody, and `getRoomSnapshot` already writes `users.last_seen_at` on
every poll, so the server knows who was present. That makes server-side
scrobbling for connected listeners technically easy and is exactly why it needs
care: a listener who muted the tab, or whose browser was open on another screen,
would get a play in their profile they did not hear. Last.fm's own guidance is
that scrobbles reflect listening.

**Do not feed corrections back in.** `autocorrect=1` is right for a lookup and
wrong for a scrobble. Last.fm asks that corrections from a now-playing response
not be used in a scrobble without the user approving them.

## Importing and exporting playlists

There is no playlist API. The `playlist` package and the old `user.getPlaylists`
were retired with the radio methods, and that URL now answers 404. Nothing in
the nine remaining packages creates, reads or writes a playlist. If somebody
asks to import their Last.fm playlists, the honest answer is that Last.fm has
not had playlists you can read through the API for years.

What it does have is three lists that a person would recognise as theirs, and
all three read without any authentication at all, from nothing but a username
typed into a box.

| method | what it is | why somebody would import it |
| --- | --- | --- |
| `user.getLovedTracks` | tracks they hit the heart on | the closest thing to a favourites playlist |
| `user.getTopTracks` | most played, over `7day`, `1month`, `3month`, `6month`, `12month` or `overall` | "my year in music", as a queue |
| `user.getPersonalTags` | tracks they tagged with one word, `taggingtype=track` | an actual hand-curated list, if they tag |

`user.getWeeklyTrackChart` with `from` and `to` gives an arbitrary week, and
`user.getRecentTracks` gives raw history 200 a page.

### The importer's real problem is names, not lists

Last.fm hands over an artist and a title. It never hands over a YouTube or
SoundCloud id. The QueUp importer in `src/server/playlists.ts` never faced this,
because a QueUp export carries provider ids, so `importQueupPlaylists` resolves
straight through `resolveMediaForLibrary`. A Last.fm importer has to search
first, and how often that search finds the right video is the whole question.

Measured on two real lists, 80 tracks, each checked first against the archive
and then through the room's own `searchYouTube`:

| | rj top tracks | rj loved tracks |
| --- | --- | --- |
| already in this archive, no search needed | 7 (17.5%) | 3 (7.5%) |
| found as the first search result | 29 | 34 |
| found lower in the first five | 2 | 1 |
| no confident match | 0 | 2 |
| YouTube search itself failed | 2 | 0 |
| **playable** | **38 (95.0%)** | **38 (95.0%)** |

95% is a floor, not a ceiling. The two remaining misses are both The Lonely
Island, where the right video is the top result on a channel not named after the
band, so my automatic check refused it and a person would have accepted it.
Matching was strict on purpose: the video's title, or its title plus the
uploading channel, had to contain both the artist and the track.

Two things fell out of that run that an importer has to handle.

**Last.fm hangs the version off the end of the title after a dash.** "Here Comes
the Sun - Remastered 2009", "Wandering Eye - Radio Edit", "Jungle - Feat.
Maverick Sabre". YouTube puts the same information in brackets, or in a
different order, or leaves it out. My first pass scored four of these as
failures when the right video was sitting at the top of the results. Splitting
the Last.fm title on that dash and matching the part before it took both lists
from about 91% to 95%. This is the single fiddliest part of the job and it is
about twenty lines.

**`@distube/ytsr` failed outright on 2 of 70 searches**, with "Unsupported
YouTube Search response". Roughly 3%, and unrelated to the track. An import of
fifty tracks will have one or two of these, so a per-track retry and a skip
reason the person can act on are both needed. The existing importer already
reports per-track skips with reasons and allows partial success, which is
exactly the shape this needs.

### Exporting the other way

Three options, in descending order of how much I like them.

**A plain text or CSV list of `Artist - Title`.** No Last.fm involvement at all,
no auth, works with every third-party transfer tool, and `exportCsv` in
`src/server/export.ts` is already the mechanism. This covers most of what people
mean by exporting a playlist and it could ship this week.

**`track.love` for each track.** Signed, one call per track, and it lands in
the user's loved tracks where `user.getLovedTracks` reads it back. A real
round-trip, and the semantics are honest: loving a track is a claim about the
track, not about a list.

**`track.addTags` with the playlist name as a personal tag.** Up to 10 tags a
call, read back through `user.getPersonalTags`. This is the only way to get a
named list onto Last.fm and have it come back as that same named list. It is
also a slightly odd use of somebody's public tags, so it should be opt-in and
clearly labelled. I have not tested the write side, which needs a real user
session.

Worth saying plainly: the room already imports playlists that actually exist, in
`enqueueProviderPlaylist` for YouTube and SoundCloud and `importQueupPlaylists`
for QueUp files. Last.fm adds loved and top tracks to that list, not playlists.

## What I would build, in order

0. **Import loved and top tracks by username.** No OAuth, no stored credential,
   nothing to revoke. A person types their Last.fm name, picks "loved" or "top
   tracks this year", and gets a playlist. It reuses `importQueupPlaylists`
   almost entirely: distinct-track dedupe, `warmYouTubeLookups` in fifties,
   `resolveMediaForLibrary`, merge into a playlist of the same name, partial
   success with per-track reasons. The new part is name to provider id, worth
   95% and about twenty lines of title cleaning. Export as a text list at the
   same time, because that half needs no API at all.

1. **Artist-level genre from `artist.getTopTags`.** Eighty minutes of requests,
   about 6,700 more labelled tracks, and it lands in the table that already
   exists. `genre_source` needs a third value, `lastfm`, and `genre_level` already
   has `artist`. Filter tags against the existing vocabulary, keep the top few by
   rank, store the Last.fm URL in `source_url`. The seed export picks it up and
   the next deploy carries it.

2. **"More like this" out of the room's own archive.** `track.getSimilar` for the
   playing track, intersected with what the archive holds, is a request panel
   that suggests music the room has actually played before. 5.5 of 20 hit today
   and that improves as the identity cache grows. This is the feature I would
   most want as a listener, and it needs no login from anybody.

3. **A Last.fm username on a profile, read-only.** No OAuth, no scrobbling, no
   stored data beyond the username. `user.getTopArtists` and `user.getRecentTracks`
   would let a profile page show what somebody listens to when they are not here,
   and `user.getTopArtists` against the room's own play history is a taste-overlap
   number that would be fun on a profile.

4. **Scrobbling, last and deliberately.** It is the most-asked-for feature of
   this kind and the one with the most ways to annoy people. If it gets built,
   the session key belongs to the user, the scrobble should follow Last.fm's own
   threshold rather than the room's, and it should be off until the person turns
   it on. The callback URL is already registered, so the flow is a few hours of
   work whenever it is wanted.

What I would not build is track-level genre from Last.fm. 3.3% is not worth a
code path.

## Method

Four probes, all cached per request in
`%TEMP%\dggradio-lastfm-probe`, results in `%TEMP%\dggradio-lastfm-probe.json`,
`-tags-probe.json` and `-similar-probe.json`. Input was
`%TEMP%\dggradio-identities-full.json` from `scripts/youtube-music-identities.ts`
and `data/genres.json` for what is already known. The fourth probe ran inside
the repository so it could import `searchYouTube` from `src/server/media.ts`,
cached its search results in `%TEMP%\dggradio-lastfm-import-search`, and was
removed afterwards rather than left in `scripts/`.

One correction worth recording, because it nearly went into this document as a
finding. The first run of the similarity probe reported that The Cure, The
Cardigans and The Cranberries all had the same top similar track, which looked
like the reported 2025 breakage. It was my own cache key: a base64 of the query
string truncated to 120 characters, and the first 90 bytes of that query are the
method name, the 32-character API key and `format=json`. Roughly eight bytes of
artist name were doing the distinguishing. Hashing the full query string and
rerunning gave track-specific answers and the opposite conclusion. A cache key
that is a prefix of something long is a cache key that lies quietly.
