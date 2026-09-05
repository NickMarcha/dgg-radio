# Music identification alternatives for DGG Radio

Checked 2026-09-01 against official service documentation, source repositories, and DGG Radio's current player code.

## Answer

A Shazam-like match can identify the same released recording behind a lyric video, an official music video, and sometimes a SoundCloud upload. The hard part for DGG Radio is not the fingerprint algorithm. It is getting a lawful audio sample.

DGG Radio currently plays YouTube through the IFrame Player API and SoundCloud through the Widget API. Both APIs expose controls, timestamps, state, and metadata. Neither exposes decoded PCM samples to the parent page. YouTube also prohibits API clients from downloading, caching, or separating audiovisual content. SoundCloud's widget likewise provides no PCM method, while its API terms prohibit persistent storage of user content and stream-ripping. Building our own fingerprint worker would therefore require a new media acquisition path that the supported embedded players do not provide. [DGG Radio player](../../src/components/MediaPlayer.tsx), [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference), [YouTube developer policy](https://developers.google.com/youtube/terms/developer-policies), [SoundCloud Widget API](https://developers.soundcloud.com/docs/api/html5-widget), [SoundCloud API terms](https://developers.soundcloud.com/docs/api/terms-of-use)

The practical first test is a URL-based resolver, especially ACRCloud's Metadata API. It accepts a YouTube or SoundCloud URL and can return artist, track, album, genre, ISRC, release data, and links on other services without DGG Radio handling audio. If metadata resolution is too sparse, ACRCloud's file-scanning product is the closest documented Shazam-like option because it explicitly accepts YouTube page URLs itself. That second path still needs a terms review before production use.

## Shortlist

| Option | Input available to DGG Radio | Useful output | Cost and limit | Fit |
| --- | --- | --- | --- | --- |
| ACRCloud Metadata API | YouTube or SoundCloud URL | Artist, title, album, genre, ISRC, release data, platform links | Token required; pricing is behind its console | Best first coverage test, no audio handled by DGG Radio |
| ACRCloud file scanning | YouTube page URL, uploaded audio, fingerprint, or downloadable audio URL | ACRID, artist, title, genre, ISRC, UPC, optional MusicBrainz and platform IDs | 14-day trial; production pricing requires the console and third-party-ID add-on | Closest Shazam-like historical matcher; legal and price review needed |
| ListenBrainz metadata lookup | Clean artist and recording title | Recording MBID, artist MBIDs, release MBID; tags and genres in a second lookup | Token required; obey response rate-limit headers | Cheap external matcher, but YouTube uploader names are often not artists |
| Songlink/Odesli | YouTube or SoundCloud URL | Cross-platform links, title, artist, artwork, service entity IDs | Public `v1-alpha.1` API was scheduled to retire on 2026-07-31 | Do not adopt a retired API |
| YouTube `topicDetails` | Video ID through the Data API | Broad topics such as Pop, Rock, Hip hop, or Music | `videos.list` costs 1 quota unit; stored non-authorized data must be refreshed or deleted within 30 days | Useful only for coarse genre stats, not recording identity |
| AudD | Audio clip/file URL; enterprise endpoint also accepts a page containing audio or video | Artist, title, album, release date, service links, optional MusicBrainz metadata; ISRC/UPC on higher tiers | 300 requests free, then $5/1,000 pay-as-you-go with lower volume tiers | Worth a fallback trial if it accepts the actual video pages reliably |
| Chromaprint plus AcoustID | Decoded raw audio and whole-track duration | AcoustID and linked MusicBrainz recording metadata | Free for non-commercial use; registered client key; at most 3 requests/second | Good for owned audio files, poor fit for embedded YouTube and SoundCloud |
| ShazamKit | PCM captured in an Apple or Android app | Artist, title, genres, ISRC, Shazam ID, Apple Music and video URLs | Apple app capability; distribution membership is $99/year | Excellent recognition output, wrong runtime for a web server and historical URL batch |

## No-audio options

### ACRCloud Metadata API

