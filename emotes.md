# Emote source

The emotes in `public/emotes/` were downloaded from the Destiny.gg CDN on 2026-08-28.

- Emote manifest: <https://cdn.destiny.gg/emotes/emotes.json?_=>
- Emote styles: <https://cdn.destiny.gg/emotes/emotes.css?_=>

`public/emotes/emotes.json` and `public/emotes/emotes.css` are byte-for-byte snapshots of the responses from those URLs. The asset filenames use the casing from each manifest `prefix`.

`AlienPls` is stored as `public/emotes/AlienPls.webp` because the CDN response contains WebP data even though its source URL ends in `.gif`.

## Animation

Some emotes are sprite sheets rather than self-animating image files. For example, `public/emotes/catJAM.png` contains 188 horizontal frames, while `public/emotes/RaveDoge.avif` is a 2,700-pixel-wide strip. The `.emote.catJAM` and `.emote.RaveDoge` rules in `public/emotes/emotes.css` animate them by changing `background-position` with keyframes. Rendering either file as a normal `<img>` will not reproduce that animation.

The CSS snapshot is unmodified and its `background-image` declarations use the original hashed CDN filenames. Code that uses the local prefix-named assets must override those URLs with the public paths `/emotes/catJAM.png` and `/emotes/RaveDoge.avif`, while retaining the matching dimensions, animation, and keyframes from `public/emotes/emotes.css`.
