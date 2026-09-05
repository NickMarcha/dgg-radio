# YouTube visible music metadata: feasibility and historical coverage

Research date: 2026-09-02

## Conclusion

YouTube still sends the structured data behind the visible **Music** section in a public watch-page response. It can identify a track much more often than title matching in the DGG Radio history, and it costs no YouTube Data API quota. It is not a stable or officially supported integration: YouTube's current terms prohibit automated scraping, and the response schema can change without notice.

The technical result is strong enough to keep as an admin-run experiment, but the policy risk makes it a poor production dependency. If that risk is accepted, use it only as cached enrichment, never as playback-critical data or DGG Radio's independent source of truth.

**Update, 2026-09-05.** The room's operator accepted that risk, and the shape it
took is recorded in "What shipped" below. Two things use this and they are not
the same thing: the room reads one watch page when it first stores a track, and
a one-time backfill read 25,220 of them on a workstation. The first is what this
note's guidance was written for. The second is not, and it is what taught us
what the limit actually is.

## Exact live result

I requested the public watch page for `MiQgZRLQpVs` with no cookies, login, API key, or YouTube Data API call. The `ytInitialData` document contained a `horizontalCardListRenderer` whose header was `Music`. Its single `videoAttributeViewModel` exposed:

- Song: `Eat It`
- Artist: `"Weird Al" Yankovic`
- Album: `In 3-D`
- Writer: `Michael Jackson`
- Artwork URL
- Linked YouTube recording ID: `ZcJjMnHoIBI`

The clean recording link is present on some cards but not all of them. It is a YouTube video ID, not a durable cross-service identifier like a MusicBrainz recording ID or ISRC.

The same section was also returned by YouTube's private `/youtubei/v1/next` endpoint after bootstrapping its client version, visitor data, and public internal key from the watch page. That response was smaller, but it is not a better foundation. It adds a second undocumented contract and still requires current watch-page configuration.

The official `player` response did not contain this clean attribution card. It only described the uploaded video. This is why another metered Data API lookup would not recover the same information.

## Historical sample

The prototype sampled 100 distinct YouTube IDs deterministically from the loaded QueUp export:

- Source history: 47,982 plays, 33,819 distinct YouTube IDs
- Sample seed: `dggradio-youtube-visible-music-v1`
- Requests: one public watch-page GET per sampled ID
- Pace: one request per second
- Authentication and cookies: none
- YouTube Data API calls: zero
- Parsing errors: zero

Results:

- 78 of 100 pages exposed at least one Music card
- 85 Music cards were recovered in total
- 85 of 85 had a title
- 83 of 85 had an artist
- 81 of 85 had an album
- 28 of 85 linked to a clean YouTube recording ID
- 51 of 85 exposed a credits dialog
- 1 page exposed multiple tracks

This is an observed 78% hit rate, not a promise for the full archive. The approximate 95% Wilson interval is 69% to 85%. The sample was over distinct videos rather than plays, so frequently replayed songs did not receive extra weight.

The multi-track result matters. `fhHWvpIugbk`, `Model/Actriz - Pirouette (Album Stream)`, exposed eight songs and eight corresponding recording links. The data model must preserve every card instead of forcing one video to equal one song.

Unmatched examples included live performances, mashups, soundfont versions, and obscure uploads. An absent panel should remain unknown. Guessing from the upload title would reintroduce the false matches this source is meant to avoid.

## What YouTube provides and what it does not

The current card can provide track title, display artist, album, artwork, a linked YouTube video ID, and arbitrary labeled credits. Seen credit labels included `Song`, `Artist`, `Album`, and `Writers`. Some official auto-generated descriptions expose more fields, such as label, release date, producer, composer, lyricist, and music publisher, but that is a separate text format and is not present consistently.

The Music section does not provide a specific musical genre. The ordinary YouTube category may say `Music`, which is not useful for genre statistics. A later MusicBrainz lookup becomes more promising after this step because clean title, artist, and album are better search inputs than an arbitrary upload title.

## Existing scraper implementations

### Brooktube

Brooktube is aimed at `music.youtube.com` browse, search, album, artist, playlist, and lyrics responses. Its README still lists the player parser as unfinished, and `GetSong` is empty. It also hardcodes a 2024 `WEB_REMIX` client version, visitor ID, and internal key. It is useful evidence of the private Innertube request shape, but it does not implement the visible watch-page Music card and should not be adopted for this job. See Brooktube's [README](https://github.com/ritesshg/brooktube/blob/ee8c8a769ad0a1b7914bbd91fcf297655d676eff/README.md), [empty song parser](https://github.com/ritesshg/brooktube/blob/ee8c8a769ad0a1b7914bbd91fcf297655d676eff/internal/parsers/song.go), and [hardcoded client constants](https://github.com/ritesshg/brooktube/blob/ee8c8a769ad0a1b7914bbd91fcf297655d676eff/internal/constants/constants.go).

### Invidious

Invidious has code for YouTube's older `videoDescriptionMusicSectionRenderer` and `carouselLockups` layout. The live test used the newer `horizontalCardListRenderer` and `videoAttributeViewModel` layout, so the inspected parser does not cover this page shape. See its current [video parser](https://github.com/iv-org/invidious/blob/b3a3f3a6df47d090c22c2f16bb8128688020538d/src/invidious/videos/parser.cr).

### YouTube.js

