# Testing YouTube Music cards as MusicBrainz lookup inputs

Checked 2026-09-02 against the public MusicBrainz API and official MusicBrainz documentation.

## Answer

The scraped title and artist improve MusicBrainz candidate retrieval substantially. The first test was too strict for DGG Radio's intended song-level grouping because it treated suffixes such as `Remastered 2001` as part of the identity. A user-provided MusicBrainz release exposed the error: MusicBrainz had `Be True to Your School` by The Beach Boys, while the YouTube card said `Be True To Your School (Remastered 2001)`.

After removing only recognized presentation and version qualifiers before searching, the full 85-card comparison raised top-result song-and-artist agreement from 45.88% with the upload title to 86.75% with the Music card. On the fairer 77-video single-card cohort, it rose from 49.35% to 85.33%, with 26 paired gains and no paired losses.

Album should augment the result rather than constrain the first query. Making album mandatory reduced top-result field agreement to 61.25% because YouTube edition names and MusicBrainz release associations often differ.

This is evidence that the scraped fields retrieve better candidates. It is not proof that the top candidate is the exact audio recording in the video. Only seven cards had an independent MusicBrainz recording relationship to either YouTube URL. The clean title-and-artist query selected that exact MBID first for two of seven, compared with three of seven for the raw title. A manually reviewed acceptable-MBID set is still needed before any automatic cross-video merge.

## What MusicBrainz lets us search

Use recording search:

```text
GET https://musicbrainz.org/ws/2/recording?query=<Lucene query>&fmt=json&limit=10
```

The useful recording fields are:

- `recording`: recording title or a connected track title
- `artist`: the combined credited artist string, including join phrases such as `feat.`
- `artistname`: the name of any individual recording artist
- `creditname`: the name under which an artist is credited on that recording
- `release`: the title of any release containing the recording
- `dur` and `qdur`: duration in milliseconds and duration quantized into two-second units
- `video`: whether the result represents a video recording

