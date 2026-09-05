import { z } from 'zod';

/**
 * The destiny.gg emote catalogue, read for one thing: which emote somebody just
 * used.
 *
 * It comes from the CDN rather than from `public/emotes/emotes.json`, because
 * the overlay draws with the CDN's own stylesheet. Reading the manifest beside
 * it keeps the two in step: an emote added upstream is matched and drawn
 * without a commit here, and one removed upstream stops being matched instead
 * of being named in a class that no longer has a rule.
 *
 * Failing to load it is not an error worth breaking anything over. Nothing
 * matches, watchers keep the emote their account gives them, and the next
 * refresh tries again.
 */
const MANIFEST_URL = 'https://cdn.destiny.gg/emotes/emotes.json';

/** Emotes change rarely, and a stale catalogue only misses a brand new one. */
export const CATALOGUE_TTL_MS = 12 * 60 * 60 * 1_000;

const manifestSchema = z.array(
  z.object({
    prefix: z.string().min(1),
    twitch: z.boolean().default(false),
    minimumSubTier: z.number().int().default(0),
  }),
);

export type EmoteManifest = z.infer<typeof manifestSchema>;

export interface EmoteCatalogue {
  /** Prefix to the tier it needs, so a message can be read against its author. */
  tiers: Map<string, number>;
  pattern: RegExp;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The matcher chat itself uses: whitespace on both sides, case sensitive, and
 * the prefixes exactly as the manifest spells them. Alternation order does not
 * matter because the boundary is enforced either side — `cat` inside `catJAM`
 * fails the lookahead and the engine goes on to try `catJAM`.
 */
export function buildEmoteCatalogue(manifest: EmoteManifest): EmoteCatalogue {
  const usable = manifest.filter((emote) => !emote.twitch);
  const prefixes = usable.map((emote) => escapeForRegExp(emote.prefix)).join('|');
  return {
    tiers: new Map(usable.map((emote) => [emote.prefix, emote.minimumSubTier])),
    pattern: new RegExp(`(?:^|\\s)(${prefixes})(?=$|\\s)`, 'g'),
  };
}

/**
 * The last emote in a message that its author could actually use.
 *
 * The last rather than the first, because it is the one they finished on. The
 * tier check is the same one chat applies when it decides whether to draw an
 * emote or leave the word as text, so the overlay never shows somebody using an
 * emote their account does not have.
 */
export function lastEmoteIn(
  text: string,
  catalogue: EmoteCatalogue,
  subTier: number | null,
): string | null {
  catalogue.pattern.lastIndex = 0;
  let found: string | null = null;
  let match = catalogue.pattern.exec(text);

  while (match !== null) {
    const prefix = match[1];
    if ((catalogue.tiers.get(prefix) ?? 0) <= (subTier ?? 0)) found = prefix;
    // The match consumes the separator in front of the emote but not the one
    // behind it, which is a lookahead — so the next search starts on that
    // space and a run of emotes matches one after another.
    match = catalogue.pattern.exec(text);
  }

  return found;
}

let catalogue: EmoteCatalogue | null = null;
let loadedAt = 0;
let complained = false;

/** The catalogue, reloaded when it is old enough to be worth asking again. */
export async function ensureEmoteCatalogue(
  fetcher: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<EmoteCatalogue | null> {
  if (catalogue && now - loadedAt < CATALOGUE_TTL_MS) return catalogue;

  try {
    const response = await fetcher(MANIFEST_URL, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`The emote manifest answered ${response.status}.`);
    catalogue = buildEmoteCatalogue(manifestSchema.parse(await response.json()));
    loadedAt = now;
    complained = false;
  } catch (error) {
    if (!complained) {
      complained = true;
      console.warn('Could not read the destiny.gg emote catalogue', error);
    }
  }

  return catalogue;
}
