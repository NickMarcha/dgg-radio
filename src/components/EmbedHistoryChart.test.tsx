import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StreamWatchHistory, StreamWatchSample } from '../shared/contracts';
import {
  assignSeriesColors,
  EmbedHistoryChart,
  EmbedHistoryTable,
  gapFor,
  groupWatchSamples,
  isolatedPoints,
  seriesPoints,
} from './EmbedHistoryChart';

function sample(sampledAt: string, overrides: Partial<StreamWatchSample> = {}): StreamWatchSample {
  return {
    sampledAt,
    platform: 'kick',
    channel: 'destiny',
    siteCount: 40,
    ...overrides,
  };
}

function history(overrides: Partial<StreamWatchHistory> = {}): StreamWatchHistory {
  return {
    from: '2026-09-05T12:00:00.000Z',
    to: '2026-09-05T13:00:00.000Z',
    bucketMinutes: 1,
    samples: [],
    other: [],
    otherChannels: 0,
    channels: [],
    ...overrides,
  };
}

const WINDOW = { from: '2026-09-05T12:00:00.000Z', to: '2026-09-05T13:00:00.000Z' };

describe('embed history chart', () => {
  it('groups samples by the channel stored on each row', () => {
    const groups = groupWatchSamples([
      sample('2026-09-05T12:00:00.000Z'),
      sample('2026-09-05T12:01:00.000Z', { channel: 'dggjams' }),
      sample('2026-09-05T12:02:00.000Z'),
    ]);

    expect(groups.map((group) => [group.key, group.samples.length])).toEqual([
      ['kick/destiny', 2],
      ['kick/dggjams', 1],
    ]);
  });

  it('breaks a line across the minutes nobody was watching', () => {
    const points = seriesPoints(
      [
        sample('2026-09-05T12:00:00.000Z'),
        sample('2026-09-05T12:01:00.000Z'),
        sample('2026-09-05T12:05:00.000Z'),
      ],
      gapFor(1),
    );

    // A minute with no row is a minute the site did not list the channel, and
    // that is a break rather than a measured zero.
    expect(points.filter((point) => point.value === null)).toHaveLength(1);
    // The reading after the break has nothing after it to join it to either.
    expect(isolatedPoints(points).map((point) => point.value)).toEqual([40]);
  });

  it('still joins points that are one bucket apart', () => {
    // A week is grouped into half-hour buckets. A gap rule written for
    // one-minute samples would call every one of those a break and draw a
    // chart of isolated dots.
    const points = seriesPoints(
      [
        sample('2026-09-05T00:00:00.000Z'),
        sample('2026-09-05T00:30:00.000Z'),
        sample('2026-09-05T01:00:00.000Z'),
      ],
      gapFor(30),
    );

    expect(points.every((point) => point.value !== null)).toBe(true);
    expect(isolatedPoints(points)).toHaveLength(0);
  });

  it('draws one line per channel, and only one', () => {
    const two = history({
      channels: ['kick/destiny', 'youtube/another-channel'],
      samples: [
        sample('2026-09-05T12:59:00.000Z'),
        sample('2026-09-05T12:59:00.000Z', {
          platform: 'youtube',
          channel: 'another-channel',
          siteCount: 7,
        }),
      ],
    });

    const markup = renderToStaticMarkup(<EmbedHistoryChart window={WINDOW} history={two} />);
    expect(markup).toContain('kick/destiny');
    expect(markup).toContain('youtube/another-channel');
    // One number per channel: who was in chat with an embed is a live thing the
    // overlay draws, never something this chart has stored to draw.
    expect(markup).not.toContain('in chat');
    // Two channels, two keys in the legend: no channel brings a second line.
    expect(markup.match(/embed-chart-key/g)).toHaveLength(2);
  });

  it('carries the same figures in the table as on the chart', () => {
    const quiet = history({
      channels: ['kick/zugami'],
      samples: [sample('2026-09-05T12:59:00.000Z', { channel: 'zugami', siteCount: 56 })],
    });

    expect(renderToStaticMarkup(<EmbedHistoryChart window={WINDOW} history={quiet} />)).toContain(
      'kick/zugami',
    );
    expect(renderToStaticMarkup(<EmbedHistoryTable history={quiet} />)).toContain('<td>56</td>');
  });
});

