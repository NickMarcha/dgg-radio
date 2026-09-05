import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Watcher, WatcherEmbedOptions, WatchersSnapshot } from '../shared/contracts';
import WatchersOverlay, {
  assignStableSlots,
  chooseWatchers,
  driftStyle,
  entranceFor,
  LEAVE_MS,
  mergeRendered,
  readWatchersOptions,
  safeDriftStyle,
} from './WatchersOverlay';

const state = vi.hoisted(() => ({ snapshot: null as WatchersSnapshot | null }));

vi.mock('./useWatchers', () => ({ useWatchers: () => state.snapshot }));

const NOW = new Date('2026-09-05T17:00:00.000Z').getTime();

function watcher(nick: string, overrides: Partial<Watcher> = {}): Watcher {
  return {
    nick,
    flair: null,
    subTier: null,
    // Recent by the real clock, because the component reads it. The window
    // cases below set their own times against NOW.
    lastSpokeAt: new Date(Date.now() - 60_000).toISOString(),
    lastEmote: null,
    member: false,
    emote: null,
    ...overrides,
  };
}

function options(overrides: Partial<WatcherEmbedOptions> = {}): WatcherEmbedOptions {
  return {
    show: 'speakers',
    window: 10,
    max: 12,
    layout: 'float',
    names: 'under',
    enter: 'fade',
    motion: 'drift',
    color: 'flair',
    speed: 100,
    size: 100,
    roam: 100,
    inset: 4,
    ...overrides,
  };
}

afterEach(() => {
  state.snapshot = null;
  vi.unstubAllGlobals();
});

describe('readWatchersOptions', () => {
  it('has a default for every option', () => {
    expect(readWatchersOptions('')).toEqual(options());
  });

  it('reads what the browser source was given', () => {
    expect(
      readWatchersOptions(
        '?show=all&window=30&max=8&layout=climb&names=off&enter=spin' +
          '&motion=orbit&speed=180&roam=0&inset=12&color=white&size=150',
      ),
    ).toEqual(
      options({
        show: 'all',
        window: 30,
        max: 8,
        layout: 'climb',
        names: 'off',
        enter: 'spin',
        motion: 'orbit',
        speed: 180,
        roam: 0,
        inset: 12,
        color: 'white',
        size: 150,
      }),
    );
  });

  it('falls back rather than failing on nonsense', () => {
    // An overlay showing the wrong arrangement can be fixed on air. One that
    // renders nothing cannot.
    const parsed = readWatchersOptions(
      '?show=everyone&max=0&window=abc&layout=grid&names=inside&enter=explode' +
        '&motion=wiggle&speed=9000&roam=-5&inset=90&color=beige&size=1',
    );
    expect(parsed).toEqual(options());
  });
});

describe('fixed layout seats', () => {
  it('does not move survivors when somebody leaves', () => {
    const first = ['One', 'Two', 'Three'].map((nick) => ({
      watcher: watcher(nick),
      leavingSince: null,
    }));
    const slots = assignStableSlots(first, 4, new Map());
    const before = new Map(slots);

    assignStableSlots([first[0], first[2]], 4, slots);

    expect(slots.get('One')).toBe(before.get('One'));
    expect(slots.get('Three')).toBe(before.get('Three'));
    expect(slots.has('Two')).toBe(false);
  });

  it('gives each occupied seat a different position around the safe frame', () => {
    const positions = new Set(
      Array.from({ length: 12 }, (_, slot) => {
        const style = safeDriftStyle(`watcher-${slot}`, slot, 12, options());
        return `${style['--left']}/${style['--top']}`;
      }),
    );
    expect(positions.size).toBe(12);
  });
});

