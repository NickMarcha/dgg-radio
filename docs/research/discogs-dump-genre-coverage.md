# Labelling the archive with genre: MusicBrainz, Discogs, or both

Measured 2026-09-02 against the September 2026 Discogs masters dump and the live
MusicBrainz API, using the room's own 34,114-track archive.

## Answer

Use both. They cover different tracks through different keys, and together they
roughly double what either gives alone.

The decisive finding is that Discogs embeds YouTube video ids in its masters.
Joining on that id is exact, needs no MusicBrainz link, no fuzzy artist and title
match, and no Discogs API request. That is a completely different mechanism from
the one first tried, and it is the only reason Discogs is worth having.

| Route to Discogs genre | Coverage |
| --- | --- |
| Via MusicBrainz release-group `discogs.com/master` relation | 1.4% |
| Via YouTube video ids embedded in the dump | 30.8% |

## What each source covers

On the deterministic 100-video sample, with all 100 videos as the denominator:

| | of 100 |
| --- | --- |
| YouTube Music card present | 78 |
| MusicBrainz track-level genre (recording or release group) | 38 |
| MusicBrainz any-level genre, including the artist fallback | 58 |
| Discogs dump, video-id join | 30 |
| **Union of MusicBrainz track-level and Discogs** | **52** |
| **Union of MusicBrainz any-level and Discogs** | **66** |
| Discogs adds over MusicBrainz track-level | +14 |
| Covered by both, so cross-checkable | 16 |

Across the whole archive, Discogs alone matches **10,421 of 33,819 distinct
tracks (30.8%)** and **16,597 of 47,596 plays (34.9%)**. Coverage is better by
play count than by track count, so the tracks the room actually repeats are
better covered than the long tail.

## Where MusicBrainz keeps genre

Genre is not on the recording, which is where the first attempt looked. Of 72
accepted recordings:

- recording: 14 (19.4%)
- release group: 43 (59.7%)
- artist: 59 (81.9%)
- any level: 65 (90.3%)

Artist-level genre is the most populated and the least useful per track. Every
Boards of Canada track inherits `ambient / ambient techno / downtempo` regardless
of which track played. It is fine for room-wide statistics and useless for
telling two tracks by one artist apart. Track-level genre is 45 of 72 (62.5%) of
accepted recordings, which is 38 of 100 end to end.

The MusicBrainz **search** endpoint never returns genres. They arrive only from a
lookup with `inc=genres`. An earlier empty result was this, not absent data.

## The dump

`https://data.discogs.com/`, monthly, `discogs_YYYYMM01_masters.xml.gz`, 597 MB
in September 2026. Published under CC0 No Rights Reserved, covering Release,
Artist, Label and Master data.

- 2,589,349 masters
- 2,589,348 of them carry at least one genre, so a match is a genre
- 1,472,527 carry `<videos>`
- 5,764,413 distinct embedded YouTube video ids

Genres are coarse and paired with a much sharper `styles` list. `Rock / Soft
Rock, Pop Rock, AOR` is more useful than the genre alone.

Index only the video ids the archive contains. Keeping all 5.7 million exhausts a
4 GB Node heap.

Read the id from the `src` attribute of a `<video>` and nowhere else. Video
descriptions are free text that quotes unrelated YouTube URLs, so scanning the
whole record invents matches. Here it invented only 21 of 10,442, which is small
enough to have hidden the mistake behind a plausible number.

## The ambiguity, and what it costs

A video id can sit on several masters: the original album, a best-of, a later
compilation. They do not always agree.

- 10,421 matched tracks
- 7,077 on exactly one master
- 1,088 on several masters that agree on genre
- **2,256 (21.6% of matches) on masters that disagree**

Two-thirds of those conflicts (1,504) involve a Various-Artists compilation.

