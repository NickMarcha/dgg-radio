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

## The MusicBrainz dumps, which were not used

MusicBrainz publishes database dumps too, and for the same reason the Discogs
dump won — no per-track requests — they are worth measuring before another long
enrichment run. This has **not** been done. What is known so far is only what
their [download documentation](https://musicbrainz.org/doc/MusicBrainz_Database/Download)
says:

- `mbdump.tar.bz2` is the core database, CC0, and holds the URL relationships.
- `mbdump-derived.tar.bz2` holds tags, and genre association is done through
  tags, so it is the file the genres are in. It is CC BY-NC-SA 3.0, which
  matches what the room already attributes.

Three things would decide it, and none of them is answered yet:

1. **How many recordings carry a YouTube URL relation.** If that number is
   anything like Discogs' 5.76 million embedded ids, the same exact join works
   and the Music card scrape stops being needed at all. If it is small, it does
   not.
2. **Whether a local title-and-artist index is workable** for the room's few
   thousand tracks. It would replace the search request but not the Music card,
   so it turns three requests a track into one.
3. **Streaming cost.** The dumps are bzip2 tarballs of PostgreSQL `COPY` output.
   Node has no bzip2 in `zlib`, so this needs a dependency the room does not
   have, and the core dump is several times the size of the Discogs one.

Nothing here is guesswork about the numbers: they have not been looked at.

## Scripts

- `scripts/musicbrainz-genre-source.prototype.ts`, where MusicBrainz keeps genre
- `scripts/discogs-dump-coverage.prototype.ts`, the dump join and its ambiguity

Both are superseded by the code above and can go.
