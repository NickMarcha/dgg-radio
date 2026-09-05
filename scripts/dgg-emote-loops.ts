/**
 * Which destiny.gg emotes are meant to keep going, and which are meant to end.
 *
 *   npx tsx scripts/dgg-emote-loops.ts
 *
 * The watchers overlay loops the dances, because a chat message settles down
 * once it has been read and an overlay has nothing to settle into. It must not
 * loop the rest: about as many emotes again run exactly once on purpose —
 * OBJECTION slams in, GIGACHAD arrives — and repeating one of those turns an
 * entrance into a twitch that never stops.
 *
 * The catalogue itself is the only authority on which is which. Every
 * `.emote.<prefix>` rule in the CDN stylesheet the overlay draws with declares
 * its own iteration count, so this reads them and prints the ones above one, as
 * the selector `WatchersOverlay.css` carries. Run it when the catalogue moves;
 * an emote neither list has heard of is simply left as the CDN wrote it.
 *
 * Nothing here needs DATABASE_URL, a session, or a key.
 */

const STYLESHEET_URL = 'https://cdn.destiny.gg/emotes/emotes.css';

/** A declaration repeats if any animation in it asks for more than one pass. */
function repeats(animation: string): boolean {
  return animation.split(',').some((part) => {
    const tokens = part.trim().split(/\s+/);
    if (tokens.includes('infinite')) return true;
    return tokens.some((token) => /^\d+(\.\d+)?$/.test(token) && Number(token) > 1);
  });
}

function readRules(css: string): { base: Set<string>; pseudo: Set<string>; once: Set<string> } {
  const base = new Set<string>();
  const pseudo = new Set<string>();
  const once = new Set<string>();

  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const animation = /animation\s*:\s*([^;]+)/.exec(body);
    if (!animation) continue;

    // Comments run into the selector that follows them, so they go first.
    const target = selector.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const own = /^\.emote\.([A-Za-z0-9_]+)$/.exec(target);
    if (own) {
      (repeats(animation[1]) ? base : once).add(own[1]);
      continue;
    }

    const decoration = /^\.emote\.([A-Za-z0-9_]+):{1,2}(?:before|after)$/.exec(target);
    if (decoration && repeats(animation[1])) pseudo.add(decoration[1]);
  }

  // An emote whose own rule repeats is not also a one-shot: the CDN declares
  // some of them twice, and the repeating declaration is the one that lands.
  for (const prefix of base) once.delete(prefix);
  return { base, pseudo, once };
}

function asSelector(prefixes: Set<string>): string {
  return [...prefixes]
    .sort((left, right) => left.localeCompare(right))
    .map((prefix) => `.${prefix}`)
    .join(', ');
}

async function main(): Promise<void> {
  const response = await fetch(STYLESHEET_URL);
  if (!response.ok) throw new Error(`${STYLESHEET_URL} answered ${response.status}`);

  const { base, pseudo, once } = readRules(await response.text());

  console.log(`Loop these — ${base.size} emotes destiny.gg already repeats:\n`);
  console.log(asSelector(base));
  console.log(`\nAnd these ${pseudo.size} on their pseudo-elements:\n`);
  console.log(asSelector(pseudo));
  console.log(`\nLeave these alone — ${once.size} emotes declared to run once:\n`);
  console.log(asSelector(once));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
