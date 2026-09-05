import { useId } from 'react';
import type { StreamWatchHistory, StreamWatchSample } from '../shared/contracts';
import './StreamWatchChart.css';

const WIDTH = 720;
const HEIGHT = 220;
const LEFT = 42;
const RIGHT = 12;
const TOP = 12;
const BOTTOM = 28;
/**
 * How far apart two readings may be and still be joined by a line. It follows
 * the width of a stored point rather than being fixed: a week is grouped into
 * half-hour buckets, and a rule written for one-minute samples would leave
 * every point of that stranded on its own.
 */
function gapFor(bucketMinutes: number): number {
  return Math.max(1, bucketMinutes) * 90_000;
}

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

function pointFor(
  sample: StreamWatchSample,
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

/** Null source counts and missing minutes break a line instead of inventing data. */
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

function axisCeiling(samples: StreamWatchSample[]): number {
  const largest = Math.max(
    0,
    ...samples.flatMap((sample) => [sample.siteCount ?? 0, sample.chatCount ?? 0]),
  );
  return Math.max(10, Math.ceil(largest / 10) * 10);
}

function axisTime(iso: string, durationMs: number): string {
  const date = new Date(iso);
  return durationMs >= 24 * 60 * 60 * 1_000
    ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' })
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function latestText(sample: StreamWatchSample): string {
  const open = sample.siteCount === null ? 'not listed' : `${sample.siteCount} open`;
  // Only the followed channel has a roster behind it. For everybody else the
  // site's own count is the whole of what is known, and saying so is better
  // than printing a zero nobody counted.
  return sample.chatCount === null
    ? open
    : `${open}, ${sample.chatCount} in the chat roster`;
}

function WatchTargetChart({
  target,
  history,
}: {
  target: WatchTargetSamples;
  history: StreamWatchHistory;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const from = new Date(history.from).getTime();
  const to = new Date(history.to).getTime();
  const ceiling = axisCeiling(target.samples);
  const gap = gapFor(history.bucketMinutes);
  const site = buildWatchChartSeries(target.samples, 'siteCount', from, to, ceiling, gap);
  const chat = buildWatchChartSeries(target.samples, 'chatCount', from, to, ceiling, gap);
  const latest = target.samples.at(-1)!;
  const plotBottom = HEIGHT - BOTTOM;
  const plotRight = WIDTH - RIGHT;
  const duration = to - from;

  return (
    <figure className="admin-watch-chart">
      <figcaption>
        <strong>{target.key}</strong>
        <span>
          {target.samples.length} {target.samples.length === 1 ? 'sample' : 'samples'}, latest{' '}
          {latestText(latest)}
        </span>
      </figcaption>
      <div className="admin-watch-chart-scroll">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
        >
          <title id={titleId}>Watcher counts for {target.key}</title>
          <desc id={descriptionId}>
            Open embeds and chatters watching between {history.from} and {history.to}.
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

          {site.paths.map((path) => (
            <path key={path} className="admin-watch-line admin-watch-line-site" d={path} />
          ))}
          {site.isolated.map((point) => (
            <circle
              key={`${point.x}-${point.y}`}
              className="admin-watch-point admin-watch-point-site"
              cx={point.x}
              cy={point.y}
              r="2.5"
            />
          ))}
          {chat.paths.map((path) => (
            <path key={path} className="admin-watch-line admin-watch-line-chat" d={path} />
          ))}
          {chat.isolated.map((point) => (
            <circle
              key={`${point.x}-${point.y}`}
              className="admin-watch-point admin-watch-point-chat"
              cx={point.x}
              cy={point.y}
              r="2.5"
            />
          ))}
          {site.last && (
            <circle
              className="admin-watch-point admin-watch-point-site"
              cx={site.last.x}
              cy={site.last.y}
              r="3"
            />
          )}
          {chat.last && (
            <circle
              className="admin-watch-point admin-watch-point-chat"
              cx={chat.last.x}
              cy={chat.last.y}
              r="3"
            />
          )}
          <line
            className="admin-watch-baseline"
            x1={LEFT}
            x2={plotRight}
            y1={plotBottom}
            y2={plotBottom}
            aria-hidden="true"
          />
        </svg>
      </div>
    </figure>
  );
}

export function StreamWatchChart({ history }: { history: StreamWatchHistory }) {
  const targets = groupWatchSamples(history.samples);
  if (targets.length === 0) {
    return <p className="admin-empty">No watcher samples in this period.</p>;
  }

  return (
    <div className="admin-watch-charts">
      <div className="admin-watch-legend" aria-label="Chart lines">
        <span><i className="admin-watch-key-site" /> Embeds open</span>
        <span><i className="admin-watch-key-chat" /> Chatters watching</span>
      </div>
      {targets.map((target) => (
        <WatchTargetChart key={target.key} target={target} history={history} />
      ))}
    </div>
  );
}