describe('choosing what is on the chart', () => {
  it('gives a channel the same colour whatever else is drawn', () => {
    // Changing the window or the choice is a filter, and a filter must not
    // repaint the lines that survive it. So the colour comes from the name.
    const busy = assignSeriesColors(['kick/destiny', 'kick/zugami', 'youtube/abc']);
    const quiet = assignSeriesColors(['kick/destiny', 'youtube/abc']);

    expect(quiet.get('kick/destiny')).toBe(busy.get('kick/destiny'));
    expect(quiet.get('youtube/abc')).toBe(busy.get('youtube/abc'));
  });

  it('lets a channel keep its colour when the one beside it is switched off', () => {
    // Eight hues and any number of channels means collisions, and resolving one
    // by taking the next free hue used to make the answer depend on who else
    // was drawn — so switching a channel off repainted its neighbours. With a
    // picker beside the chart that is the main thing anybody does.
    const keys = Array.from({ length: 8 }, (_, index) => `kick/channel${index}`);
    const all = assignSeriesColors(keys);
    const fewer = assignSeriesColors(
      keys.filter((key) => key !== 'kick/channel3'),
      all,
    );

    for (const key of keys) {
      if (key === 'kick/channel3') continue;
      expect(fewer.get(key)).toBe(all.get(key));
    }

    // And the hue it gave up is free for whoever is drawn next.
    const replaced = assignSeriesColors(
      [...keys.filter((key) => key !== 'kick/channel3'), 'kick/newcomer'],
      fewer,
    );
    expect(replaced.get('kick/newcomer')).toBe(all.get('kick/channel3'));
    expect(new Set(replaced.values()).size).toBe(8);
  });

  it('never gives two channels the same colour', () => {
    const keys = Array.from({ length: 8 }, (_, index) => `kick/channel${index}`);
    const colors = assignSeriesColors(keys);

    expect(new Set(colors.values()).size).toBe(8);
  });

  it('keeps a chosen channel on the chart through a window with nothing in it', () => {
    // Asking for a channel and being shown no line at all is an answer. Drawing
    // somebody else's line in its place, because the colours were assigned over
    // what came back, would be a wrong one.
    const empty = history({ channels: ['kick/quiet'], samples: [] });

    expect(renderToStaticMarkup(<EmbedHistoryChart window={WINDOW} history={empty} />)).toContain(
      'kick/quiet',
    );
    expect(renderToStaticMarkup(<EmbedHistoryTable history={empty} />)).toContain('not listed');
  });

  it('draws everything not chosen as one line, and says how many', () => {
    const crowded = history({
      bucketMinutes: 5,
      channels: ['kick/destiny'],
      samples: [sample('2026-09-05T12:00:00.000Z'), sample('2026-09-05T12:05:00.000Z')],
      other: [
        { sampledAt: '2026-09-05T12:00:00.000Z', siteCount: 90 },
        { sampledAt: '2026-09-05T12:05:00.000Z', siteCount: 120 },
      ],
      otherChannels: 214,
    });

    expect(renderToStaticMarkup(<EmbedHistoryChart window={WINDOW} history={crowded} />)).toContain(
      '214 other channels, together',
    );
    // And the table carries the same figures for anyone the colours do not reach.
    expect(renderToStaticMarkup(<EmbedHistoryTable history={crowded} />)).toContain('<td>120</td>');
  });

  it('draws no table at all for a window that measured nothing', () => {
    // The strip that brushed an empty window is rendered beside this rather
    // than inside it, so an empty table is nothing to say rather than a trap.
    expect(renderToStaticMarkup(<EmbedHistoryTable history={history()} />)).toBe('');
  });

  it('says so when the window holds nothing at all', () => {
    const markup = renderToStaticMarkup(
      <EmbedHistoryChart window={WINDOW} history={history()} />,
    );

    expect(markup).toContain('No embeds were recorded in this window.');
  });
});
