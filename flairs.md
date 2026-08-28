# Flair source

Username colours come from the Destiny.gg flair stylesheet, snapshotted on
2026-08-28.

- Flair styles: <https://cdn.destiny.gg/flairs/flairs.css?_=>

Unlike `public/emotes/`, no snapshot of that file is kept in the repository:
only the colours are used, and they are ported into `src/styles/flairs.css`
rather than imported. The upstream file also carries flair badge images on
hashed CDN filenames that do not exist here.

## How a username gets its colour

Upstream, every colour is a `.user.<flair>` rule, and all of them sit at the
same specificity. Nothing prioritises them explicitly. **The flair that wins is
whichever matching rule appears last in the file**, because that is how CSS
resolves a tie.

This is easy to get wrong, and getting it wrong is quiet: a subscriber who also
holds `flair1` shows as `flair1` in chat, not as a subscriber, because `flair1`
is declared later. Reading the flairs in the order the OAuth `features` array
happens to list them, or taking the first match, colours that person wrong
without ever erroring.

`src/server/flair.ts` encodes that source order as a list and picks the last
match. `resolveFlair` is called once at sign-in and the winner is stored on
`users.flair`, so every read is a plain column rather than a resolution.
`src/styles/flairs.css` then only has to name each rule; the rules never
compete, because one winner has already been chosen.

Keep the two in step. A colour added to the stylesheet needs its place in that
list, in the same relative position, or it will never be selected.

## Flairs that are not colours

Most flairs colour nothing. `flair5`, for instance, is a badge image with no
`.user` rule, so someone holding only that keeps the default colour. Those are
deliberately absent from the list rather than mapped to a default.

Two flairs, `flair33` and `flair42`, are an animated gradient rather than a
colour: the text is transparent and a moving rainbow shows through it. They are
ported with the gradient intact and stopped under
`prefers-reduced-motion: reduce`. Upstream names their keyframes `move`, which
is far too general for a shared stylesheet, so they are renamed here.
