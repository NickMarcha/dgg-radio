import { useId, useState } from 'react';
import type { StreamWatchHistory, StreamWatchSample } from '../shared/contracts';
import './StreamWatchChart.css';

const WIDTH = 720;
const HEIGHT = 260;
const LEFT = 46;
const RIGHT = 12;
const TOP = 12;
const BOTTOM = 28;

/**
 * One chart with every channel on it, rather than one chart each. A week of the
 * site is hundreds of channels; as separate charts that is a page nobody
 * scrolls, and the question worth asking — who was watched, and when, against
 * everybody else — only has an answer when the lines share an axis.
 *
 * The eight hues are a categorical palette stepped for this dark surface, in a
 * fixed order, checked against `#1f2023` for lightness, chroma, contrast and
 * colour-vision separation. Eight is the limit of what can be told apart, which
 * is why the server sums the rest into one line rather than reaching for a
 * ninth colour.
 */
const SERIES_COLORS = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const;

type WatchMetric = 'siteCount' | 'chatCount';

export interface WatchTargetSamples {
  key: string;
  samples: StreamWatchSample[];
}

export interface WatchChartPoint {
  x: number;
  y: number;
  value: number;
}

export interface WatchChartSeries {
  paths: string[];
  isolated: WatchChartPoint[];
  last: WatchChartPoint | null;
}

