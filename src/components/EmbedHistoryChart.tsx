import { bisectCenter, brushX, line, pointer, scaleLinear, scaleTime, select } from 'd3';
import type { ScaleLinear, ScaleTime } from 'd3';
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import type { StreamWatchHistory, StreamWatchSample } from '../shared/contracts';
import './EmbedHistoryChart.css';

const WIDTH = 720;
const HEIGHT = 280;
const OVERVIEW_HEIGHT = 74;
const LEFT = 46;
const RIGHT = 12;
const TOP = 12;
const BOTTOM = 28;

/**
 * One chart with every chosen channel on it, rather than one chart each. A week
 * of the site is hundreds of channels; as separate charts that is a page nobody
 * scrolls, and the question worth asking — who was watched, and when, against
 * everybody else — only has an answer when the lines share an axis.
 *
 * The eight hues are a categorical palette stepped for this dark surface, in a
 * fixed order, checked against `#1f2023` for lightness, chroma, contrast and
 * colour-vision separation. Eight is the limit of what can be told apart, which
 * is why a choice of channels is capped there and everything else is summed
 * into one line rather than reaching for a ninth colour.
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

/** The instants a chart is drawn between, which the brush below it chooses. */
export interface TimeWindow {
  from: string;
  to: string;
}

export interface WatchTargetSamples {
  key: string;
  samples: StreamWatchSample[];
}

/** One reading, or a deliberate hole where the line has to break. */
export interface SeriesPoint {
  at: number;
  value: number | null;
}

type TimeScale = ScaleTime<number, number>;
type ValueScale = ScaleLinear<number, number>;