Some of it is not ambiguity but wrong data. The Beatles' `Happiness Is A Warm
Gun` is attached by real `<video src>` links to a Various-Artists compilation
carrying `Jazz, Pop` and to `The Blackwood Brothers Quartet` carrying `Folk,
World, & Country`. Neither is The Beatles. No tie-break rescues a track whose
every candidate master is wrong, so a residue of mislabelling survives any rule.

Tie-breaks measured against the 2,256 conflicts:

| Rule | Resolves | Archive covered |
| --- | --- | --- |
| none | 0 | 24.1% |
| drop Various-Artists masters | 743 (32.9%) | 26.3% |
| master artist appears in the play title | 721 (32.0%) | 26.3% |
| both | 827 (36.7%) | **26.6%** |

So Discogs realistically contributes **26.6% of the archive** with a defensible
genre, and 30.8% if ambiguous matches are accepted as-is. Neither rule is strong,
because the conflicts are mostly genuine disagreement in Discogs rather than a
selection problem.

## The live search path, for a track playing now

The dump is joined on video id, which the Discogs API cannot query, so a live
lookup has to search by the artist and track from the YouTube Music card. That is
fuzzy in a way the dump join is not, so it was measured rather than assumed.

On the 50 sampled tracks the dump missed that still had a Music card:

- returned a master: **26 (52%)**
- top result credited to the right artist: **26 of 26**
- top result credited to the wrong artist: **0**

It fails closed. When Discogs does not know the track it returns nothing rather
than something wrong, which is the behaviour that makes it safe to consult live.
Search results carry `genre` and `style` directly, so one unauthenticated request
is enough. No token is needed; 25 requests a minute is the unauthenticated limit.

This is the one Discogs path where the API terms bind, and the narrow use fits
them. A fetch for the track playing now is fresh by definition, so the six-hour
rule is satisfied, and a short-lived display cache is the "no longer than is
necessary to provide a service" the terms describe. What the terms forbid is
keeping API genre in the durable enrichment table. Keep the two apart: dump
genre is stored, API genre is cached for display and expires.

## Stacked coverage

Track-level genre across the 100-video sample, adding one layer at a time:

| Layer | Adds | Total |
| --- | --- | --- |
| MusicBrainz track-level | | 38 |
| + Discogs dump, unambiguous masters | +12 | 50 |
| + Discogs live search on the misses | +9 | 59 |
| + MusicBrainz artist-level fallback | +7 | 66 |

## Confidence, and why it should be shown

Every tier below is computable at enrichment time, so a track can carry its own
provenance instead of presenting all genres as equally certain.

| Tier | of 100 |
| --- | --- |
| Confirmed, both sources agree at track level | 14 |
| Track-level, MusicBrainz only | 24 |
| Track-level, Discogs only, unambiguous master | 12 |
| Ambiguous, Discogs masters disagree | 2 |
| Artist-level only, coarse | 14 |
| Nothing | 34 |

Store the source, the entity level it came from, and whether a second source
corroborated it. Artist-level genre in particular should never be displayed as
though it describes the track.

### Do not merge the two vocabularies

Discogs uses about fifteen broad genres plus a sharper `styles` list.
MusicBrainz uses a folksonomy of hundreds. Of the 16 sample tracks where both
have track-level genre, only 10 share a normalised token, but several of the six
misses are taxonomy artefacts rather than disagreements:

| MusicBrainz | Discogs | |
| --- | --- | --- |
| afrobeat, funk, jazz | Funk / Soul | same thing, different vocabulary |
| indie rock | Rock | same thing, different granularity |
| indie rock, post-punk, post-rock | Stage & Screen | genuine conflict |
| ambient, drum and bass, electronic | Rock | genuine conflict |

So 10 of 16 is a floor on agreement, not a measured rate. Keep the two
source-labelled and show them separately, which is what the attribution rules
push toward anyway since each needs its own link.

## Terms

The dump is CC0, so nothing here depends on the Discogs API terms. Those terms
are worth knowing anyway, because they rule the API out for stored enrichment:

> You may not display in any format or to any audience the Content if it is more
> than six (6) hours older than the information on Our online properties

> You may not cache or store the Content longer than is necessary to provide a
> service to Your application's users

The API also requires a `Data provided by Discogs.` notice next to the data, with
a hyperlink to the source page and no `nofollow`, plus a non-affiliation notice.
Genre and style are not among the fields the terms enumerate as CC0 Data, which
is a further reason to take them from the dump rather than the API.

MusicBrainz splits differently. Core data, which includes recordings, release
groups, artists, relationships and MBIDs, is CC0. Genre and tag **associations**
are supplementary data under CC BY-NC-SA 3.0, so displaying them needs
attribution and a non-commercial use. The room qualifies.

## Recommended shape

1. Match with the YouTube Music card. 78% availability, 86.8% song-level
   agreement against MusicBrainz.
2. Resolve identity against MusicBrainz. Store the MBID, which is CC0.
3. Take genre from MusicBrainz, preferring release-group over artist, and record
   which level it came from so coarse artist genre can be reported as such.
4. Fill gaps from a monthly Discogs dump join on video id, dropping
   Various-Artists masters and preferring one whose artist matches.
5. For a track playing now that none of the above covered, search the Discogs
   API once by card artist and title. Cache it briefly for display and never
   write it to the durable enrichment table.
6. Record the source, entity level, and whether a second source agreed, and show
   that alongside the genre.
7. Link back to both sources wherever the data is shown.

## What was built from this

All seven steps, on 2026-09-02.

| Step | Where it lives |
| --- | --- |
| Identity from the YouTube Music card | `src/server/youtube-music.ts` |
| MusicBrainz recording match and genre, by level | `src/server/musicbrainz.ts` |
| Storage, provenance and the display summary | `src/server/genre.ts`, `track_genres` (migration `0017`) |
| The dump join, with both tie-breaks | `scripts/discogs-dump-import.ts` |
| The per-track MusicBrainz pass, most played first | `scripts/enrich-genres.ts` |
| Live Discogs search for a playing track, cached in memory only | `src/server/discogs.ts` |
| Showing the source, the level, and the doubt | `src/components/TrackGenres.tsx` |

The first real run of the dump import, against 1,929 distinct YouTube tracks in
a partial archive, labelled 668 of them (34.6%), 92 from masters that disagree.
That is close to the 30.8% measured here, on a different sample.

## The MusicBrainz dumps, measured

Measured 2026-09-02, against the September 2026 export (`20260902-002507`) and
the room's own archive. The question was whether MusicBrainz can be joined the
way Discogs is, because that exact join on an embedded YouTube id is the entire
reason Discogs is worth having.

**It cannot.** `scripts/musicbrainz-youtube-relations.prototype.ts` asked
`/ws/2/url?resource=...` about the room's 100 most played YouTube tracks, trying
both the `youtube.com/watch?v=` and `youtu.be/` spellings:

| | of 100 |
| --- | --- |
| MusicBrainz knows the URL at all | 19 |
| Linked to a recording | **18** |
| Linked to a release | 2 |
| Linked to an artist | 0 |

18% against Discogs' 30.8%, and this is the friendliest possible sample: the
most played tracks are the best known ones, so the long tail is worse. Discogs'
30.8% was across the whole archive, not its head.

The sizes make the trade worse. From the export index:

- `mbdump.tar.bz2` — **7 GB**. Holds the URL relationships, and also the
  `recording` and `artist_credit` tables, so *every* dump route needs it.
- `mbdump-derived.tar.bz2` — 491 MB. Tags, and therefore genres, CC BY-NC-SA.

### It was built anyway, and the pessimism was wrong

`scripts/musicbrainz-dump-import.ts`, run against the whole archive on
2026-09-03. The exact-join half of the argument held; the conclusion drawn from
it did not.

**The URL join is worse than the sample suggested.** Across all 34,003 tracks it
matched 2,257 — 6.6%, against the 18% measured on the hundred most played. That
gap is the point: the head of a play-count distribution is the best known music
in the room, and coverage measured there does not survive contact with the tail.

**What rescued it was the fuzzy match, which only a dump can afford.** With the
tables open locally, matching on an artist and title parsed out of the upload
title costs nothing per track, so it can be tried on everything. Of 34,003
tracks, 17,626 have a readable `Artist - Title`; 10,638 of those titles exist in
MusicBrainz; 6,779 of them agree on the credited artist as well.

| | tracks | of 34,003 |
| --- | --- | --- |
| Identified — by URL | 2,257 | 6.6% |
| Identified — by artist and title | 6,779 | 19.9% |
| **Labelled with a genre** | **8,234** | **24.2%** |
| of those, about the track rather than the artist | 5,489 | 16.1% |
| recording level | 2,184 | |
| release group level | 3,305 | |
| artist level | 2,745 | |
| identified but genuinely unlabelled | 572 | |

**Together with Discogs it is a different picture entirely**, which is the claim
this whole document opened with and the first time it has been checked at full
scale rather than on a hundred videos:

| | tracks | of 34,003 |
| --- | --- | --- |
| Discogs alone | 10,462 | 30.8% |
| MusicBrainz alone | 8,234 | 24.2% |
| **Either** | **14,492** | **42.6%** |
| Both, so cross-checkable | 4,207 | 12.4% |
| Only MusicBrainz has it | 4,030 | 11.9% |
| Only Discogs has it | 6,255 | 18.4% |
| Genre about the track rather than the artist | 13,153 | 38.7% |

So the dump added **4,030 tracks nothing else covers** and took the archive from
30.8% to 42.6%. The earlier conclusion — that a dump would not pay for itself —
was drawn from the URL join alone and was wrong, because the thing worth having
was never the join. It was being able to try a fuzzy match 34,000 times for
free.

**What it costs.** 7.6 GB downloaded, about 17 GB extracted, and roughly 25
minutes of scanning after that. It needs more than Node's default 4 GB heap:
`--max-old-space-size` at 12 GB or more, since the `track` scan alone peaks
around 14 GB. All of it is temporary, and none of it has to happen on the
machine that runs the room — `--tracks` and `--out` take a 3 MB list of tracks
in and hand back a 4 MB file of answers.

The per-track pass in `scripts/enrich-genres.ts` still has a use: it reads the
YouTube Music card, which is a better identity than a parsed upload title, so it
can reach tracks the dump could not. It is now the follow-up rather than the
main route.

## Scripts

- `scripts/musicbrainz-genre-source.prototype.ts`, where MusicBrainz keeps genre
- `scripts/discogs-dump-coverage.prototype.ts`, the dump join and its ambiguity

Both are superseded by the code above and can go.
