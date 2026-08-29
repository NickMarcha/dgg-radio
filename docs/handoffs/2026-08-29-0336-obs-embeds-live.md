# OBS embeds are live

## Current state

`main` matched `origin/main` at `c090881` before this handoff was created. This handoff file is the only expected working-tree change. The frontend is live on Netlify. The API stack and active production room were not restarted during this work.

Production pages:

- Player: https://dgg-radio.netlify.app/embed/player/
- Now playing: https://dgg-radio.netlify.app/embed/playing/
- Upcoming queue: https://dgg-radio.netlify.app/embed/queue/
- Admin: https://dgg-radio.netlify.app/admin/

The current Netlify deploy ID is `6a918015c38ae6bb542a8394`. Its build log is at https://app.netlify.com/projects/dgg-radio/deploys/6a918015c38ae6bb542a8394.

## What shipped

Three commits make up this batch:

- `f2dbb3d Hide team tags from radio room`
  - Removed team tags from the main player page.
  - Team tags remain on stats and profile pages.
- `31972d2 Add OBS player embeds`
  - Added `/embed/player`, a synchronized video and audio player with autoplay, sound, and no DGG controls.
  - Added `/embed/playing`, a silent transparent metadata overlay.
  - Added links to the embed pages at the bottom of Admin.
  - Recorded the OBS and provider research in `docs/research/obs-embed-playback.md`.
- `c090881 Expand OBS metadata embeds`
  - Set the recommended now-playing source size to `1200 x 240`.
  - Made a long title scroll only when it is wider than the available space.
  - Added artist, requester, upvotes, downvotes, and synchronized `elapsed / duration` lines.
  - Added `/embed/queue`, a silent upcoming-queue overlay sized for `800 x 600`.
  - Added the queue link and recommended OBS dimensions to Admin.

If the room hides a requester, the metadata and queue embeds say `Requester hidden`. They do not bypass the room's privacy setting.

## OBS setup

Use `/embed/player` at a 16:9 size such as `1920 x 1080` or `1280 x 720`. In the OBS Browser Source settings:

- Turn on `Control audio via OBS`.
- Turn on `Shutdown source when not visible`.
- Leave `Refresh browser source when scene becomes active` off.

The player uses the provider's real video surface. YouTube fills the source with control-free video. SoundCloud has no video, so its official visual audio player fills the source instead.

Use `/embed/playing` at `1200 x 240`. It has a transparent page and produces no audio. Use `/embed/queue` at `800 x 600`; it is also transparent and silent. Both overlays update from the same room snapshot as the main site.

## Verification

The final local checks passed before deployment:

- `npm test`: 53 passed, 63 database tests skipped because no test database was configured.
- `npm run check`: 0 errors, warnings, or hints.
- `npm run build`: frontend and API builds passed. Astro generated all three embed routes.
- `git diff --check`: clean.
- Browser preview at `1200 x 240`: long-title marquee active, metadata fit, no controls, transparent body.
- Browser preview at `800 x 600`: six queue rows fit, no controls, transparent body.
- Production HTTP checks: `/embed/playing`, `/embed/queue`, and `/admin` returned 200.

Netlify rebuilt the frontend successfully during the production deploy. No API code or database schema changed.

## Files to start with

- `src/components/EmbedView.tsx` owns the player, now-playing, and queue render branches.
- `src/components/EmbedView.css` owns every OBS layout and the title marquee.
- `src/pages/embed/player.astro`, `playing.astro`, and `queue.astro` expose the routes.
- `src/components/AdminPanel.tsx` contains the Admin links and recommended source sizes.
- `src/components/EmbedView.test.tsx` covers the control-free embeds and their metadata.
- `docs/research/obs-embed-playback.md` explains the OBS, autoplay, YouTube, and SoundCloud constraints.

## Next step

No unfinished implementation remains in this batch. Start by checking `git status -sb` and production health. Keep the production API stack running because the room may be in active use. Frontend-only work can deploy through `netlify deploy --prod` without touching that room.
