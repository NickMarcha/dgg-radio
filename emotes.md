# Emote source

The emotes in `public/emotes/` were downloaded from the Destiny.gg CDN on 2026-08-28.

- Emote manifest: <https://cdn.destiny.gg/emotes/emotes.json?_=>
- Emote styles: <https://cdn.destiny.gg/emotes/emotes.css?_=>

`public/emotes/emotes.json` and `public/emotes/emotes.css` are byte-for-byte snapshots of the responses from those URLs. The asset filenames use the casing from each manifest `prefix`.

`AlienPls` is stored as `public/emotes/AlienPls.webp` because the CDN response contains WebP data even though its source URL ends in `.gif`.

`public/favicon.png` is a copy of `public/emotes/TeddYEE.png` used as the frontend favicon.

`public/emotes/MMMM.png` was added later, from the same manifest, as the stand-in avatar for anyone whose chat has not been counted yet. It is two 28-pixel frames in one 56-pixel file; the snapshot shows the left one by default and reserves the right for a single chat username upstream, which this site does not use.

## Animation

Emotes animate in three different ways, and the difference decides how they can be rendered.

### Sprite sheets

Some emotes are sprite sheets rather than self-animating image files. For example, `public/emotes/catJAM.png` contains 188 horizontal frames, while `public/emotes/RaveDoge.avif` is a 2,700-pixel-wide strip. The `.emote.catJAM` and `.emote.RaveDoge` rules in `public/emotes/emotes.css` animate them by changing `background-position` with keyframes. Rendering either file as a normal `<img>` will not reproduce that animation.

The CSS snapshot is unmodified and its `background-image` declarations use the original hashed CDN filenames. Code that uses the local prefix-named assets must override those URLs with the public paths `/emotes/catJAM.png` and `/emotes/RaveDoge.avif`, while retaining the matching dimensions, animation, and keyframes from `public/emotes/emotes.css`.

### CSS transforms

A third kind has a single, ordinary frame and is animated entirely by CSS: `transform` skews and scales, `background-position` bobs, and `filter: drop-shadow` colour waves. `pepeJAM` and `YAM` both work this way. Their images are one frame at their natural size, so nothing about the file suggests animation.

Their rules are nowhere near their size declarations in `public/emotes/emotes.css`. `.emote.pepeJAM` is declared at line 1990 and animated at 6723; `.emote.YAM` is declared at 2809 and animated at 8034. Searching for the first `.emote.<prefix> {` match and reading the block will report these emotes as static, which is wrong.

These cannot be rendered as `<img>`. Part of the animation moves `background-position`, so the emote has to be a background image on an element. An `<img>` picks up the skew and drops the bob.

The iteration counts are finite on purpose: `pepeJAM` runs its bob 16 times and `YAM` runs 31, because a chat message should settle down after a few seconds. Anything long-lived, such as a header, wants `infinite` instead.

Repeats are louder than singles. Rules under `:nth-of-type(2n)` add a rainbow `drop-shadow` wave, so two of the same emote side by side animate differently from one on its own.

### What this project uses

`src/styles/emotes.css` holds the rules for only the emotes this site renders, rewritten to point at the local `/emotes/` paths and to loop. That now covers the nine dancing and music emotes used as avatars, plus `MMMM`.

Their declared sizes are the originals on purpose. `catJAM` and `RaveDoge` animate by stepping `background-position` across one long strip, so their frame offsets are tied to the declared width: changing `background-size` to fit an avatar into a circle would desynchronise every frame. Resizing one of these is only safe through `transform`, which scales the painted result and leaves the offsets alone. That is why an emote avatar keeps its natural size instead of being clipped into the circular slot the letter used. The snapshot is not imported: it carries thousands of rules for emotes that were never downloaded, all referencing hashed CDN filenames that do not exist here. Adding an emote to the interface means porting its rules across in the same way.