This is the strongest match for the current constraints. Its `source_url` parameter accepts platform URLs, including YouTube examples, and the service says it can return metadata and links for Spotify, Apple Music, YouTube, Deezer, Tidal, SoundCloud, and other catalogs. The documented response includes track and artist names, genres, duration, release date, ISRC, album data, and provider links. An ISRC can then be resolved to a MusicBrainz recording, leaving MusicBrainz as the long-lived catalog rather than making DGG Radio maintain its own matching database. [ACRCloud Metadata API](https://docs.acrcloud.com/reference/metadata-api)

The unresolved questions are coverage, false matches, and price. ACRCloud does not publish this product's current price outside its signed-in console. We should not build around it until a deterministic history sample shows how it handles unofficial uploads, lyric videos, deleted videos, and SoundCloud links.

### Existing SoundCloud metadata

SoundCloud's official track object already has `genre`, `isrc`, `bpm`, `key_signature`, `release`, and `tag_list` fields. DGG Radio's current schema keeps only title, uploader, duration, artwork, and identifiers. For the small SoundCloud part of the archive, storing `genre` and a non-null ISRC would be cheaper and more reliable than fingerprinting. A valid ISRC provides a clean bridge into MusicBrainz. [SoundCloud OpenAPI track schema](https://github.com/soundcloud/api/blob/master/openapi/api.yaml)

The official API now requires an application credential and SoundCloud's setup guide says obtaining one requires Artist Pro. DGG Radio currently resolves public tracks through an undocumented web client route, so expanding that route is technically brittle. This should be evaluated as an official API integration, not by assuming every field from the website's private response is stable. [SoundCloud API guide](https://developers.soundcloud.com/docs)

### ListenBrainz metadata lookup

ListenBrainz exposes a metadata lookup that accepts artist name, recording name, and an optional release name, then returns the matched recording MBID, artist MBIDs, and release MBID. Its POST version accepts a batch. A follow-up metadata call can return MusicBrainz artist, release, tag, and genre data. The endpoint now requires a ListenBrainz user token and clients must follow the `X-RateLimit-*` response headers. [ListenBrainz metadata API](https://listenbrainz.readthedocs.io/en/latest/users/api/metadata.html), [ListenBrainz rate limiting](https://listenbrainz.readthedocs.io/en/latest/users/api/index.html#rate-limiting)

This does keep the matching decision outside DGG Radio, which addresses the upkeep concern. It is not magic, though. ListenBrainz's maintainer documentation says its mapper uses fuzzy Typesense lookups over artist and recording names, and match-quality work remains a TODO. YouTube titles often contain edit labels, featured artists, channel branding, and words such as "lyrics" or "official video". DGG Radio would still need to derive a credible artist and recording name before asking ListenBrainz, and a wrong high-confidence answer could become a wrong MBID without any score in the public lookup response. [ListenBrainz MBID mapper](https://listenbrainz.readthedocs.io/en/latest/maintainers/mapping.html)

It is worth sampling after URL resolvers, especially for videos whose title follows a clear `artist - track` pattern. It should not be the first universal matcher.

### Songlink/Odesli

Songlink's old public API accepted YouTube, SoundCloud, Spotify, Apple Music, and other service URLs and returned cross-platform links plus title, artist, artwork, and provider IDs. It would have fit the URL-resolution part of this problem, but the operator's current document marks the whole `v1-alpha.1` namespace deprecated and scheduled it to retire on 2026-07-31. It also did not document genre, ISRC, or MusicBrainz IDs. DGG Radio should not start a new dependency on it. [Current Songlink/Odesli API notice](https://linktree.notion.site/API-d0ebe08a5e304a55928405eb682f6741)

### YouTube topics

Adding `topicDetails` to the existing `videos.list` call can return high-level music topics including Pop, Rock, Electronic music, Hip hop music, Jazz, Reggae, and others. `topicCategories` contains Wikipedia URLs that describe the video's content. This is structured enough for broad genre charts, but it does not identify a song or connect two videos to one recording. [YouTube video topic fields](https://developers.google.com/youtube/v3/docs/videos#topicDetails)

It also conflicts with the desired admin-only refresh model. YouTube requires non-authorized API data to be refreshed or deleted after 30 days. It is fine for a temporary coverage experiment or a refreshed cache, but not as permanent enrichment that is never revisited. `videos.list` itself costs one quota unit per call and can request `topicDetails` alongside the parts already used. [YouTube `videos.list`](https://developers.google.com/youtube/v3/docs/videos/list), [YouTube storage policy](https://developers.google.com/youtube/terms/developer-policies#e.-handling-youtube-data-and-content)

## Audio recognition options

### ACRCloud

ACRCloud's file-scanning API accepts a YouTube platform URL directly. A scan can use exact audio fingerprinting, cover-song recognition, or both. The exact engine is the right default for combining an official audio upload, lyric video, and music video only when they use the same master recording. The cover-song engine answers a different question and may group live performances or covers with the composition, which should not silently collapse distinct recordings. [ACRCloud file scanning](https://docs.acrcloud.com/reference/console-api/file-scanning/file-scanning), [ACRCloud recognition tutorial](https://docs.acrcloud.com/tutorials/recognize-music)

Recognition results can include ACRCloud's track ID, title, artists, album, genres, label, release date, ISRC, UPC, and optional external IDs for Spotify, Deezer, YouTube, and MusicBrainz. Only the basic identity fields are guaranteed, so coverage of genres and external IDs must be measured. The external metadata add-on is separately priced. [ACRCloud music response fields](https://docs.acrcloud.com/reference/console-api/file-scanning/metadata/music)

ACRCloud offers a 14-day trial with no card. Its current production price is only visible after login. Its terms also make the customer responsible for the legality and appropriateness of media supplied to the service. The fact that ACRCloud accepts a YouTube URL proves technical support, not that YouTube grants DGG Radio permission to have a third party extract and fingerprint it. Production use needs written confirmation from the vendor and a policy review. [ACRCloud trial](https://www.acrcloud.com/music-recognition/), [ACRCloud terms](https://www.acrcloud.com/terms/)

### AudD

AudD recognizes 12-second clips and returns artist, title, album, release date, label, a song link, and optional Apple Music, Spotify, Deezer, and MusicBrainz blocks. Its enterprise endpoint accepts an audio/video file URL or a web page containing audio or video, can skip an intro, and counts one request per 12 seconds scanned. ISRC and UPC require a higher service tier. [AudD enterprise endpoint](https://docs.audd.io/enterprise/), [AudD response and provider metadata](https://docs.audd.io/sdks/node/)

Public pricing is 300 free requests and then $5 per 1,000 pay-as-you-go, with lower rates at volume. At one clip for each of roughly 34,000 distinct historical YouTube videos, the floor is about $170 before retries, second sample points, or higher-tier metadata. A 12-second sample near the start will miss videos with long intros, while extra sample points raise both coverage and cost. [AudD pricing](https://audd.io/)

AudD is a reasonable fallback trial because its free allowance is enough for a 200-item sample. ACRCloud is ahead of it for this project because ACRCloud explicitly documents prerecorded YouTube URLs and exposes richer identity fields in one response.

### Chromaprint and AcoustID

Chromaprint is not an open-source Shazam replacement. Its own README says it is designed for near-identical audio, trades robustness for search speed, and targets complete audio files, duplicate detection, and long-stream monitoring. AcoustID says it cannot identify short phone-recorded snippets and is designed for full audio files. [Chromaprint README](https://github.com/acoustid/chromaprint), [AcoustID FAQ](https://acoustid.org/faq)

The library needs decoded 16-bit signed PCM, not a YouTube ID or iframe. The usual flow is to decode a compressed audio file, generate a fingerprint, then submit fingerprint plus whole-file duration to AcoustID. [Chromaprint input API](https://github.com/acoustid/chromaprint/blob/master/src/chromaprint.h), [AcoustID web service](https://acoustid.org/webservice)

AcoustID is free for non-commercial use after registering an application key and permits at most three requests per second. Results link to MusicBrainz metadata. The fingerprint database is CC BY-SA 3.0, while the MusicBrainz-to-AcoustID mapping is public domain. This is attractive for audio that DGG Radio owns or is licensed to process. It does not solve the current YouTube and SoundCloud input problem. [AcoustID service terms and rate limit](https://acoustid.org/webservice), [AcoustID database license](https://acoustid.org/database)

### ShazamKit

ShazamKit has excellent result fields for this use case. A matched item may contain artist, title, genres, ISRC, Shazam ID, Apple Music ID and URL, artwork, and a music-video URL. It can recognize a few seconds of PCM against the Shazam catalog. [ShazamKit](https://developer.apple.com/shazamkit/), [Shazam media item fields](https://developer.apple.com/documentation/shazamkit/shmediaitem)

It is delivered as a framework for Apple platforms and an Android SDK. Using the Shazam catalog requires an Apple media identifier, signed developer token, and an enabled ShazamKit app service. Apple publishes no general browser or Linux server URL-recognition endpoint. A distributed app also needs the Apple Developer Program, currently $99 per year. [ShazamKit Android setup](https://developer.apple.com/shazamkit/android/index.html), [enable ShazamKit](https://developer.apple.com/help/account/services/shazamkit), [Apple membership](https://developer.apple.com/support/compare-memberships/)

That makes it a good mobile "what is playing near me?" feature and a bad historical backfill service for DGG Radio. Capturing a user's microphone while the embedded player runs would add consent, noise, and foreground-device requirements, and it still would not process the existing archive.

## Recommended evaluation

1. Test ACRCloud's Metadata API first on the same deterministic YouTube sample used for the MusicBrainz URL test, plus every historical SoundCloud permalink that can be recovered. Measure URL acceptance, exact artist/title coverage, ISRC coverage, genre coverage, cross-platform link coverage, and agreement between entries that humans can see are the same recording.
2. In parallel, test ListenBrainz on the subset with clean `artist - track` titles. Keep the unmodified input and returned MBID so errors are attributable to the external matcher. Do not add manual production mappings.
3. Only if the no-audio resolvers are too sparse, use the free ACRCloud or AudD allowance on 200 of the same YouTube videos. Confirm in writing that prerecorded YouTube URL recognition is an approved use. Use exact recording recognition, not cover-song grouping, for the first test.
4. Keep MusicBrainz as the preferred durable identity whenever a service returns an MBID or ISRC. Otherwise store the vendor ID, match method, original provider URL, response timestamp, and raw response. A manual admin refresh can repeat the external lookup without DGG Radio maintaining a catalog of hand-authored links.

The recommendation is to evaluate vendor URL resolution now and leave self-hosted fingerprinting out of the product. If ACRCloud's URL scan proves both accurate and permitted, it gives DGG Radio the Shazam-like benefit without building a fingerprint database or extracting audio itself.