describe('chooseWatchers', () => {
  const people = [
    watcher('JustSpoke', { lastSpokeAt: new Date(NOW - 60_000).toISOString() }),
    watcher('SpokeAgesAgo', { lastSpokeAt: new Date(NOW - 40 * 60_000).toISOString() }),
    watcher('NeverSpoke', { lastSpokeAt: null }),
    watcher('Member', { member: true, emote: 'catJAM', lastSpokeAt: null }),
  ];

  it('draws only people inside the window by default', () => {
    // A watching change is only seen when somebody speaks, so these are the
    // people whose embed is actually known.
    expect(chooseWatchers(people, options(), NOW).map((one) => one.nick)).toEqual(['JustSpoke']);
  });

  it('draws everybody when asked, silent or not', () => {
    expect(chooseWatchers(people, options({ show: 'all' }), NOW)).toHaveLength(4);
  });

  it('draws only people with an account in the room when asked', () => {
    expect(chooseWatchers(people, options({ show: 'members' }), NOW).map((one) => one.nick)).toEqual(
      ['Member'],
    );
  });

  it('never draws more than the source asked for', () => {
    expect(chooseWatchers(people, options({ show: 'all', max: 2 }), NOW)).toHaveLength(2);
  });

  it('keeps drawing whoever is already on screen', () => {
    // The snapshot is ordered by who spoke last, so without this a busy chat
    // swaps most of the overlay every couple of seconds: measured at three to
    // ten of twenty-four slots a second, the same people leaving and returning.
    const crowd = [
      watcher('Newcomer', { lastSpokeAt: new Date(NOW - 1_000).toISOString() }),
      watcher('Older', { lastSpokeAt: new Date(NOW - 30_000).toISOString() }),
    ];
    const drawn = chooseWatchers(crowd, options({ max: 1 }), NOW, ['Older']);
    expect(drawn.map((one) => one.nick)).toEqual(['Older']);
  });

  it('gives a free slot to the most recent newcomer', () => {
    const crowd = [
      watcher('Newcomer', { lastSpokeAt: new Date(NOW - 1_000).toISOString() }),
      watcher('Older', { lastSpokeAt: new Date(NOW - 30_000).toISOString() }),
    ];
    const drawn = chooseWatchers(crowd, options({ max: 2 }), NOW, ['Older']);
    expect(drawn.map((one) => one.nick)).toEqual(['Older', 'Newcomer']);
  });

  it('lets somebody go once they no longer qualify', () => {
    const crowd = [watcher('Stale', { lastSpokeAt: new Date(NOW - 40 * 60_000).toISOString() })];
    expect(chooseWatchers(crowd, options(), NOW, ['Stale'])).toEqual([]);
  });
});

describe('entranceFor', () => {
  it('uses what the source asked for', () => {
    expect(entranceFor('anyone', 'spin')).toBe('spin');
    expect(entranceFor('anyone', 'slide')).toBe('slide');
  });

  it('gives somebody the same entrance every time when asked for a mix', () => {
    expect(entranceFor('anpan', 'random')).toBe(entranceFor('anpan', 'random'));
  });

  it('does not give everybody the same one', () => {
    const picked = new Set(
      ['anpan', 'Strumpling', 'x35', 'Vlad_the_Impaler', 'Evelynn', 'sew', 'D0lan'].map((nick) =>
        entranceFor(nick, 'random'),
      ),
    );
    expect(picked.size).toBeGreaterThan(1);
  });
});

describe('driftStyle', () => {
  it('puts somebody in the same place every time, so nobody jumps', () => {
    expect(driftStyle('Vlad_the_Impaler', options())).toEqual(
      driftStyle('Vlad_the_Impaler', options()),
    );
  });

  it('does not stack everybody in one spot', () => {
    expect(driftStyle('anpan', options())).not.toEqual(driftStyle('Strumpling', options()));
  });

  it('keeps everybody inside the frame', () => {
    for (const nick of ['a', 'anpan', 'Vlad_the_Impaler', 'x35', 'INCELDEMONGODPRINCE']) {
      const style = driftStyle(nick, options());
      expect(Number.parseFloat(style['--left'])).toBeLessThan(90);
      expect(Number.parseFloat(style['--top'])).toBeLessThan(82);
    }
  });
});

describe('speed and edge inset', () => {
  const milliseconds = (style: Record<string, string>) =>
    Number.parseFloat(style['--duration']);

  it('takes half as long at twice the speed', () => {
    const normal = milliseconds(driftStyle('anpan', options()));
    const quick = milliseconds(driftStyle('anpan', options({ speed: 200 })));
    expect(quick).toBeCloseTo(normal / 2, 0);
  });

  it('scales every layout the same way', () => {
    const normal = milliseconds(safeDriftStyle('anpan', 0, 12, options()));
    const slow = milliseconds(safeDriftStyle('anpan', 0, 12, options({ speed: 50 })));
    expect(slow).toBeCloseTo(normal * 2, 0);
  });

  it('keeps a floating watcher out of the margin it was told to leave', () => {
    for (const nick of ['a', 'anpan', 'Vlad_the_Impaler', 'x35', 'INCELDEMONGODPRINCE']) {
      const style = driftStyle(nick, options({ inset: 20 }));
      expect(Number.parseFloat(style['--left'])).toBeGreaterThanOrEqual(20);
      expect(Number.parseFloat(style['--top'])).toBeGreaterThanOrEqual(20);
      expect(Number.parseFloat(style['--left'])).toBeLessThanOrEqual(80);
      expect(Number.parseFloat(style['--top'])).toBeLessThanOrEqual(80);
    }
  });

  it('moves the seats of the safe frame in with the inset', () => {
    const near = safeDriftStyle('anpan', 2, 12, options({ inset: 2 }));
    const far = safeDriftStyle('anpan', 2, 12, options({ inset: 15 }));
    expect(Number.parseFloat(near['--left'])).toBeLessThan(Number.parseFloat(far['--left']));
  });
});