The API also supports ISRC, release IDs, release-group IDs, tags, dates, and release types. There is no recording-search field for a writer. [Official recording search fields](https://musicbrainz.org/doc/MusicBrainz_API/Search#Recording)

MusicBrainz searches use Lucene. Quotes make a phrase, Boolean operators must be explicit, and Lucene special characters need escaping before URL encoding. A phrase such as `recording:"Have Faith" AND artistname:"Palace"` is much less ambiguous than sending the whole upload title to the recording field. [Official indexed-search syntax](https://musicbrainz.org/doc/Indexed_Search_Syntax), [official API search parameters](https://musicbrainz.org/doc/MusicBrainz_API/Search)

Artist handling needs care. MusicBrainz artist credits preserve the credited spelling and the join phrase between artists. The response may therefore distinguish `Usher feat. Pitbull`, `Usher featuring Pitbull`, and the canonical names for the same two artists. Reconstruct the full credit from every `artist-credit` element. Do not keep only the first artist. [MusicBrainz artist-credit model](https://musicbrainz.org/doc/Artist_Credits)

## What the current API did

These requests were sent with a meaningful `User-Agent`, at no more than one request per second, and cached in the OS temporary directory. This is a behavior check, not a coverage estimate.

- `Palace - Have Faith` as one quoted recording title returned no results. `Have Faith` plus artist `Palace` and release `So Long Forever` returned one result with score 100. [Raw-title request](https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=recording%3A%22Palace%20-%20Have%20Faith%22), [Music-card request](https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=recording%3A%22Have%20Faith%22%20AND%20artistname%3A%22Palace%22%20AND%20release%3A%22So%20Long%20Forever%22)
- `Corporeal` alone returned 139 recordings. Each of the first five had score 100, despite having different artists. Adding artist `Broadcast` and release `Tender Buttons` returned one result. This proves that a MusicBrainz score of 100 is not a probability that the recording is the right one. It only reports search relevance. [Title-only request](https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=recording%3A%22Corporeal%22), [structured request](https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=recording%3A%22Corporeal%22%20AND%20artistname%3A%22Broadcast%22%20AND%20release%3A%22Tender%20Buttons%22)
- `Zammuto - It Can Feel So Good` returned no results as a recording phrase. The Music card's `My Dog's Eyes`, `Zammuto`, and `Veryone` returned one result. This is the sort of upload where the card can recover an identity that the visible title cannot. [Raw-title request](https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=recording%3A%22Zammuto%20-%20It%20Can%20Feel%20So%20Good%22), [Music-card request](https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=recording%3A%22My%20Dog%27s%20Eyes%22%20AND%20artistname%3A%22Zammuto%22%20AND%20release%3A%22Veryone%22)
- Exact metadata can also be too strict. YouTube supplied `DJ Got Us Fallin' In Love (No Pitbull Version)`, `Usher`, and `Raymond v Raymond (Expanded Edition)`. That full query returned no results. Removing the version suffix returned 54 candidates; adding the base album title narrowed them to two. Search should have strict and relaxed stages, followed by local validation. [Relaxed title and artist request](https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=recording%3A%22DJ%20Got%20Us%20Fallin%27%20In%20Love%22%20AND%20artistname%3A%22Usher%22), [request with album](https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=recording%3A%22DJ%20Got%20Us%20Fallin%27%20In%20Love%22%20AND%20artistname%3A%22Usher%22%20AND%20release%3A%22Raymond%20v%20Raymond%22)
- One historical card supplied `Humana`, `Sevdaliza`, and `Ison`. MusicBrainz has `Humana` by Sevdaliza, but associates it with the release `Humana`, so the full three-field query returned no result. The upload-title interpretation, `Human` by Sevdaliza, returned `Human` on `ISON` as its first result. This conflict needs human or audio-level adjudication. It should not be hidden by fuzzy matching. [Music-card title and artist request](https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=recording%3A%22Humana%22%20AND%20artistname%3A%22Sevdaliza%22), [upload-title interpretation](https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=recording%3A%22Human%22%20AND%20artistname%3A%22Sevdaliza%22)

The API documentation says search is Lucene-backed but does not define its `score` as a calibrated confidence value. The `Corporeal` response shows why DGG Radio must not auto-accept a candidate based on that number alone. [MusicBrainz search documentation](https://musicbrainz.org/doc/MusicBrainz_API/Search)

## Full historical comparison

The quantitative test reused the deterministic 100-video YouTube sample. Seventy-eight source videos exposed Music cards. Those pages contained 85 cards because one album stream exposed eight tracks. All final MusicBrainz responses came from a cache-complete run with zero query errors.

Four strategies were compared:

1. Raw upload title as an unfielded recording search with `dismax=true`.
2. Exact-phrase recording title and artist from the YouTube Music card.
3. Song-level title and artist after removing recognized labels such as remaster years, official-video text, featured-artist suffixes, and soundtrack wrappers.
4. The strict clean query with album required as a MusicBrainz `release` field.

Across all cards, the raw upload title returned a song-and-artist-compatible top candidate for 39 of 85 cards, or 45.88%. Relaxed Music-card title and artist did so for 72 of 83 searchable cards, or 86.75%. Two cards lacked an artist. On the 83 paired cards, the Music-card query improved 33 top results and regressed none by this measure.

The multi-track album stream accounts for seven of those gains, so the single-card cohort is the more conservative result. Among 77 single-card videos, raw upload titles achieved 38 compatible top results, or 49.35%. Relaxed Music-card title and artist achieved 64 from 75, or 85.33%. There were 26 paired gains and no paired regressions. Across the original 100 sampled source videos, the number with at least one provider-aligned top MusicBrainz candidate rose from 39 to 65.

Requiring album made retrieval worse. It returned any candidate for 52 of 80 cards and a title-and-artist-compatible top candidate for 49, or 61.25%. Compared directly with clean title and artist, it caused 15 regressions and no improvements by the field-agreement measure. Album still helped choose the exact URL-linked MBID in two of the seven independent-reference cases, so it remains useful for reranking and validation.

The linked recording URL from the YouTube card did not solve MusicBrainz identity lookup by itself. Twenty-eight cards included such a YouTube ID, but MusicBrainz had a recording relation for only one of those linked URLs. Six more independent references came from the original source-video URLs.

Several paired improvements were clear failures of the ambiguous upload-title query:

- `Julie And Candy` changed from Loli Battle Machine to Boards of Canada.
- `Automatic Stop` changed from Andre Demay to The Strokes.
- `Von dutch` changed from Cleotrapa to Charli xcx.
- `Dunkelheit` changed from `Burzum (Dunkelheit)` by Ash to `Dunkelheit` by Burzum.
- The `Pirouette` album stream changed from one upload-level result to eight individually identified tracks.

The strict query returned no candidate for 18 cards. The corrected song-level query reduced that to 10. An absent result still does not prove that MusicBrainz lacks the song because localization, artist-credit formatting, and catalog spelling can differ.

The reproducible comparison is [`scripts/musicbrainz-youtube-enrichment-comparison.prototype.ts`](../../scripts/musicbrainz-youtube-enrichment-comparison.prototype.ts). It caches every MusicBrainz response in the OS temporary directory and writes the detailed per-card result to `dggradio-musicbrainz-youtube-enrichment-comparison.json` there.

## A manually reviewed accuracy experiment

The automated comparison above establishes retrieval improvement. Measuring exact-recording accuracy still requires human labels. Use the same deterministic historical sample and compare strategies only on videos with exactly one Music card. Treat videos with multiple cards as tracklists and report them separately.

For each eligible video, run these candidate generators against one cached MusicBrainz snapshot:

1. Raw baseline: the unmodified QueUp or YouTube upload title.
2. Parsed-title baseline: the project's best deterministic cleanup of the upload title, with no Music-card data.
3. Music title and artist: quoted recording title plus artist evidence.
4. Music title, artist, and album: the same query with release evidence.
5. Combined fallback: the union of candidates from the parsed baseline and Music-card queries.

The combined fallback is the likely production winner. The separate strategies are still needed to prove where the gain comes from and how often the card makes a good title-based result worse.

Build a gold set before tuning any acceptance thresholds. A reviewer should inspect the video, the Music card, and the MusicBrainz candidate pages, then record every acceptable recording MBID or mark the item `unknown`. Some items can have more than one defensible MBID because the database may contain duplicate entries or distinct edits, mixes, and live recordings with similar names. MusicBrainz defines a recording as distinct audio, while a track is that recording's appearance on a particular release. A title, artist, and album match alone cannot prove that two videos contain the same recording. [MusicBrainz recording semantics](https://musicbrainz.org/doc/Recording), [MusicBrainz track semantics](https://musicbrainz.org/doc/Track)

Report these measurements:

- top-1 accuracy against the acceptable MBID set
- recall at 5 and 10 candidates
- mean reciprocal rank for items with a known acceptable MBID
- auto-accept precision and coverage at each proposed local threshold
- abstention rate, no-result rate, and conflicting-field rate
- paired gain and loss counts, meaning baseline wrong and enriched right versus baseline right and enriched wrong
- end-to-end coverage, which multiplies Music-card availability by matching coverage rather than reporting matching coverage only among cards

The paired gain and loss counts answer the actual question. A higher average MusicBrainz search score does not.

## Candidate validation

Normalize case, Unicode, whitespace, and punctuation for comparison, but preserve identity-bearing qualifiers such as `live`, `remix`, `instrumental`, `karaoke`, and mix names. Removing those qualifiers can merge distinct recordings.

Validate the returned candidates locally:

- Require strong title agreement.
- Compare the complete credited artist string and the set of credited artists. Allow credited-name and join-phrase differences.
- Treat album agreement as strong supporting evidence, not a mandatory condition. A recording can appear on many releases, and YouTube may name an edition that MusicBrainz spells differently.
- Treat duration as supporting evidence. A music video's duration may include intros or outros, while MusicBrainz defines recording length from the median of linked track lengths. [MusicBrainz recording length](https://musicbrainz.org/doc/Recording#Length)
- Keep the `video` flag. MusicBrainz may model a music video as a video recording separate from the audio recording. Follow a `music video` recording relationship when present instead of silently grouping the video MBID with the audio MBID. [MusicBrainz music-video relationship](https://musicbrainz.org/relationship/ce3de655-7451-44d1-9224-87eb948c205d)
- Use YouTube writer credits only as a later validation signal. Recording search cannot query writers. A candidate lookup can load its work relationship and the related work's artist relationships with `work-rels`, `work-level-rels`, and `artist-rels`, but that costs more requests and still needs name normalization. [MusicBrainz relationship includes](https://musicbrainz.org/doc/MusicBrainz_API#Relationships)

After choosing an MBID, a recording lookup can fetch artist credits, ISRCs, releases, release groups, genres, and relationships. Lookup includes return at most 25 linked entities, so complete release validation may require a paged release browse by recording MBID. [MusicBrainz lookup and browse API](https://musicbrainz.org/doc/MusicBrainz_API#Lookups)

## Operational rules for the test

Send a meaningful application `User-Agent`, serialize all MusicBrainz traffic through one queue, stay at or below one request per second for the source IP, cache each response by its full URL and request options, and back off on HTTP 503. [MusicBrainz rate-limit rules](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)

Freeze the query construction and the gold labels before evaluating the full sample. Otherwise it is too easy to tune examples until the result looks better than it is.
