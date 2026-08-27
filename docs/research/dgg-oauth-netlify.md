# DGG Radio integration research

Checked 2026-08-27 against first-party Destiny.gg, YouTube, Astro, and Netlify sources.

## Decisions this research supports

- Use Destiny.gg's custom authorization-code flow, but run every secret-bearing step on the TypeScript backend. It is "OAuth style," not a standard OpenID Connect provider.
- Key local users by Destiny.gg `userId`. Refresh username, roles, and features when they sign in.
- Treat `ADMIN` and `MODERATOR` as separate DGG claims. The product still needs to decide whether both get room controls or only `ADMIN` does.
- Team is probably available through the `features` array. The production flair catalog currently maps `flair35` to Team PEPE and `flair36` to Team YEE.
- Check YouTube links with `videos.list` before queue insertion. Inspect UAE availability for country code `AE`, general embeddability, age restriction, processing state, privacy, live status, and the seven-minute duration limit.
- Deploy the static Astro frontend to Netlify. Put the authoritative room, OAuth callback, sessions, REST API, WebSocket connections, and playback clock on one always-on TypeScript service with Postgres. Netlify is not the right place for that persistent server.

## Source age and confidence

Destiny.gg's [published OAuth guide](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/OAUTH.md#L1-L159) calls itself incomplete. The [repository is archived](https://github.com/destinygg/website), and its last source commit is `4f4077671080bb9449435a8bb29f4379eb19a605` from 2021-10-23. The unauthenticated production endpoints still answered in a way consistent with the old implementation on 2026-08-27:

