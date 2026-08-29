# OBS embed playback

Checked 2026-08-28 against official OBS, YouTube, and SoundCloud sources, plus the current player implementation in this repo.

## Recommendation

Build both routes.

- `/embed/player` should fill the browser-source viewport with the synchronized provider player, start unmuted, and expose no DGG Radio controls or page chrome.
- `/embed/playing` should render only metadata such as title, artist, and artwork. It must not create a second media player or produce audio.

This is designed to work unattended in the current OBS Browser Source. It should not be presented as a general web autoplay page. Normal Chrome profiles often block unmuted autoplay, while the current OBS Browser Source explicitly launches CEF with `autoplay-policy=no-user-gesture-required`. [OBS Browser Source code](https://github.com/obsproject/obs-browser/blob/d7065f9084c84413c66f56e63a29e38766657547/browser-app.cpp#L94), [Chrome autoplay policy](https://developer.chrome.com/blog/autoplay/)

## What the repo already has

`MediaPlayer.tsx` already computes a server-clock offset, seeks to the current room position on load, checks drift every 10 seconds, and supports both provider APIs. `RadioRoom.tsx` refreshes `/api/room` when `/ws` reports a room change and falls back to a 15-second poll. The embed should reuse that playback and room-subscription logic, not start a separate synchronization model.

The existing component cannot be dropped into the embed unchanged. It starts paused, restores a listener's local preference, gives autoplay three seconds to prove itself, and renders buttons, progress, time, and track information. The OBS route needs an explicit auto-start mode or a smaller headless playback component with no local-storage dependency.

## OBS behavior

OBS Browser Source is a CEF-based browser and can render web video and audio. The official plugin is included with OBS packages on Windows, macOS, Ubuntu PPA, and Flatpak. [obs-browser](https://github.com/obsproject/obs-browser), [OBS Browser Source guide](https://obsproject.com/kb/browser-source)

OBS deliberately removes Chromium's normal gesture requirement for autoplay. That is the reason unmuted YouTube and SoundCloud playback can start when a Browser Source loads. Provider iframes should still receive `allow="autoplay"`, because YouTube names missing cross-origin autoplay permission as another reason for blocking playback. [OBS autoplay setting](https://github.com/obsproject/obs-browser/blob/d7065f9084c84413c66f56e63a29e38766657547/browser-app.cpp#L94), [YouTube `onAutoplayBlocked`](https://developers.google.com/youtube/iframe_api_reference#onAutoplayBlocked)

Turn on `Control audio via OBS`. OBS then places the Browser Source in its mixer, where the operator can set volume, add filters, or send the audio to the stream without playing it through the computer speakers. This option is off by default. [OBS audio routing announcement](https://obsproject.com/blog/progress-report-september-2019#browser-source-audio-can-now-go-through-obs)

`Shutdown source when not visible` unloads a Browser Source when it is hidden or outside the active scene. `Refresh browser source when scene becomes active` reloads it on scene activation. Both default to off. [OBS Browser Source properties](https://obsproject.com/kb/browser-source#properties)

For this player, enable shutdown when not visible. It stops off-scene playback and lets the page reconnect and seek to the room time when it becomes visible again. Leave refresh-on-activation off because shutdown already causes a fresh load. If the player must continue across several scenes, add the same existing source to those scenes rather than creating several copies. One active source avoids doubled audio and YouTube's one-autoplaying-player-per-screen limit.

## YouTube constraints

Use the IFrame Player API. `autoplay=1` starts automatically, `controls=0` hides native controls, and `disablekb=1` disables keyboard playback shortcuts. Set `origin` to the embed page's origin when using the JavaScript API. The current player already uses these values. [YouTube player parameters](https://developers.google.com/youtube/player_parameters)

On ready, set the desired volume, call `unMute()`, seek to the server-derived offset, and call `playVideo()`. Keep the existing drift check with `getCurrentTime()` and `seekTo(seconds, true)`. A seek can land on the closest keyframe, so exact frame lock is not promised. [YouTube IFrame API playback and seeking](https://developers.google.com/youtube/iframe_api_reference#Playback_controls)

Add `onAutoplayBlocked`. YouTube fires it when the browser refuses `autoplay`, `playVideo()`, or another scripted start. OBS should not normally reach it, but it gives the app a clean error signal for ordinary browsers, old or modified OBS builds, and iframe-permission mistakes. [YouTube autoplay-blocked event](https://developers.google.com/youtube/iframe_api_reference#onAutoplayBlocked)

The YouTube player must be the visible video, not a hidden audio source. YouTube requires an embedded player viewport of at least 200 by 200 pixels and recommends at least 480 by 270 for 16:9. Automatic playback must wait until the player is visible and more than half of it is visible. Do not crop, cover, or place custom art over any part of the iframe. YouTube also allows only one automatically playing player per page or screen. [YouTube required minimum functionality](https://developers.google.com/youtube/terms/required-minimum-functionality#youtube-embedded-player-and-video-playback)

`controls=0` is supported, but it does not authorize removing every YouTube-supplied label, ad, or brand element. `modestbranding` is deprecated and has no effect. The fullscreen CSS should size the iframe itself to the viewport instead of masking unwanted parts. [YouTube `controls`](https://developers.google.com/youtube/player_parameters#controls), [YouTube player attributes and overlays](https://developers.google.com/youtube/terms/required-minimum-functionality#youtube-player-attributes)

Preserve the iframe's HTTP Referer. Do not send `Referrer-Policy: no-referrer`; YouTube recommends `strict-origin-when-cross-origin`. A missing client identity can fail with player error 153. Keep `origin: window.location.origin` as well. [YouTube API client identity](https://developers.google.com/youtube/terms/required-minimum-functionality#api-client-identity-and-credentials)

### Captions

Checked 2026-08-29. There is no player parameter that turns captions off. `cc_load_policy=1` "causes closed captions to be shown by default, even if the user has turned captions off", and the documented default is "based on user preference"; `cc_lang_pref` only chooses the language. Nothing forces the other direction. [YouTube player parameters](https://developers.google.com/youtube/player_parameters)

The current IFrame API reference documents `getOptions`, `getOption`, and `setOption` for the `captions` module, and the options it lists are `fontSize` and `reload`. Neither switches captions off. [YouTube IFrame API captions module](https://developers.google.com/youtube/iframe_api_reference#Retrieving_Module_Options)

`unloadModule('captions')` is what actually hides them. It is a surviving method from the older API and is no longer in the reference, so treat it as undocumented: call it optionally, and expect nothing if a future player drops it. The module does not always exist when `onReady` fires, so bind `onApiChange` too — it "is fired to indicate that the player has loaded (or unloaded) a module with exposed API methods" — and unload again from there. The legacy module name `cc` is unloaded alongside `captions` because either may be the live one. [YouTube `onApiChange`](https://developers.google.com/youtube/iframe_api_reference#onApiChange)

Tested 2026-08-29 in Chrome, three players side by side on one video with `cc_load_policy=1` forcing captions on. The control rendered captions. `unloadModule('captions')` removed them, and so did `setOption('captions', 'track', {})`. A third player that ignored `onApiChange` entirely and merely called `unloadModule` once a second for ten seconds also removed them, which is what the shipped player relies on.

Two traps came out of that test. `getOptions()` keeps reporting `["captions"]` and `getOption('captions', 'track')` keeps returning the full track object after the captions have visibly gone, so neither is a usable signal for whether captions are showing — only looking at the frame is. And the module can load at any point in the first seconds of playback: `onApiChange` fires, but it can fire before the module exists and not again afterwards, which is the likely reason a single unload on that event is not enough in OBS, where playback starts earlier than in an ordinary browser. Hence the repeated unload.

`/embed/player` hides captions. `/embed/player?captions=on` leaves YouTube's own preference alone.

## SoundCloud constraints

SoundCloud is audio-only, so it cannot provide the moving video requested for YouTube tracks. Its supported visual fallback is the artwork-focused embedded player. [SoundCloud visual embedded player](https://help.soundcloud.com/hc/en-us/articles/115003566828-The-Visual-embedded-player)

Use `allow="autoplay"` on the iframe. The official widget accepts `auto_play=true`; its JavaScript API also provides `play()`, `seekTo(milliseconds)`, `setVolume(0-100)`, asynchronous `getPosition()`, and playback events. Bind `READY`, seek to the server-derived offset in milliseconds, set volume, then call `play()`. Keep the same periodic drift correction used by the room player. [SoundCloud Widget API](https://developers.soundcloud.com/docs/api/html5-widget)

Bind `PLAY` as the success signal and `ERROR` for failure. Unlike YouTube, SoundCloud documents no autoplay-blocked event and `play()` returns no promise. The widget's own `PLAY_PROGRESS.currentPosition` or `getPosition()` can confirm that it is moving.

SoundCloud documents switches for artwork, uploader, buying, sharing, downloads, and play count. It does not document a `controls=false` option or a mute/unmute method. A completely control-free SoundCloud iframe is therefore not a supported configuration. The safe choice is to show the official visual widget full-frame and accept its core play/waveform UI. Hiding a tiny widget behind custom artwork may work in one CEF build, but neither SoundCloud's API nor its autoplay documentation promises that setup. [SoundCloud widget parameters](https://developers.soundcloud.com/docs/api/html5-widget#parameters), [SoundCloud autoplay note](https://help.soundcloud.com/hc/en-us/articles/115003566828-The-Visual-embedded-player#customize-your-player)

## Route shape

`/embed/player` should have a transparent or black full-viewport page, zero margins, no scrollbars, and one player element that occupies the viewport. For YouTube, show the actual 16:9 iframe with `controls=0`. For SoundCloud, show the visual widget as the artwork fallback. When the room is idle, render a transparent or black frame without text.

`/embed/playing` should use the same public room snapshot and WebSocket subscription but never import the provider APIs. That keeps it silent when an OBS scene contains both sources.

The embed routes do not need authentication or controls. They do need the same reconnect and polling fallback as the main room so a temporary WebSocket failure cannot leave an OBS overlay stale.

## OBS setup to publish with the feature

1. Add `https://dgg-radio.netlify.app/embed/player` as a Browser Source.
2. Set the source dimensions to the intended 16:9 output, preferably 1920 by 1080 or 1280 by 720. Do not crop or cover the YouTube iframe.
3. Turn on `Control audio via OBS`, leave the source unmuted in the mixer, and assign it to the stream or recording track.
4. Turn on `Shutdown source when not visible`. Leave `Refresh browser source when scene becomes active` off.
5. Add `/embed/playing` as a separate Browser Source wherever metadata is wanted. It produces no audio.
6. Test one YouTube track and one SoundCloud track after a cold OBS start, a scene switch, a manual Browser Source refresh, and a WebSocket reconnect. Confirm the player joins at the current room timestamp rather than at zero.

This research establishes the browser and provider behavior from source and documentation. It does not replace an end-to-end test in the OBS version used for production.
