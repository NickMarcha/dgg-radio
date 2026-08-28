import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:4321/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const { ChatLookupError, DANCING_EMOTES, countChatTerms, teamFromCounts, topEmoteFromCounts } =
  await import('./chat');

/** Answers every term from a table, and reports a healthy allowance. */
function stubChat(counts: Record<string, number>, remaining = '50'): typeof fetch {
  return vi.fn(async (input: unknown) => {
    const term = decodeURIComponent(String(input).split('?')[0]!.split('/').pop()!);
    return new Response(JSON.stringify({ count: counts[term] ?? 0 }), {
      headers: { 'Content-Type': 'application/json', 'RateLimit-Remaining': remaining },
    });
  }) as unknown as typeof fetch;
}

describe('teamFromCounts', () => {
  it('needs three quarters of the mentions to take a side', () => {
    expect(teamFromCounts(143, 5)).toBe('yee');
    expect(teamFromCounts(5, 143)).toBe('pepe');
    expect(teamFromCounts(75, 25)).toBe('yee');
    expect(teamFromCounts(74, 26)).toBeNull();
    expect(teamFromCounts(50, 50)).toBeNull();
  });

  it('leaves someone who has said neither word unassigned', () => {
    expect(teamFromCounts(0, 0)).toBeNull();
  });

  it('takes a side on a single mention, because no minimum was wanted', () => {
    expect(teamFromCounts(1, 0)).toBe('yee');
    expect(teamFromCounts(0, 1)).toBe('pepe');
  });
});

describe('topEmoteFromCounts', () => {
  it('picks the most used dancing emote', () => {
    expect(topEmoteFromCounts({ Listening: 215, AlienPls: 127, catJAM: 107 })).toBe('Listening');
  });

  it('has nobody to pick when every count is zero', () => {
    expect(topEmoteFromCounts(Object.fromEntries(DANCING_EMOTES.map((e) => [e, 0])))).toBeNull();
  });

  it('ignores terms that are not dancing emotes', () => {
    expect(topEmoteFromCounts({ yee: 900, catJAM: 3 })).toBe('catJAM');
  });

  it('breaks a tie the same way every time', () => {
    const first = topEmoteFromCounts({ catJAM: 9, AlienPls: 9 });
    expect(first).toBe('AlienPls');
    expect(topEmoteFromCounts({ AlienPls: 9, catJAM: 9 })).toBe(first);
  });
});

describe('countChatTerms', () => {
  it('asks for both team words and every dancing emote, once each', async () => {
    const fetcher = stubChat({ yee: 143, pepe: 5, Listening: 215 });

    const counts = await countChatTerms('strawwaffle', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(DANCING_EMOTES.length + 2);
    expect(counts.yee).toBe(143);
    expect(counts.Listening).toBe(215);
    expect(counts.pepeJAM).toBe(0);
  });

  it('stops rather than spending an exhausted window', async () => {
    const fetcher = stubChat({ yee: 1 }, '0');

    await expect(countChatTerms('strawwaffle', fetcher)).rejects.toMatchObject({
      code: 'CHAT_RATE_LIMITED',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reports a refusal rather than reading it as silence', async () => {
    const fetcher = vi.fn(async () => new Response('no', { status: 503 })) as unknown as typeof fetch;

    await expect(countChatTerms('strawwaffle', fetcher)).rejects.toBeInstanceOf(ChatLookupError);
  });

  it('treats an unknown username as saying nothing, since the API answers zero', async () => {
    const counts = await countChatTerms('nobody', stubChat({}));

    expect(teamFromCounts(counts.yee!, counts.pepe!)).toBeNull();
    expect(topEmoteFromCounts(counts)).toBeNull();
  });
});