/** Keep targets separate, so changing the admin setting never joins two streams. */
export function groupWatchSamples(samples: StreamWatchSample[]): WatchTargetSamples[] {
  const groups = new Map<string, WatchTargetSamples>();
  for (const sample of samples) {
    const key = `${sample.platform}/${sample.channel}`;
    const group = groups.get(key) ?? {
      key,
      samples: [],
    };
    group.samples.push(sample);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function hashKey(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/**
 * A colour per channel, taken from the channel's own name rather than from
 * where it came in this period's ranking. Picking by rank would repaint every
 * surviving line whenever the period changed or a channel went quiet, which is
 * the one thing a colour must not do. Two names wanting the same hue is settled
 * by taking the next free one in a fixed order, so the answer never depends on
 * which of them was busier.
 */
export function assignSeriesColors(keys: string[]): Map<string, string> {
  const colors = new Map<string, string>();
  const taken = new Set<number>();

  for (const key of [...keys].sort()) {
    const first = hashKey(key) % SERIES_COLORS.length;
    for (let offset = 0; offset < SERIES_COLORS.length; offset += 1) {
      const slot = (first + offset) % SERIES_COLORS.length;
      if (taken.has(slot)) continue;
      taken.add(slot);
      colors.set(key, SERIES_COLORS[slot]);
      break;
    }
  }

  return colors;
}

/**
 * How far apart two readings may be and still be joined by a line. It follows
 * the width of a stored point rather than being fixed: a week is grouped into
 * half-hour buckets, and a rule written for one-minute samples would leave
 * every point of that stranded on its own.
 */
function gapFor(bucketMinutes: number): number {
  return Math.max(1, bucketMinutes) * 90_000;
}

function pointFor(
  sample: { sampledAt: string },
  value: number,
  from: number,
  to: number,
  ceiling: number,
): WatchChartPoint {
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const duration = Math.max(1, to - from);
  return {
    x: LEFT + ((new Date(sample.sampledAt).getTime() - from) / duration) * plotWidth,
    y: TOP + (1 - value / ceiling) * plotHeight,
    value,
  };
}

export function buildWatchChartSeries(
  samples: StreamWatchSample[],
  metric: WatchMetric,
  from: number,
  to: number,
  ceiling: number,
  gapMs: number,
): WatchChartSeries {
  const segments: WatchChartPoint[][] = [];
  let segment: WatchChartPoint[] = [];
  let previousAt: number | null = null;

  const finish = () => {
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };

  for (const sample of samples) {
    const at = new Date(sample.sampledAt).getTime();
    const value = sample[metric];
    if (value === null || !Number.isFinite(at)) {
      finish();
      previousAt = null;
      continue;
    }
    if (previousAt !== null && at - previousAt > gapMs) finish();
    segment.push(pointFor(sample, value, from, to, ceiling));
    previousAt = at;
  }
  finish();

  const points = segments.flat();
  return {
    paths: segments
      .filter((part) => part.length > 1)
      .map((part) =>
        part
          .map((point, index) =>
            `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
          )
          .join(' '),
      ),
    isolated: segments.filter((part) => part.length === 1).flat(),
    last: points.at(-1) ?? null,
  };
}

function axisCeiling(history: StreamWatchHistory): number {
  const largest = Math.max(
    0,
    ...history.samples.flatMap((sample) => [sample.siteCount ?? 0, sample.chatCount ?? 0]),
    ...history.other.map((point) => point.siteCount),
  );
  return Math.max(10, Math.ceil(largest / 10) * 10);
}

function axisTime(iso: string, durationMs: number): string {
  const date = new Date(iso);
  return durationMs >= 24 * 60 * 60 * 1_000
    ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' })
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface DrawnLine {
  key: string;
  label: string;
  color: string;
  /** The followed channel's chat roster, drawn dashed in that channel's colour. */
  dashed: boolean;
  peak: number;
  latest: number | null;
  series: WatchChartSeries;
  /** By bucket, so the crosshair reads a value without walking the samples. */
  values: Map<string, number>;
}

function valuesByBucket(
  samples: StreamWatchSample[],
  metric: WatchMetric,
): Map<string, number> {
  const values = new Map<string, number>();
  for (const sample of samples) {
    const value = sample[metric];
    if (value !== null) values.set(sample.sampledAt, value);
  }
  return values;
}

function peakOf(samples: StreamWatchSample[], metric: WatchMetric): number {
  return Math.max(0, ...samples.map((sample) => sample[metric] ?? 0));
}

/** Every line the chart draws, in the order the legend and the table list them. */
export function drawnLines(
  history: StreamWatchHistory,
  from: number,
  to: number,
  ceiling: number,
  gap: number,
): DrawnLine[] {
  const targets = groupWatchSamples(history.samples);
  const colors = assignSeriesColors(targets.map((target) => target.key));
  const lines: DrawnLine[] = [];

  for (const target of targets) {
    const color = colors.get(target.key) ?? SERIES_COLORS[0];
    lines.push({
      key: target.key,
      label: target.key,
      color,
      dashed: false,
      peak: peakOf(target.samples, 'siteCount'),
      latest: target.samples.at(-1)?.siteCount ?? null,
      series: buildWatchChartSeries(target.samples, 'siteCount', from, to, ceiling, gap),
      values: valuesByBucket(target.samples, 'siteCount'),
    });

    // Only the followed channel has a roster behind it, so this is one more
    // line on the chart rather than one more per channel.
    if (target.samples.some((sample) => sample.chatCount !== null)) {
      lines.push({
        key: `${target.key} chat`,
        label: `${target.key} · in chat`,
        color,
        dashed: true,
        peak: peakOf(target.samples, 'chatCount'),
        latest: target.samples.at(-1)?.chatCount ?? null,
        series: buildWatchChartSeries(target.samples, 'chatCount', from, to, ceiling, gap),
        values: valuesByBucket(target.samples, 'chatCount'),
      });
    }
  }

  if (history.other.length > 0) {
    const samples: StreamWatchSample[] = history.other.map((point) => ({
      sampledAt: point.sampledAt,
      platform: 'other',
      channel: 'other',
      siteCount: point.siteCount,
      chatCount: null,
    }));
    const plural = history.otherChannels === 1 ? 'channel' : 'channels';
    lines.push({
      key: 'other',
      label: `${history.otherChannels} other ${plural}, together`,
      color: 'var(--faint)',
      dashed: false,
      peak: peakOf(samples, 'siteCount'),
      latest: samples.at(-1)?.siteCount ?? null,
      series: buildWatchChartSeries(samples, 'siteCount', from, to, ceiling, gap),
      values: valuesByBucket(samples, 'siteCount'),
    });
  }

  return lines;
}

function LineKey({ line }: { line: DrawnLine }) {
  return (
    <i
      className={line.dashed ? 'admin-watch-key admin-watch-key-dashed' : 'admin-watch-key'}
      style={{ color: line.color }}
      aria-hidden="true"
    />
  );
}

export function StreamWatchChart({ history }: { history: StreamWatchHistory }) {
  const titleId = useId();
  const descriptionId = useId();
  const [reading, setReading] = useState<string | null>(null);

  const from = new Date(history.from).getTime();
  const to = new Date(history.to).getTime();
  const ceiling = axisCeiling(history);
  const lines = drawnLines(history, from, to, ceiling, gapFor(history.bucketMinutes));

  if (lines.length === 0) {
    return <p className="admin-empty">No embeds were recorded in this period.</p>;
  }

  const buckets = [...new Set(lines.flatMap((line) => [...line.values.keys()]))].sort();
  const plotBottom = HEIGHT - BOTTOM;
  const plotRight = WIDTH - RIGHT;
  const duration = to - from;
  const readingX =
    reading === null ? null : pointFor({ sampledAt: reading }, 0, from, to, ceiling).x;

  const readAt = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || buckets.length === 0) return;
    const wanted = from + (((event.clientX - box.left) / box.width) * WIDTH - LEFT) /
      Math.max(1, WIDTH - LEFT - RIGHT) * duration;
    let closest = buckets[0];
    for (const bucket of buckets) {
      const distance = Math.abs(new Date(bucket).getTime() - wanted);
      if (distance < Math.abs(new Date(closest).getTime() - wanted)) closest = bucket;
    }
    setReading(closest);
  };

  return (
    <figure className="admin-watch-chart">
      <div className="admin-watch-legend" aria-label="Channels on the chart">
        {lines.map((line) => (
          <span key={line.key}>
            <LineKey line={line} />
            {line.label}
          </span>
        ))}
      </div>

      <div className="admin-watch-chart-scroll">
        <div className="admin-watch-plot">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-labelledby={`${titleId} ${descriptionId}`}
            onPointerMove={readAt}
            onPointerLeave={() => setReading(null)}
          >
            <title id={titleId}>Embeds open on destiny.gg, by channel</title>
            <desc id={descriptionId}>
              Every channel on one axis between {history.from} and {history.to}. The same
              figures are in the table below.
            </desc>

            {[ceiling, ceiling / 2, 0].map((value) => {
              const y = TOP + (1 - value / ceiling) * (HEIGHT - TOP - BOTTOM);
              return (
                <g key={value} className="admin-watch-grid" aria-hidden="true">
                  <line x1={LEFT} x2={plotRight} y1={y} y2={y} />
                  <text x={LEFT - 7} y={y + 4} textAnchor="end">
                    {value}
                  </text>
                </g>
              );
            })}

            <g className="admin-watch-axis" aria-hidden="true">
              <text x={LEFT} y={HEIGHT - 7} textAnchor="start">
                {axisTime(history.from, duration)}
              </text>
              <text x={plotRight} y={HEIGHT - 7} textAnchor="end">
                {axisTime(history.to, duration)}
              </text>
            </g>

            {readingX !== null && (
              <line
                className="admin-watch-crosshair"
                x1={readingX}
                x2={readingX}
                y1={TOP}
                y2={plotBottom}
                aria-hidden="true"
              />
            )}

            {lines.map((line) => (
              <g key={line.key} style={{ color: line.color }}>
                {line.series.paths.map((path) => (
                  <path
                    key={path}
                    className={
                      line.dashed ? 'admin-watch-line admin-watch-line-dashed' : 'admin-watch-line'
                    }
                    d={path}
                  />
                ))}
                {line.series.isolated.map((point) => (
                  <circle
                    key={`${point.x}-${point.y}`}
                    className="admin-watch-point"
                    cx={point.x}
                    cy={point.y}
                    r="2.5"
                  />
                ))}
                {line.series.last && (
                  <circle
                    className="admin-watch-point"
                    cx={line.series.last.x}
                    cy={line.series.last.y}
                    r="3"
                  />
                )}
              </g>
            ))}

            <line
              className="admin-watch-baseline"
              x1={LEFT}
              x2={plotRight}
              y1={plotBottom}
              y2={plotBottom}
              aria-hidden="true"
            />
          </svg>

          {reading !== null && readingX !== null && (
            <div
              className="admin-watch-tooltip"
              style={{
                left: `${((readingX / WIDTH) * 100).toFixed(2)}%`,
                transform: readingX > WIDTH / 2 ? 'translateX(-100%)' : undefined,
              }}
            >
              <strong>{new Date(reading).toLocaleString()}</strong>
              {lines
                .filter((line) => line.values.has(reading))
                .sort(
                  (left, right) =>
                    (right.values.get(reading) ?? 0) - (left.values.get(reading) ?? 0),
                )
                .map((line) => (
                  <span key={line.key}>
                    <LineKey line={line} />
                    {line.label}
                    <b>{line.values.get(reading)}</b>
                  </span>
                ))}
            </div>
          )}
        </div>
      </div>

      <figcaption>
        <table className="admin-watch-table">
          <caption>Peak and latest reading for every line drawn.</caption>
          <thead>
            <tr>
              <th scope="col">Channel</th>
              <th scope="col">Peak</th>
              <th scope="col">Latest</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.key}>
                <th scope="row">
                  <LineKey line={line} />
                  {line.label}
                </th>
                <td>{line.peak}</td>
                <td>{line.latest === null ? 'not listed' : line.latest}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}
