/**
 * Destiny colours a username after its flairs. The rules live in
 * https://cdn.destiny.gg/flairs/flairs.css as `.user.<flair>` selectors, all at
 * the same specificity, so the winner is whichever matching rule appears last
 * in that file rather than the first one found.
 *
 * This list is that source order. Reversing it, or treating it as a first
 * match, miscolours anyone holding more than one: a subscriber who also has
 * flair1 shows as flair1 in chat, not as a subscriber.
 *
 * Flairs with no colour rule of their own are absent here on purpose.
 */
const COLOURED_FLAIRS = [
  'moderator',
  'flair125',
  'flair11',
  'bot',
  'subscriber',
  'flair9',
  'flair13',
  'flair32',
  'flair1',
  'flair22',
  'flair3',
  'flair24',
  'flair8',
  'flair26',
  'flair12',
  'flair7',
  'flair42',
  'flair33',
  'flair18',
  'admin',
  'flair17',
] as const;

/** The flair a username takes its colour from, or null when none of them colour it. */
export function resolveFlair(features: string[]): string | null {
  const held = new Set(features);
  let winner: string | null = null;
  for (const flair of COLOURED_FLAIRS) {
    if (held.has(flair)) winner = flair;
  }
  return winner;
}