- [`/oauth/token`](https://www.destiny.gg/oauth/token) returned a JSON `invalid_grant` error for a request missing `grant_type`.
- [`/api/userinfo`](https://www.destiny.gg/api/userinfo) returned a JSON bad-request error for a request missing `token`.
- [`/.well-known/openid-configuration`](https://www.destiny.gg/.well-known/openid-configuration) returned the site's Page Not Found response. There is no discovered OpenID Connect metadata.
- [`/profile/developer`](https://www.destiny.gg/profile/developer) remains login-protected.

This is enough to design the integration, but not enough to prove a successful production exchange. Register a development client and complete one end-to-end login before building the rest of authentication. Capture the real token and user-info responses with secrets redacted.

## Destiny.gg authorization flow

### Register the client

Sign in to [`https://www.destiny.gg/profile/developer`](https://www.destiny.gg/profile/developer), create an application, and generate its client secret. The old UI allowed one application per DGG account. The source shows a 32-character URL-safe client ID, a separate secret-generation action, and one registered redirect URL. See the [developer page](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/views/profile/developer.php#L19-L76) and [client management code](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Controllers/ProfileController.php#L230-L331).

Register a dedicated HTTPS callback with no query string, for example `https://api.example.com/auth/dgg/callback`. Always send that exact constant. The archived implementation only checks whether the requested redirect starts with the registered string, then later appends `?code=...&state=...`. Do not copy that loose matching into this app and do not use `redirect_uri` to carry a post-login destination. Store any destination in the app's own state instead. See the [authorize validation](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Controllers/OAuthController.php#L32-L69) and [callback construction](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Common/Authentication/AuthenticationRedirectionFilter.php#L153-L169).

### Start authorization

Generate these values on the backend:

- `state`: cryptographically random alphanumeric text, at most 64 characters. A 32-byte random value encoded as 64 lowercase hex characters fits the documented rule.
- `code_verifier`: a cryptographically random URL-safe string with at least 43 characters.
- `code_challenge`: Destiny.gg's custom secret-bound challenge.

The guide describes the challenge as:

```text
secret_hash = SHA256(client_secret)
code_challenge = Base64(SHA256(code_verifier + secret_hash))
```

The PHP implementation makes the encoding details clearer. Both SHA-256 calls return lowercase hexadecimal strings, and the outer Base64 operation encodes the ASCII hexadecimal digest. It is standard Base64, not Base64url. In Node terms:

```ts
const secretHash = createHash("sha256")
  .update(clientSecret, "utf8")
  .digest("hex");

const challengeDigestHex = createHash("sha256")
  .update(codeVerifier + secretHash, "utf8")
  .digest("hex");

const codeChallenge = Buffer.from(challengeDigestHex, "utf8").toString("base64");
```

This follows the [guide's challenge recipe](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/OAUTH.md#L53-L58), the [stored secret hashing](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Controllers/ProfileController.php#L230-L250), and the [token verifier comparison](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Controllers/OAuthController.php#L113-L129). A normal OAuth PKCE helper will produce a different challenge and should not be used for this calculation.

Save `state`, `code_verifier`, and an expiry in a server-side, single-use login transaction. Then redirect the browser to:

```text
GET https://www.destiny.gg/oauth/authorize
  ?response_type=code
  &client_id=...
  &redirect_uri=...
  &state=...
  &code_challenge=...
  &code_challenge_method=S256
```

URL-encode every value. The provider accepts only `response_type=code` and `code_challenge_method=S256`. The old server retained authorization state and codes for five minutes and rejected recently reused challenges for 30 seconds. See the [authorize route](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Controllers/OAuthController.php#L27-L74) and [temporary OAuth storage](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Common/Authentication/DggOAuthService.php#L27-L56).

### Handle the callback and exchange the code

Destiny.gg redirects to the registered callback with `code` and `state` query parameters. Reject missing values, expired login transactions, and any state mismatch. Consume the login transaction once.

The published protocol then uses:

```text
GET https://www.destiny.gg/oauth/token
  ?grant_type=authorization_code
  &code=...
  &client_id=...
  &redirect_uri=...
  &code_verifier=...
```

The token response is documented as:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": 3600,
  "scope": "identify",
  "token_type": "bearer"
}
```

There is no `client_secret` parameter in the exchange. Knowledge of the client secret is already required to produce the challenge. The provider marks successful token responses `Cache-Control: no-store`. See the [documented exchange](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/OAUTH.md#L60-L118) and [token implementation](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Controllers/OAuthController.php#L76-L150).

The endpoint is documented as GET, which puts the code and verifier in a URL. Make this call only from the backend. Redact the full URL and query parameters from application, proxy, and error logs.

### Fetch identity

The guide and source use a query parameter rather than an `Authorization` header:

```text
GET https://www.destiny.gg/api/userinfo?token=ACCESS_TOKEN
```

Again, call it from the backend and redact the URL. The archived JSON serializer returns:

```ts
type DggUserInfo = {
  nick: string;
  username: string;
  userId: number;
  status: string;
  createdDate: string;
  roles: string[];
  features: string[];
  subscription: null | {
    tier: number;
    source: string;
    type: string | null;
    start: string | null;
    end: string | null;
  };
};
```

The exact serialized fields come from [`SessionCredentials::jsonSerialize`](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Common/Session/SessionCredentials.php#L68-L91). The endpoint rejects invalid and expired tokens in the [user-info controller](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Controllers/ApiController.php#L25-L64).

Do not expect email, country, profile-provider identity, or a JWT. Validate this response at runtime. Also inspect the JSON `error` field instead of relying only on HTTP status. The live token endpoint returned an error object over HTTP 200 during this research.

Use `userId` as the immutable external identifier. A user can change `username`; update the local display name on every successful login.

### Refresh and revocation

The refresh request is:

```text
GET https://www.destiny.gg/oauth/token
  ?grant_type=refresh_token
  &client_id=...
  &refresh_token=...
```

It returns the same shape as the initial exchange and rotates both tokens. The source replaces the stored access and refresh values during renewal. See the [refresh documentation](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/OAUTH.md#L121-L159) and [renewal code](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Controllers/OAuthController.php#L153-L181).

The simplest first version does not need to keep DGG tokens after login. Fetch identity, create the app's own session, and discard them. If silent DGG revalidation becomes necessary, encrypt the refresh token at rest, keep it out of the browser, replace it atomically after every refresh, and handle user revocation. The developer page lets users revoke third-party connections, but the guide documents no client-callable revocation endpoint.

## Roles, room privileges, and teams

The credentials builder always adds `USER`, then adds persisted DGG roles and subscription-related claims. The source defines `ADMIN` as website administration and `MODERATOR` as access to users and bans. Other roles such as `FINANCE`, `EMOTES`, and `FLAIRS` are narrower capabilities. See the [credentials builder](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Common/Authentication/AuthenticationService.php#L218-L279) and [role constants](https://github.com/destinygg/website/blob/4f4077671080bb9449435a8bb29f4379eb19a605/lib/Destiny/Common/User/UserRole.php#L4-L24).

Do not treat every non-`USER` role as a radio administrator. Pick one rule and test it:

- Strict rule: only a DGG `ADMIN` gets room controls.
- Community moderation rule: DGG `ADMIN` or `MODERATOR` gets room controls.

Store the derived radio role in the server-side session, not in client-controlled state. Recompute it when identity is refreshed because DGG roles can change.

The team clue is in `features`, not `roles`. The production [flair catalog](https://cdn.destiny.gg/flairs/flairs.json) reported these mappings on 2026-08-27:

- `flair35`: `Team PEPE`
- `flair36`: `Team YEE`

The user-info credentials builder fills `features` from the user's assigned DGG features. This makes the likely mapping:

```ts
function teamFromFeatures(features: string[]): "pepe" | "yee" | null {
  const pepe = features.includes("flair35");
  const yee = features.includes("flair36");
  if (pepe === yee) return null;
  return pepe ? "pepe" : "yee";
}
```

This mapping has not been verified with a real OAuth response from team members. Test one PEPE user, one YEE user, and one user with no team. If both values ever appear, record the identity as unknown instead of guessing. Treat team as decoration, never authorization. The numeric flair names are live content data and could change, so date the mapping and add a small contract test against the catalog when team support is implemented.

## Security requirements

- Keep `DGG_CLIENT_SECRET`, access tokens, refresh tokens, and the YouTube API key on the backend. Never expose them through Astro public environment variables or browser bundles.
- Use HTTPS for every redirect and provider request.
- Generate state and verifier values with a cryptographically secure RNG. Store login transactions server-side with a five-minute expiry, compare state in constant time where practical, and consume each transaction once.
- Use one fixed callback URI. Keep the user's eventual in-app destination in server state and allow only local application paths.
- Issue a separate app session after DGG identity validation. Use a random session ID in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie, rotate it at login, and enforce CSRF protection on state-changing API calls.
- Validate token and user-info JSON before use. Treat provider errors, timeouts, and malformed data as login failures.
- Redact query strings for `/oauth/token` and `/api/userinfo`. The DGG protocol carries credentials in URLs.
- Do not infer admin access from `features`, flair names, subscription tier, or username.
- Keep a local moderation audit trail. DGG identity tells the app who acted; it does not replace authorization checks on skip, ban, restriction, or queue mutation commands.

## Automatic YouTube checks for the UAE host

Call the YouTube Data API v3 [`videos.list`](https://developers.google.com/youtube/v3/docs/videos/list) method from the backend before inserting a YouTube item:

```text
GET https://www.googleapis.com/youtube/v3/videos
  ?id=VIDEO_ID
  &part=snippet,contentDetails,status
  &fields=items(id,snippet(title,channelTitle,thumbnails,liveBroadcastContent),contentDetails(duration,regionRestriction,contentRating/ytRating),status(uploadStatus,privacyStatus,embeddable))
```

Supply the API key with the `x-goog-api-key` header or the official client library. Google says to enable YouTube Data API v3 in a Google Cloud project and obtain credentials before making requests. Public list operations can use an API key without end-user OAuth. See the [Data API setup guide](https://developers.google.com/youtube/v3/getting-started) and [Google's API key practices](https://docs.cloud.google.com/docs/authentication/api-keys-best-practices).

Use this rejection sequence:

1. Reject if the response does not contain exactly the requested video. This covers invalid, removed, private, and otherwise inaccessible IDs. The method can also report `videoNotFound`; handle both forms. [`videos.list` response and errors](https://developers.google.com/youtube/v3/docs/videos/list#response)
2. Reject unless `status.uploadStatus === "processed"` and `status.privacyStatus` is `public` or `unlisted`. Reject private, failed, rejected, deleted, still-uploading, and scheduled-private items. [Video status fields](https://developers.google.com/youtube/v3/docs/videos#status.uploadStatus)
3. Reject unless `status.embeddable === true`. This field says whether the video can be embedded on another website. [Embeddable field](https://developers.google.com/youtube/v3/docs/videos#status.embeddable)
4. Reject if `contentDetails.contentRating.ytRating === "ytAgeRestricted"`. YouTube defines this value as its age-restricted-content marker, and age-restricted videos cannot play on most third-party embeds. [Rating field](https://developers.google.com/youtube/v3/docs/videos#contentDetails.contentRating.ytRating), [YouTube Help](https://support.google.com/youtube/answer/10070779?hl=en)
5. Reject if UAE country code `AE` is not viewable under `contentDetails.regionRestriction`:
   - If `allowed` exists, require that it contains `AE`. An empty `allowed` list blocks the video everywhere.
   - If `blocked` exists, require that it does not contain `AE`. An empty `blocked` list blocks it nowhere.
   - If the region-restriction object is absent, this field supplies no country block, so pass this check.
   These rules come directly from the [video resource definition](https://developers.google.com/youtube/v3/docs/videos#contentDetails.regionRestriction).
6. Reject if `snippet.liveBroadcastContent !== "none"`. The field distinguishes active and upcoming broadcasts from ordinary videos. [Live broadcast field](https://developers.google.com/youtube/v3/docs/videos#snippet.liveBroadcastContent)
7. Parse `contentDetails.duration`, an ISO 8601 duration, and reject a missing, invalid, zero, or greater-than-420-second value. This enforces the room's seven-minute rule and avoids accepting indeterminate live content. [Duration field](https://developers.google.com/youtube/v3/docs/videos#contentDetails.duration)

Do not send `regionCode=AE` with the ID lookup. YouTube documents that `videos.list.regionCode` only works with the `chart` filter, not the `id` filter. Inspect `contentDetails.regionRestriction` instead. [Request parameter definition](https://developers.google.com/youtube/v3/docs/videos/list#parameters)

One `videos.list` request costs one quota unit. Google currently gives enabled projects a default pool of 10,000 units per day for endpoints other than the separately listed defaults, and even invalid requests cost at least one unit. A single-room queue should fit comfortably, but rate-limit submissions, cache short-lived successful metadata by video ID, and monitor quota. Recheck the item when it reaches the head of the queue because restrictions can change after insertion. [Method quota cost](https://developers.google.com/youtube/v3/docs/videos/list), [default quota](https://developers.google.com/youtube/v3/getting-started#quota)

Keep the API key in the backend environment and restrict it to YouTube Data API v3. Google recommends both API and application restrictions, but an IP restriction only works if the backend host has stable documented egress addresses. Do not ship an unrestricted browser key. [API key restrictions](https://docs.cloud.google.com/docs/authentication/api-keys#api_key_restrictions)

### What the preflight cannot guarantee

The metadata check is necessary but not a playback probe from the UAE host. Playback can still fail because:

- A content owner can restrict embedding to particular domains even when general embedding is enabled. [YouTube embedding restrictions](https://support.google.com/youtube/answer/6301625?hl=en)
- The owner or YouTube can remove, privatize, age-restrict, or region-block the video after it enters the queue.
- The embedded player requires an HTTP Referer or equivalent client identification. Missing it produces error 153. [Embed requirements](https://support.google.com/youtube/answer/171780?hl=en)
- The IFrame Player can report removed/private video error 100 and embedding errors 101 or 150 at runtime. [IFrame Player error codes](https://developers.google.com/youtube/iframe_api_reference#onError)
- Account, device, network, legal, or policy checks can affect the actual UAE playback session beyond the public metadata fields.

Revalidate immediately before playback, listen for the IFrame Player's `onError` event, skip on a terminal playback error, and record the reason for moderators. This runtime fallback is part of the restriction feature, not an exceptional manual path.

## Netlify and the real-time backend

### What belongs on Netlify

Deploy the frontend as a static Astro site. Netlify detects Astro, suggests `astro build`, and publishes `dist`. A static site that does not use Astro server features or Netlify's Astro image integration can deploy without `@astrojs/netlify`. [Netlify's Astro guide](https://docs.netlify.com/build/frameworks/framework-setup-guides/astro/)

That fits the requested Astro, Vite, and TypeScript frontend. The browser can connect directly to `https://api.example.com` and `wss://api.example.com`. Keep shared request, response, and event schemas in a small workspace package used by both frontend and backend.

Netlify Functions remain useful for isolated, short request-response jobs, but they should not own room state. Functions support TypeScript and run in an ephemeral environment. Current fixed limits include 60 seconds for synchronous functions, 30 seconds for scheduled functions, 15 minutes for background functions, and 20 MB for streamed responses. [Functions overview](https://docs.netlify.com/build/functions/overview/), [function limits](https://docs.netlify.com/build/functions/configuration/#default-values), [streaming responses](https://docs.netlify.com/build/functions/api/#streaming-responses)

Netlify's own support guide says a Node HTTP listener or other persistent server cannot run there, recommends Functions for short-running endpoints, and points to externally hosted backends when a server is required. [Netlify server support guide](https://answers.netlify.com/t/support-guide-can-i-run-a-web-server-http-listener-and-or-database-at-netlify/3078)

Edge Functions do not fix the room-server problem. They have a 50 ms CPU budget and a 40-second response-header timeout. The documented handler contract does not provide an inbound WebSocket listener or upgrade primitive. Do not infer WebSocket hosting support merely because the edge runtime exposes a browser-style outbound `WebSocket` class. [Edge Function limits](https://docs.netlify.com/build/edge-functions/limits/), [Edge Function API](https://docs.netlify.com/build/edge-functions/api/)

Async Workloads can run durable, retryable background workflows. They are useful later for analytics aggregation or retryable media metadata work, not for connected clients or the live playback clock. [Async Workloads overview](https://docs.netlify.com/build/async-workloads/overview/)

### Simplest viable topology

Use three runtime pieces:

1. Netlify static Astro frontend.
2. One always-on TypeScript backend process on a host that explicitly supports long-lived WebSocket connections.
3. Managed Postgres.

The backend owns:

- DGG OAuth initiation, callback, user-info lookup, and app sessions
- all authorization checks and admin actions
- the authoritative round-robin queue and playback clock
- YouTube and SoundCloud link validation
- WebSocket fan-out for presence, queue state, votes, skips, and playback synchronization
- persistence for users, plays, votes, moderation, restrictions, and reputation aggregates

Run one backend instance at first. It can serialize mutations for the only room and broadcast directly to its connected clients. Do not add Redis until the backend needs more than one instance. Persist durable events and current queue state in Postgres so a process restart can reconstruct the room.

Avoid splitting OAuth into a Netlify Function while the session and WebSocket server live elsewhere. Putting login, session issuance, REST, and WebSocket authorization in the same backend removes token handoffs and duplicate session logic.

## Open questions to settle before implementation

1. Register a DGG client and verify the exact challenge encoding, GET token exchange, callback query behavior, user-info JSON, refresh rotation, and HTTP status behavior against production.
2. Decide whether room control maps to `ADMIN` only or `ADMIN` plus `MODERATOR`.
3. Confirm `flair35` and `flair36` in real OAuth `features` arrays and define the no-team case. Keep team out of authorization decisions.
4. Choose the always-on TypeScript and Postgres host. Require explicit WebSocket support, TLS, secrets, health checks, backups, and a deployment region acceptable for the community.
5. Decide whether unlisted YouTube videos are allowed. The proposed check allows them because possession of the link is enough to play them; private videos remain rejected.
6. Decide whether live and upcoming YouTube broadcasts are always disallowed. The proposed seven-minute song rule rejects them.
7. Define how long a queued YouTube preflight result may be cached. Always recheck at playback even if insertion used a cached success.
