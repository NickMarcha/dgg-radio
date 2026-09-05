import { describe, expect, it } from 'vitest';
import { buildEmoteCatalogue, lastEmoteIn } from './dgg-emotes';

/** Shaped like the entries in https://cdn.destiny.gg/emotes/emotes.json. */
const catalogue = buildEmoteCatalogue([
  { prefix: 'catJAM', twitch: false, minimumSubTier: 0 },
  { prefix: 'pepeJAM', twitch: false, minimumSubTier: 0 },
  { prefix: 'cat', twitch: false, minimumSubTier: 0 },
  { prefix: 'PepoTurkey', twitch: false, minimumSubTier: 2 },
  { prefix: 'TwitchOnly', twitch: true, minimumSubTier: 0 },
]);

describe('lastEmoteIn', () => {
  it('reads an emote out of a message', () => {
    expect(lastEmoteIn('catJAM', catalogue, 0)).toBe('catJAM');
    expect(lastEmoteIn('this song catJAM yes', catalogue, 0)).toBe('catJAM');
  });

  it('takes the last one, which is the one they finished on', () => {
    expect(lastEmoteIn('catJAM pepeJAM', catalogue, 0)).toBe('pepeJAM');
    expect(lastEmoteIn('catJAM catJAM catJAM pepeJAM', catalogue, 0)).toBe('pepeJAM');
  });

  it('needs whitespace either side, the way chat does', () => {
    expect(lastEmoteIn('catJAMing', catalogue, 0)).toBeNull();
    expect(lastEmoteIn('xcatJAM', catalogue, 0)).toBeNull();
    expect(lastEmoteIn('“catJAM”', catalogue, 0)).toBeNull();
  });

  it('is case sensitive, the way chat is', () => {
    expect(lastEmoteIn('catjam', catalogue, 0)).toBeNull();
    expect(lastEmoteIn('CATJAM', catalogue, 0)).toBeNull();
  });

  it('is not confused by an emote whose name starts another one', () => {
    // `cat` fails its boundary inside `catJAM`, and the engine goes on.
    expect(lastEmoteIn('catJAM', catalogue, 0)).toBe('catJAM');
    expect(lastEmoteIn('cat', catalogue, 0)).toBe('cat');
  });

  it('never shows an emote its author could not have used', () => {
    // Chat leaves it as text for them, so drawing it here would be a lie.
    expect(lastEmoteIn('PepoTurkey', catalogue, null)).toBeNull();
    expect(lastEmoteIn('PepoTurkey', catalogue, 1)).toBeNull();
    expect(lastEmoteIn('PepoTurkey', catalogue, 2)).toBe('PepoTurkey');
    expect(lastEmoteIn('catJAM PepoTurkey', catalogue, 1)).toBe('catJAM');
  });

  it('ignores the Twitch-only emotes entirely', () => {
    expect(lastEmoteIn('TwitchOnly', catalogue, 5)).toBeNull();
  });

  it('answers null for the ordinary case of somebody talking', () => {
    expect(lastEmoteIn('what is this song', catalogue, 4)).toBeNull();
    expect(lastEmoteIn('', catalogue, 0)).toBeNull();
  });

  it('reads the same message the same way twice', () => {
    // A global regular expression keeps its own position between calls.
    expect(lastEmoteIn('catJAM', catalogue, 0)).toBe('catJAM');
    expect(lastEmoteIn('catJAM', catalogue, 0)).toBe('catJAM');
  });
});