YouTube.js recognizes both the old music-section nodes and the newer [HorizontalCardList](https://github.com/LuanRT/YouTube.js/blob/a480854c501406cf55c9eb7ad5b540ab36a65b56/src/parser/classes/HorizontalCardList.ts) and [VideoAttributeView](https://github.com/LuanRT/YouTube.js/blob/a480854c501406cf55c9eb7ad5b540ab36a65b56/src/parser/classes/VideoAttributeView.ts) nodes. However, its `music_tracks` convenience getter still filters only the old `VideoDescriptionMusicSection`, and its new-card model does not retain the card's `onTap` recording link. See [VideoInfo.music_tracks](https://github.com/LuanRT/YouTube.js/blob/a480854c501406cf55c9eb7ad5b540ab36a65b56/src/parser/youtube/VideoInfo.ts).

### yt-dlp

yt-dlp retrieves the watch page and initial data, but its music-specific extraction currently relies on auto-generated description text and older metadata rows. It does not expose the new card as a complete track list. See its [YouTube video extractor](https://github.com/yt-dlp/yt-dlp/blob/bbc809a1161d3bfca51fa36f59dda35556ee85a0/yt_dlp/extractor/youtube/_video.py).

These are all unofficial integrations. Their partial coverage illustrates why the parser must be treated as replaceable enrichment code rather than a stable domain boundary.

## Policy and operational risk

The technical test does not establish permission. YouTube's general terms prohibit automated access such as scrapers except for public search engines following `robots.txt`, prior written permission, or access permitted by applicable law. Its API developer policies separately prohibit scraping YouTube applications and using undocumented APIs without express permission. See the official [YouTube Terms of Service](https://www.youtube.com/static?template=terms) and [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies).

This is not legal advice, but it rules out describing the approach as compliant merely because the page is public or the project is non-commercial. YouTube can also rate-limit, challenge, or block the server, and either of the two observed `ytInitialData` delivery forms can change.

## What shipped

**In the room, automatically, one page at a time.** `src/server/enrichment.ts`
runs when a track is first stored — queued in the room, or brought across by the
admin archive button. It reads that video's Music card, then asks MusicBrainz
and Discogs, and stores what they say. It is queued, bounded, and never on the
request path. This is the only place server code touches a watch page, and its
volume is one page per track the room has never seen — a rate no different from
a person opening the video.

**Once, on a workstation, in bulk.** `scripts/youtube-music-identities.ts` read
25,220 pages over about nine hours to backfill the archive, because the dumps
match on a name and half the uploads are not named `Artist - Title`. 20,093
carried a card (79.7%), and feeding those names to the two dump importers took
genre coverage from 42.4% to 63.4%. It writes a file; nothing about it runs in
production and the deployment never fetches a page.

### What the rate limit actually is

Measured the hard way, twice.

Eight requests at a time drew 429s on about 600 of 1,000 pages. One request a
second — which the hundred-page sample above had suggested was safe — then
looked like it failed at about 400 pages, and the conclusion drawn from that,
that the limit was on volume rather than rate, was wrong. What had actually
happened is that four copies of the script were running at once: each `[killed]`
notice had stopped the shell and left the process behind, and nothing checked.
Four copies do not share a rate limiter, so a script written for one request a
second was making four.

That earned a `google.com/sorry` challenge on the whole address — a block, not a
429, and not something to route around. It cleared by itself in minutes once the
processes stopped.

A single instance then read all 25,220 pages at one every two seconds with no
refusal of any kind. So the limit is on concurrency and rate, as it appeared to
be from the start. The script now writes a PID lock and refuses to start beside
a live copy of itself, because the instance that causes this is also the one
that cannot see it: each reads only its own log.

## If retained as an experiment

Keep the smallest possible boundary:

1. Fetch the public watch page for one track at a time, in response to
   something real — a track entering the room, or an admin asking. Never on a
   schedule, and never for a list of videos from inside the API.
2. Cache each raw response by full URL and request options. Never refetch a cached success during the same run.
3. Rate-limit globally, back off on failures, honour `Retry-After`, and stop on
   blocking or challenge pages. A bulk run must also refuse to start beside
   another copy of itself; see above for what that costs when it does not.
4. Parse both observed initial-data forms: the JavaScript assignment and the `script#yt-initial-data` JSON element.
5. Find Music lists by renderer type and semantic header, not by array position.
6. Store every card and every label/value credit, plus the raw source, checked time, parser version, and parse outcome.
7. Do not refresh automatically. Do not infer a match when the section is absent.
8. Keep normal YouTube playback validation separate. Scraping must never decide whether a room item is playable.

The disposable beta-data rule means no backfill or compatibility layer is needed yet. A future production design should first resolve the terms issue, then promote the parser behind a narrow enrichment interface.

## Reproduction

The throwaway sampler is [`scripts/youtube-music-metadata-coverage.prototype.ts`](../../scripts/youtube-music-metadata-coverage.prototype.ts). It writes response caches and its detailed result to the OS temporary directory, not the repository:

```text
npx tsx scripts/youtube-music-metadata-coverage.prototype.ts <queup-export.json> 100
```

Re-running the same command used all 100 cached responses and made zero network requests. The fixture-driven parser demonstration is [`src/server/youtube-music-metadata.prototype.html`](../../src/server/youtube-music-metadata.prototype.html).
