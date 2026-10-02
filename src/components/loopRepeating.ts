/**
 * Loops every animation on an emote that destiny.gg already repeats, and leaves
 * the rest alone.
 *
 * A dance stops after a dozen or so iterations upstream, because a chat message
 * settles down once it has been read and an overlay has nothing to settle into.
 * Looping those only removes the cut-off. It is not a thing to do to every
 * emote: as many again are declared to run exactly once — OBJECTION slams in,
 * GIGACHAD arrives — and repeating one of those turns an entrance into a twitch
 * that never stops.
 *
 * The browser is asked rather than a list kept here, because which is which
 * changes with the season: destiny.gg swaps the images and animations behind
 * the same prefixes for Halloween and the like, and a list goes wrong twice per
 * event. The animations the browser reports are the ones the stylesheet on
 * screen declared, so this cannot disagree with it. `subtree` takes in the
 * `::before` and `::after` decorations some emotes animate.
 */
export function loopRepeatingAnimations(emote: Element): void {
  for (const animation of emote.getAnimations({ subtree: true })) {
    const effect = animation.effect;
    if (effect && Number(effect.getTiming().iterations ?? 1) > 1) {
      effect.updateTiming({ iterations: Infinity });
    }
  }
}
