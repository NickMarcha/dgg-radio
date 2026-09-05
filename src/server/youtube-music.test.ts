import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findMusicCard } from './youtube-music';

/**
 * The one thing about this client that has to hold under load: however many
 * callers ask at once, YouTube sees them one at a time and spaced.
 *
 * Enrichment starts up to two hundred lookups together, and without this they
 * all left at once. That is what a `google.com/sorry` block is earned with, and
 * a block degrades quietly — the caller falls back to guessing from the upload
 * title and nothing says why the answers got worse.
 */
describe('reading a video\'s music card', () => {
  let sentAt: number[] = [];

  beforeEach(() => {
    sentAt = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      sentAt.push(Date.now());
      // A page with no music card: parsed successfully, answers null. What is
      // being measured is when the request left, not what came back.
      return new Response('<html><script>var ytInitialData = {"contents":{}};</script></html>', {
        status: 200,
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends one request at a time even when asked for many at once', async () => {
    const started = Date.now();
    await Promise.all(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'].map(findMusicCard));

    expect(sentAt).toHaveLength(3);
    // Three requests at two seconds apart cannot finish inside four seconds,
    // and each gap has to be a real wait rather than a burst.
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
    for (let i = 1; i < sentAt.length; i += 1) {
      expect(sentAt[i]! - sentAt[i - 1]!).toBeGreaterThanOrEqual(1_900);
    }
  }, 20_000);
});