/** Keep channels separate, so changing what is drawn never joins two streams. */
export function groupWatchSamples(samples: StreamWatchSample[]): WatchTargetSamples[] {
  const groups = new Map<string, WatchTargetSamples>();
  for (const sample of samples) {
    const key = `${sample.platform}/${sample.channel}`;
    const group = groups.get(key) ?? { key, samples: [] };
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
 * where it came in this window's ranking. Picking by rank would repaint every
 * surviving line whenever the window moved or a channel was deselected, which
 * is the one thing a colour must not do.
 *
 * A name alone cannot decide it, though, because eight hues and any number of
 * channels means collisions, and resolving one by taking the next free hue
 * makes the answer depend on who else is drawn. That was invisible while the
 * set only changed with the period; with a picker beside the chart it is the
 * main thing somebody does, and a line changing colour as its neighbour is
 * switched off is exactly the fault this was written to avoid. So what is
 * already assigned is kept: `previous` holds it, a channel keeps its hue for
 * as long as it is drawn, and only a hue nobody is using any more is handed on.
 *
 * @param previous what the last call answered, or an empty map to start over.
 */
export function assignSeriesColors(
  keys: string[],
  previous: Map<string, string> = new Map(),
): Map<string, string> {
  const colors = new Map<string, string>();
  const taken = new Set<string>();

  for (const key of keys) {
    const held = previous.get(key);
    if (held === undefined || taken.has(held)) continue;
    colors.set(key, held);
    taken.add(held);
  }

  for (const key of [...keys].sort()) {
    if (colors.has(key)) continue;
    const first = hashKey(key) % SERIES_COLORS.length;
    for (let offset = 0; offset < SERIES_COLORS.length; offset += 1) {
      const color = SERIES_COLORS[(first + offset) % SERIES_COLORS.length];
      if (taken.has(color)) continue;
      taken.add(color);
      colors.set(key, color);
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
export function gapFor(bucketMinutes: number): number {
  return Math.max(1, bucketMinutes) * 90_000;
}

/**
 * The readings of one channel in order, with a null wherever the line has to
 * break — a hole longer than one bucket, which is how a minute nobody was
 * watching is drawn. d3's line generator takes the breaks from `defined`, so a
 * break is a point rather than a second array, and one path carries the whole
 * channel however often it stops.
 */
export function seriesPoints(samples: StreamWatchSample[], gapMs: number): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  let previousAt: number | null = null;

  for (const sample of samples) {
    const at = new Date(sample.sampledAt).getTime();
    if (!Number.isFinite(at)) continue;
    if (previousAt !== null && at - previousAt > gapMs) points.push({ at: previousAt, value: null });
    points.push({ at, value: sample.siteCount });
    previousAt = at;
  }

  return points;
}

/**
 * The readings with nothing drawn either side of them. A line generator has
 * nothing to join, so without this a channel sampled once between two outages
 * would draw as blank chart rather than as the one thing it knows.
 */
export function isolatedPoints(points: SeriesPoint[]): SeriesPoint[] {
  return points.filter(
    (point, index) =>
      point.value !== null &&
      (points[index - 1]?.value ?? null) === null &&
      (points[index + 1]?.value ?? null) === null,
  );
}

interface DrawnLine {
  key: string;
  label: string;
  color: string;
  peak: number;
  latest: number | null;
  points: SeriesPoint[];
  /** By bucket, so the crosshair reads a value without walking the samples. */
  values: Map<number, number>;
}

function valuesByBucket(points: SeriesPoint[]): Map<number, number> {
  const values = new Map<number, number>();
  for (const point of points) {
    if (point.value !== null) values.set(point.at, point.value);
  }
  return values;
}

function peakOf(points: SeriesPoint[]): number {
  return Math.max(0, ...points.map((point) => point.value ?? 0));
}

function latestOf(points: SeriesPoint[]): number | null {
  return points.filter((point) => point.value !== null).at(-1)?.value ?? null;
}

/**
 * Every line the chart draws, in the order the legend and the table list them.
 *
 * @param palette hues already in use, so a line keeps its colour while the
 * channels beside it are switched on and off. Without one the colours are
 * worked out from this chart alone, which is right for a chart drawn once.
 */
export function drawnLines(
  history: StreamWatchHistory,
  palette?: Map<string, string>,
): DrawnLine[] {
  const gap = gapFor(history.bucketMinutes);
  const targets = groupWatchSamples(history.samples);
  const bySample = new Map(targets.map((target) => [target.key, target.samples]));
  // Colours are assigned over what was asked for rather than over what came
  // back, so a chosen channel that went quiet does not hand its hue to another.
  const colors = palette ?? assignSeriesColors(history.channels);
  const lines: DrawnLine[] = [];

  for (const key of history.channels) {
    const points = seriesPoints(bySample.get(key) ?? [], gap);
    lines.push({
      key,
      label: key,
      color: colors.get(key) ?? SERIES_COLORS[0],
      peak: peakOf(points),
      latest: latestOf(points),
      points,
      values: valuesByBucket(points),
    });
  }

  if (history.other.length > 0) {
    const points = seriesPoints(
      history.other.map((point) => ({
        sampledAt: point.sampledAt,
        platform: 'other',
        channel: 'other',
        siteCount: point.siteCount,
      })),
      gap,
    );
    const plural = history.otherChannels === 1 ? 'channel' : 'channels';
    lines.push({
      key: 'other',
      label: `${history.otherChannels} other ${plural}, together`,
      color: 'var(--faint)',
      peak: peakOf(points),
      latest: latestOf(points),
      points,
      values: valuesByBucket(points),
    });
  }

  return lines;
}

/**
 * The value axis. `nice` is d3's, so the top of the axis is a number a person
 * would have chosen; the floor keeps a quiet window from being drawn against an
 * axis of 0 and 1, where a single watcher would look like a full house.
 */
function valueScale(lines: DrawnLine[], height: number): ValueScale {
  const largest = Math.max(0, ...lines.map((drawn) => drawn.peak));
  return scaleLinear()
    .domain([0, Math.max(10, largest)])
    .nice()
    .range([height - BOTTOM, TOP]);
}

function timeScale(window: TimeWindow): TimeScale {
  return scaleTime()
    .domain([new Date(window.from), new Date(window.to)])
    .range([LEFT, WIDTH - RIGHT]);
}

function pathOf(points: SeriesPoint[], x: TimeScale, y: ValueScale): string | null {
  return line<SeriesPoint>()
    .defined((point) => point.value !== null)
    .x((point) => x(point.at))
    .y((point) => y(point.value ?? 0))(points);
}

function LineKey({ line: drawn }: { line: DrawnLine }) {
  return <i className="embed-chart-key" style={{ color: drawn.color }} aria-hidden="true" />;
}

function Lines({ lines, x, y }: { lines: DrawnLine[]; x: TimeScale; y: ValueScale }) {
  return (
    <>
      {lines.map((drawn) => {
        const path = pathOf(drawn.points, x, y);
        return (
          <g key={drawn.key} style={{ color: drawn.color }}>
            {path && <path className="embed-chart-line" d={path} />}
            {isolatedPoints(drawn.points).map((point) => (
              <circle
                key={point.at}
                className="embed-chart-point"
                cx={x(point.at)}
                cy={y(point.value ?? 0)}
                r="2.5"
              />
            ))}
          </g>
        );
      })}
    </>
  );
}

export interface EmbedHistoryChartProps {
  history: StreamWatchHistory;
  /** The window drawn, which is the brush's selection rather than the whole period. */
  window: TimeWindow;
  /** Hues held across renders, so toggling a channel never repaints its neighbours. */
  palette?: Map<string, string>;
}

/**
 * The focused chart: whatever window the brush below it has chosen.
 *
 * d3 does the arithmetic and React does the DOM. Scales, the line generator and
 * the tick choices are d3's; every element is JSX, so the chart renders the
 * same thing on the server as in the browser and can be asserted against as
 * markup. The one exception is the brush, which owns its own nodes.
 */
export function EmbedHistoryChart({ history, window, palette }: EmbedHistoryChartProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [reading, setReading] = useState<number | null>(null);

  const lines = drawnLines(history, palette);
  const x = timeScale(window);
  const y = valueScale(lines, HEIGHT);

  if (lines.length === 0) {
    return <p className="admin-empty">No embeds were recorded in this window.</p>;
  }

  const buckets = [...new Set(lines.flatMap((drawn) => [...drawn.values.keys()]))].sort(
    (left, right) => left - right,
  );
  const plotBottom = HEIGHT - BOTTOM;
  const plotRight = WIDTH - RIGHT;
  const format = x.tickFormat();
  const readingX = reading === null ? null : x(reading);

  const readAt = (event: PointerEvent<SVGSVGElement>) => {
    if (buckets.length === 0) return;
    // d3's pointer answers in the SVG's own user units, so a chart scaled to
    // its container reads the same as one drawn at its declared width.
    const [pixels] = pointer(event.nativeEvent, event.currentTarget);
    setReading(buckets[bisectCenter(buckets, x.invert(pixels).getTime())]);
  };

  return (
    <figure className="embed-chart">
      <div className="embed-chart-legend" aria-label="Channels on the chart">
        {lines.map((drawn) => (
          <span key={drawn.key}>
            <LineKey line={drawn} />
            {drawn.label}
          </span>
        ))}
      </div>

      <div className="embed-chart-scroll">
        <div className="embed-chart-plot">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-labelledby={`${titleId} ${descriptionId}`}
            onPointerMove={readAt}
            onPointerLeave={() => setReading(null)}
          >
            <title id={titleId}>Embeds open on destiny.gg, by channel</title>
            <desc id={descriptionId}>
              The chosen channels on one axis between {window.from} and {window.to}. The same
              figures are in the table below.
            </desc>

            {y.ticks(4).map((value) => (
              <g key={value} className="embed-chart-grid" aria-hidden="true">
                <line x1={LEFT} x2={plotRight} y1={y(value)} y2={y(value)} />
                <text x={LEFT - 7} y={y(value) + 4} textAnchor="end">
                  {value}
                </text>
              </g>
            ))}

            <g className="embed-chart-axis" aria-hidden="true">
              {x.ticks(6).map((tick) => (
                <text key={tick.getTime()} x={x(tick)} y={HEIGHT - 9} textAnchor="middle">
                  {format(tick)}
                </text>
              ))}
            </g>

            {readingX !== null && (
              <line
                className="embed-chart-crosshair"
                x1={readingX}
                x2={readingX}
                y1={TOP}
                y2={plotBottom}
                aria-hidden="true"
              />
            )}

            <Lines lines={lines} x={x} y={y} />

            <line
              className="embed-chart-baseline"
              x1={LEFT}
              x2={plotRight}
              y1={plotBottom}
              y2={plotBottom}
              aria-hidden="true"
            />
          </svg>

          {reading !== null && readingX !== null && (
            <div
              className="embed-chart-tooltip"
              style={{
                left: `${((readingX / WIDTH) * 100).toFixed(2)}%`,
                transform: readingX > WIDTH / 2 ? 'translateX(-100%)' : undefined,
              }}
            >
              <strong>{new Date(reading).toLocaleString()}</strong>
              {lines
                .filter((drawn) => drawn.values.has(reading))
                .sort(
                  (left, right) =>
                    (right.values.get(reading) ?? 0) - (left.values.get(reading) ?? 0),
                )
                .map((drawn) => (
                  <span key={drawn.key}>
                    <LineKey line={drawn} />
                    {drawn.label}
                    <b>{drawn.values.get(reading)}</b>
                  </span>
                ))}
            </div>
          )}
        </div>
      </div>

    </figure>
  );
}

/**
 * The same figures as the chart, for anyone the colours do not reach.
 *
 * It is a component of its own so the brush strip can sit between the plot and
 * this, which is the order focus-and-context has to be read in. It recomputes
 * the lines rather than being handed them: `drawnLines` is pure and cheap, and
 * a shared array would tie the two together for nothing.
 */
export function EmbedHistoryTable({
  history,
  palette,
}: {
  history: StreamWatchHistory;
  palette?: Map<string, string>;
}) {
  const lines = drawnLines(history, palette);
  if (lines.length === 0) return null;

  return (
    <table className="embed-chart-table">
      <caption>Peak and latest reading for every line drawn.</caption>
      <thead>
        <tr>
          <th scope="col">Channel</th>
          <th scope="col">Peak</th>
          <th scope="col">Latest</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((drawn) => (
          <tr key={drawn.key}>
            <th scope="row">
              <LineKey line={drawn} />
              {drawn.label}
            </th>
            <td>{drawn.peak}</td>
            <td>{drawn.latest === null ? 'not listed' : drawn.latest}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface EmbedHistoryOverviewProps {
  /** The whole period, drawn small. Never refetched while the brush moves. */
  history: StreamWatchHistory;
  period: TimeWindow;
  /** The brushed window, or null while the whole period is shown. */
  selection: TimeWindow | null;
  onSelect: (window: TimeWindow | null) => void;
  palette?: Map<string, string>;
}

/**
 * The whole period drawn small, with a window dragged over it.
 *
 * This is the one place d3 writes to the DOM rather than handing back numbers:
 * a brush is a handful of nodes that move with the pointer between renders, and
 * reimplementing that in React state would be worse code and worse dragging.
 * It owns nothing but the `<g>` the effect is given, so React owns everything
 * around it. Only `end` is listened to, because each selection is a fetch.
 */
export function EmbedHistoryOverview({
  history,
  period,
  selection,
  onSelect,
  palette,
}: EmbedHistoryOverviewProps) {
  const brushRef = useRef<SVGGElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const lines = drawnLines(history, palette);
  const x = timeScale(period);
  const y = valueScale(lines, OVERVIEW_HEIGHT);

  useEffect(() => {
    const group = brushRef.current;
    if (!group) return;

    const brush = brushX()
      .extent([
        [LEFT, 4],
        [WIDTH - RIGHT, OVERVIEW_HEIGHT - BOTTOM],
      ])
      .on('end', (event) => {
        // A programmatic move carries no source event. Answering those would
        // report back the selection this component was just handed.
        if (!event.sourceEvent) return;
        const range = event.selection as [number, number] | null;
        if (!range || range[1] - range[0] < 2) {
          onSelectRef.current(null);
          return;
        }
        onSelectRef.current({
          from: x.invert(range[0]).toISOString(),
          to: x.invert(range[1]).toISOString(),
        });
      });

    const node = select(group);
    node.call(brush);
    node.call(
      brush.move,
      selection === null ? null : [x(new Date(selection.from)), x(new Date(selection.to))],
    );

    return () => {
      node.on('.brush', null);
      node.selectAll('*').remove();
    };
  }, [period.from, period.to, selection?.from, selection?.to]);

  return (
    <div className="embed-chart-overview">
      <svg viewBox={`0 0 ${WIDTH} ${OVERVIEW_HEIGHT}`} role="presentation">
        <Lines lines={lines} x={x} y={y} />
        <line
          className="embed-chart-baseline"
          x1={LEFT}
          x2={WIDTH - RIGHT}
          y1={OVERVIEW_HEIGHT - BOTTOM}
          y2={OVERVIEW_HEIGHT - BOTTOM}
          aria-hidden="true"
        />
        <g className="embed-chart-axis" aria-hidden="true">
          {x.ticks(8).map((tick) => (
            <text key={tick.getTime()} x={x(tick)} y={OVERVIEW_HEIGHT - 9} textAnchor="middle">
              {x.tickFormat()(tick)}
            </text>
          ))}
        </g>
        <g className="embed-chart-brush" ref={brushRef} />
      </svg>
      <p className="embed-chart-hint">
        {selection === null
          ? 'Drag across this strip to look at part of the period. The chart above redraws at the finest detail that window has stored.'
          : 'Click the strip once to go back to the whole period.'}
      </p>
    </div>
  );
}
