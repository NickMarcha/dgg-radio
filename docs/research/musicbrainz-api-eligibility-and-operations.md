# MusicBrainz API eligibility and operations for DGG Radio

Checked 2026-09-01 against official MusicBrainz and MetaBrainz documentation.

## Decision

DGG Radio can use the public MusicBrainz web service for free while the project remains personal and non-commercial. The API FAQ says non-commercial use is free. It currently requires neither an API key nor registration, but every request must identify the application with a meaningful `User-Agent`. Authentication is only needed for submissions and requests involving MusicBrainz user information, neither of which is part of metadata enrichment. [MusicBrainz API FAQ and authentication](https://musicbrainz.org/doc/MusicBrainz_API)

Use this header, updating the version with the application version:

```http
User-Agent: DggRadio/0.1.0 (https://github.com/NickMarcha/dgg-radio)
```

MusicBrainz asks for the application name, version, and either a contact URL or contact email so maintainers can reach the operator. A generic runtime header such as `node`, a blank value, or a library's name is not enough. [MusicBrainz User-Agent guidance](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting#Provide_meaningful_User-Agent_strings)

The commercial boundary needs another look if DGG Radio starts making money or becomes part of a revenue-producing service. The API FAQ directs commercial users to MetaBrainz's plans or contact address. MetaBrainz classifies personal use as non-commercial and asks companies with current or expected revenue to use a commercial tier. Its broader data-access page also routes open-source developers and non-profits through a free non-profit tier for datasets and the Live Data Feed. That account flow is not required for ordinary unauthenticated API reads, but it shows that "we charge users nothing" is not the only commercial test. [MusicBrainz API FAQ](https://musicbrainz.org/doc/MusicBrainz_API/FAQ), [MetaBrainz account types](https://metabrainz.org/supporters/account-type)

## Rate limit and failure behavior

The application must never make more than one API call per second. MusicBrainz currently measures the source IP's request rate as an average and allows one request per second unless another arrangement has been made. If that rate is too high, it rejects all requests from the IP with HTTP 503 until the rate falls again. Requests also pass application `User-Agent` and global-capacity checks, and MusicBrainz reserves the right to change the rules to protect the service. [MusicBrainz API overview](https://musicbrainz.org/doc/MusicBrainz_API#Application_rate_limiting_and_identification), [rate-limit mechanics](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting#How_throttling_works)

The implementation should therefore use one server-side MusicBrainz queue shared by every worker and feature behind the same outbound IP:

- Start at most one request per second. A small safety margin, such as 1.1 seconds between starts, avoids timing jitter around the documented average.
- Treat 503 as temporary. Retry with exponential backoff and jitter while still passing through the same one-request-per-second queue.
- Deduplicate YouTube video IDs before enqueueing work and cache both matches and misses.
- Do not create synchronized hourly or nightly request waves. MusicBrainz asks background clients to spread work across random intervals.
- Do not poll the whole cache looking for metadata changes. MusicBrainz explicitly asks clients not to poll because the metadata changes infrequently. Refresh an entry because it is being used, an operator requested it, or its match needs review.

The scheduling and polling rules come from MusicBrainz's own good-citizen guidance. The 1.1-second margin, retry algorithm, and refresh triggers are DGG Radio implementation recommendations, not extra MusicBrainz rules. [MusicBrainz scheduling and polling guidance](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting#How_can_I_be_a_good_citizen_and_be_smart_about_using_the_Web_Service.3F)

## Lookup and batching plan

The exact URL endpoint is the cheapest first pass for YouTube videos already linked by MusicBrainz editors:

```text
GET https://musicbrainz.org/ws/2/url
  ?resource=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D...
  &resource=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D...
  &inc=recording-rels
  &fmt=json
```

One request may contain up to 100 repeated `resource` parameters. A batch response returns a URL list and silently omits resources that MusicBrainz does not have. A single-resource miss returns 404. Each source URL must be URL-escaped as a query value, and a URL containing its own escaped parameters may need double escaping. Relationship includes such as `recording-rels` return entities linked to the URL. [URL-by-text lookup](https://musicbrainz.org/doc/MusicBrainz_API#url_.28by_text.29), [relationship includes](https://musicbrainz.org/doc/MusicBrainz_API#Relationships)

An exact URL hit can identify a MusicBrainz recording, but it is not guaranteed to be the canonical audio recording DGG Radio wants. MusicBrainz can model a video as its own recording and link it to the corresponding audio recording with a `music video` recording-to-recording relationship. The match pipeline should preserve that distinction and follow the relationship when present. [MusicBrainz music-video relationship](https://musicbrainz.org/relationship/ce3de655-7451-44d1-9224-87eb948c205d)

For URLs with no exact relationship, use recording search with the parsed title, artist or channel, and YouTube duration. MusicBrainz exposes recording search fields for recording name, credited artist, duration in milliseconds, quantized duration, release dates, ISRC, and tags. A search request accepts one Lucene query and returns 25 results by default or at most 100 with `limit=100`; it is not a batch endpoint for 100 independent song queries. Each unmatched video's fallback search therefore costs its own rate-limited request. [MusicBrainz search parameters](https://musicbrainz.org/doc/MusicBrainz_API/Search), [recording search fields](https://musicbrainz.org/doc/MusicBrainz_API/Search#Recording)

Search scores should select candidates for DGG Radio's own title, artist, and duration checks. They should not silently turn the top result into a confirmed identity. Store the match method and confidence separately from the MusicBrainz facts. [MusicBrainz search response examples](https://musicbrainz.org/doc/MusicBrainz_API/Search#Recording)

## Storage, caching, and licenses

MusicBrainz does not publish a YouTube-style 30-day refresh-or-delete rule in its API, rate-limit, or data-license documentation. Long-lived caching is compatible with the published data licenses. Record `fetchedAt`, the request URL or lookup inputs, the returned MBIDs, and the matching decision so stale or disputed matches can be refreshed deliberately. The rate-limit page's request not to poll supports a cache-first design. [MusicBrainz rate-limit guidance](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting), [MusicBrainz data license](https://musicbrainz.org/doc/About/Data_License)

The license depends on the field, not merely on the fact that it came from `/ws/2`:

- Core catalog data is CC0. It includes artist, recording, release, release-group and work identities and names, recording duration and ISRCs, release dates and labels, MBIDs, relationships, and URLs. It can be stored and used without an attribution requirement. [MusicBrainz core-data list](https://musicbrainz.org/doc/MusicBrainz_Database#Data_overview), [MusicBrainz data license](https://musicbrainz.org/doc/About/Data_License)
- Genre names themselves are core data, but community assignments of genres to a recording, release, artist, or other entity are user-submitted tags and therefore supplementary data. Other tags, annotations, ratings, derived statistics, and search indexes are supplementary too. [MusicBrainz core and supplementary classification](https://musicbrainz.org/doc/MusicBrainz_Database#Data_overview), [MusicBrainz database downloads](https://musicbrainz.org/doc/MusicBrainz_Database/Download)
- Supplementary data is CC BY-NC-SA 3.0. MusicBrainz requires credit for non-commercial use and requires derivative works based on that data to use the same license. [MusicBrainz data license](https://musicbrainz.org/doc/About/Data_License)

For DGG Radio, keep source and license provenance alongside stored MusicBrainz data. A raw lookup response that includes `genres`, `tags`, ratings, annotations, or search-derived fields should be treated as containing supplementary data. Add a visible "Metadata from MusicBrainz" link anywhere those fields drive public stats. If DGG Radio exports a dataset containing genre associations or other supplementary data, include the MusicBrainz attribution and CC BY-NC-SA 3.0 notice and keep that exported derivative under the same license. Keeping MusicBrainz-derived fields separable avoids making later licensing questions harder than they need to be.

## Recommended first version

1. Use read-only, unauthenticated `/ws/2` calls with the DGG Radio `User-Agent`.
2. Put all calls through one durable queue capped below one request per second across the deployment.
3. Batch canonical YouTube watch URLs into groups of at most 100 and request `recording-rels`.
4. Cache exact matches and misses. Do not add a periodic full-cache refresh.
5. Run title, artist, and duration search only for unmatched videos and save it as a proposed match until confidence checks pass.
6. Store core identifiers and facts separately from supplementary genres, tags, and search metadata.
7. Credit MusicBrainz in public genre and tag statistics, and reassess MetaBrainz terms before adding revenue, advertising, sponsorship, or a commercial operator.

This design uses no API key and no MusicBrainz account. It stays within the free non-commercial public API as DGG Radio is currently described, while leaving a clear operational and licensing boundary if the project changes later.