describe('mergeRendered', () => {
  it('keeps drawing whoever is still there', () => {
    const people = [watcher('One'), watcher('Two')];
    const rendered = mergeRendered([], people, NOW);
    expect(rendered.map((entry) => entry.watcher.nick)).toEqual(['One', 'Two']);
    expect(rendered.every((entry) => entry.leavingSince === null)).toBe(true);
  });

  it('holds somebody who has gone, so they fade instead of popping', () => {
    // show=speakers is a moving window: people stop being drawn mid-stream the
    // moment their last message ages out of it.
    const before = mergeRendered([], [watcher('One'), watcher('Two')], NOW);
    const after = mergeRendered(before, [watcher('One')], NOW);
    expect(after.map((entry) => entry.watcher.nick)).toEqual(['One', 'Two']);
    expect(after[1].leavingSince).toBe(NOW);
  });

  it('drops them once the fade has finished', () => {
    const before = mergeRendered([], [watcher('One'), watcher('Two')], NOW);
    const leaving = mergeRendered(before, [watcher('One')], NOW);
    const gone = mergeRendered(leaving, [watcher('One')], NOW + LEAVE_MS);
    expect(gone.map((entry) => entry.watcher.nick)).toEqual(['One']);
  });

  it('draws somebody who comes back mid-fade as present again', () => {
    const before = mergeRendered([], [watcher('One')], NOW);
    const leaving = mergeRendered(before, [], NOW);
    const back = mergeRendered(leaving, [watcher('One')], NOW + 100);
    expect(back).toHaveLength(1);
    expect(back[0].leavingSince).toBeNull();
  });
});

describe('WatchersOverlay', () => {
  function render(): string {
    return renderToStaticMarkup(createElement(WatchersOverlay, { apiUrl: 'http://api.test' }));
  }

  it('draws a member as their own emote, and everyone else as the stand-in', () => {
    state.snapshot = {
      channel: { platform: 'kick', id: 'dggjams' },
      live: true,
      siteCount: 2,
      chatCount: 2,
      watchers: [
        watcher('Member', { member: true, emote: 'catJAM', flair: 'flair13' }),
        watcher('Stranger'),
      ],
    };

    const markup = render();
    expect(markup).toContain('class="emote catJAM"');
    expect(markup).toContain('class="emote MMMM"');
    // The name is coloured the way chat colours it, with no sign-in involved.
    expect(markup).toContain('watcher-name flair-flair13');
    expect(markup).toContain('Stranger');
  });

  it('draws what somebody just said over what their account says', () => {
    state.snapshot = {
      channel: { platform: 'kick', id: 'dggjams' },
      live: true,
      siteCount: 1,
      chatCount: 1,
      watchers: [watcher('Member', { member: true, emote: 'Listening', lastEmote: 'catJAM' })],
    };

    expect(render()).toContain('class="emote catJAM"');
  });

  it('renders the defaults first however the source is configured', () => {
    // The page is prerendered, so the first render has to match a server that
    // never saw the query string. Reading it during render instead left the
    // container as `watchers-float` while its children were built for a row,
    // and React kept the server's class: every watcher stacked in the top left
    // corner. The URL is applied in an effect, which this render never runs.
    vi.stubGlobal('window', { location: { search: '?names=off&layout=climb' } });
    state.snapshot = {
      channel: { platform: 'kick', id: 'dggjams' },
      live: true,
      siteCount: 1,
      chatCount: 1,
      watchers: [watcher('Stranger')],
    };

    const markup = render();
    expect(markup).toContain('watchers-float');
    expect(markup).not.toContain('watchers-climb');
    expect(markup).toContain('Stranger');
  });

  it('renders an empty frame while nothing is being watched', () => {
    expect(render()).toBe(
      '<div class="watchers watchers-float watchers-names-under watchers-motion-drift"' +
        ' style="--roam:1;--size:1"></div>',
    );
  });
});
