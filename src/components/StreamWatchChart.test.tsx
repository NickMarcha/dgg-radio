import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StreamWatchHistory, StreamWatchSample } from '../shared/contracts';
import {
  assignSeriesColors,
  buildWatchChartSeries,
  groupWatchSamples,
  StreamWatchChart,
} from './StreamWatchChart';

function sample(
  sampledAt: string,
  overrides: Partial<StreamWatchSample> = {},
): StreamWatchSample {
  return {
    sampledAt,
    platform: 'kick',
    channel: 'destiny',
    siteCount: 40,
    chatCount: 42,
    ...overrides,
  };
}

describe('watcher history chart', () => {
  it('groups samples by the target stored on each row', () => {
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

  it('breaks a line across missing source values and missing minutes', () => {
    const from = new Date('2026-09-05T12:00:00.000Z').getTime();
    const to = new Date('2026-09-05T12:10:00.000Z').getTime();
    const source = buildWatchChartSeries(
      [
        sample('2026-09-05T12:00:00.000Z'),
        sample('2026-09-05T12:01:00.000Z'),
        sample('2026-09-05T12:02:00.000Z', { siteCount: null }),
        sample('2026-09-05T12:05:00.000Z'),
      ],
      'siteCount',
      from,
      to,
      50,
      90_000,
    );

    expect(source.paths).toHaveLength(1);
    expect(source.isolated).toHaveLength(1);
    expect(source.last?.value).toBe(40);
  });

  it('labels each target and both measured counts', () => {
    const history: StreamWatchHistory = {
      from: '2026-09-05T12:00:00.000Z',
      to: '2026-09-05T13:00:00.000Z',
      bucketMinutes: 1,
      other: [],
      otherChannels: 0,
      samples: [
        sample('2026-09-05T12:59:00.000Z'),
        sample('2026-09-05T12:59:00.000Z', {
          platform: 'youtube',
          channel: 'another-channel',
          siteCount: null,
          chatCount: 0,
        }),
      ],
    };

    const markup = renderToStaticMarkup(<StreamWatchChart history={history} />);
    expect(markup).toContain('kick/destiny');
    expect(markup).toContain('youtube/another-channel');
    // The roster is a second line for the same channel, in the same colour.
    expect(markup).toContain('kick/destiny · in chat');
  });
});

describe('a period stored in coarser buckets', () => {
  it('still joins points that are one bucket apart', () => {
    // A week is grouped into half-hour buckets. A gap rule written for
    // one-minute samples would call every one of those a break and draw a
    // chart of isolated dots.
    const from = new Date('2026-09-05T00:00:00.000Z').getTime();
    const to = new Date('2026-09-05T02:00:00.000Z').getTime();
    const series = buildWatchChartSeries(
      [
        sample('2026-09-05T00:00:00.000Z'),
        sample('2026-09-05T00:30:00.000Z'),
        sample('2026-09-05T01:00:00.000Z'),
      ],
      'siteCount',
      from,
      to,
      50,
      30 * 90_000,
    );

    expect(series.paths).toHaveLength(1);
    expect(series.isolated).toHaveLength(0);
  });

  it('says only what it knows for a channel with no roster behind it', () => {
    const history: StreamWatchHistory = {
      from: '2026-09-05T12:00:00.000Z',
      to: '2026-09-05T13:00:00.000Z',
      bucketMinutes: 1,
      other: [],
      otherChannels: 0,
      samples: [
        sample('2026-09-05T12:59:00.000Z', {
          channel: 'zugami',
          siteCount: 56,
          chatCount: null,
        }),
      ],
    };

    const markup = renderToStaticMarkup(<StreamWatchChart history={history} />);
    expect(markup).toContain('kick/zugami');
    expect(markup).toContain('<td>56</td>');
    // Nobody but the followed channel has a roster, so nobody else gets that line.
    expect(markup).not.toContain('· in chat');
  });
});

describe('one chart with every channel on it', () => {
  it('gives a channel the same colour whatever else is drawn', () => {
    // A period change is a filter, and a filter must not repaint the lines that
    // survive it. So the colour comes from the channel's own name.
    const busy = assignSeriesColors(['kick/destiny', 'kick/zugami', 'youtube/abc']);
    const quiet = assignSeriesColors(['kick/destiny', 'youtube/abc']);

    expect(quiet.get('kick/destiny')).toBe(busy.get('kick/destiny'));
    expect(quiet.get('youtube/abc')).toBe(busy.get('youtube/abc'));
  });

  it('never gives two channels the same colour', () => {
    const keys = Array.from({ length: 8 }, (_, index) => `kick/channel${index}`);
    const colors = assignSeriesColors(keys);

    expect(new Set(colors.values()).size).toBe(8);
  });

  it('draws everything not worth its own line as one line, and says how many', () => {
    const history: StreamWatchHistory = {
      from: '2026-09-05T12:00:00.000Z',
      to: '2026-09-05T13:00:00.000Z',
      bucketMinutes: 5,
      samples: [sample('2026-09-05T12:00:00.000Z'), sample('2026-09-05T12:05:00.000Z')],
      other: [
        { sampledAt: '2026-09-05T12:00:00.000Z', siteCount: 90 },
        { sampledAt: '2026-09-05T12:05:00.000Z', siteCount: 120 },
      ],
      otherChannels: 214,
    };

    const markup = renderToStaticMarkup(<StreamWatchChart history={history} />);
    expect(markup).toContain('214 other channels, together');
    // And the table carries the same figures for anyone the colours do not reach.
    expect(markup).toContain('<td>120</td>');
  });

  it('says so when the period holds nothing at all', () => {
    const markup = renderToStaticMarkup(
      <StreamWatchChart
        history={{
          from: '2026-09-05T12:00:00.000Z',
          to: '2026-09-05T13:00:00.000Z',
          bucketMinutes: 5,
          samples: [],
          other: [],
          otherChannels: 0,
        }}
      />,
    );
    expect(markup).toContain('No embeds were recorded in this period.');
  });
});
