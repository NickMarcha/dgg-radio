import { Check, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  StreamWatchChannel,
  StreamWatchHistory,
  StreamWatchStatus,
} from '../shared/contracts';
import { STREAM_WATCH_MAX_CHANNELS } from '../shared/contracts';
import {
  assignSeriesColors,
  EmbedHistoryChart,
  EmbedHistoryOverview,
  EmbedHistoryTable,
  type TimeWindow,
} from './EmbedHistoryChart';
import './EmbedHistorySection.css';

const PERIODS = [
  { hours: 6, label: '6 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
] as const;

type PeriodHours = (typeof PERIODS)[number]['hours'];

/** How often the period catches up with the clock while nothing is brushed. */
const REFRESH_MS = 60_000;

function periodEnding(hours: number, at: Date = new Date()): TimeWindow {
  return { from: new Date(at.getTime() - hours * 3_600_000).toISOString(), to: at.toISOString() };
}

function query(window: TimeWindow, channels: string[] | null): string {
  const params = new URLSearchParams({ from: window.from, to: window.to });
  if (channels !== null && channels.length > 0) params.set('channels', channels.join(','));
  return params.toString();
}

function keyOf(channel: StreamWatchChannel): string {
  return `${channel.platform}/${channel.channel}`;
}

/** How long ago, in the coarsest unit that still says something. */
export function sinceLabel(iso: string, now: number = Date.now()): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** The window a chart is drawn over: the brushed part, or the whole period. */
export function windowFor(period: TimeWindow, selection: TimeWindow | null): TimeWindow {
  return selection ?? period;
}

interface EmbedHistorySectionProps {
  call: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
}

/**
 * Everything destiny.gg was watching, and the tools to find one moment in it.
 *
 * This is its own tab rather than part of the OBS one because it is no longer
 * about the overlay: the sampler runs whether or not a channel is followed, so
 * what is drawn here is the site's own history and not the room's stream.
 *
 * Two requests hold it up. The period is fetched once and drawn small as the
 * strip at the bottom; brushing that strip fetches only the brushed window,
 * which the server then groups at whatever detail that window has stored — so
 * an hour picked out of a month arrives at full detail rather than per two hours.
 * With nothing brushed there is only ever one request, and the chart above is
 * the strip drawn large.
 */
export function EmbedHistorySection({ call }: EmbedHistorySectionProps) {
  const [hours, setHours] = useState<PeriodHours>(24);
  const [period, setPeriod] = useState<TimeWindow>(() => periodEnding(24));
  const [selection, setSelection] = useState<TimeWindow | null>(null);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [search, setSearch] = useState('');

  const [channels, setChannels] = useState<StreamWatchChannel[] | null>(null);
  const [overview, setOverview] = useState<StreamWatchHistory | null>(null);
  const [focus, setFocus] = useState<StreamWatchHistory | null>(null);
  const [status, setStatus] = useState<StreamWatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chosenKey = chosen === null ? '' : chosen.join(',');

  const loadPeriod = useCallback(async () => {
    try {
      const [list, history, next] = await Promise.all([
        call<{ channels: StreamWatchChannel[] }>(`/api/watchers/channels?${query(period, null)}`),
        call<StreamWatchHistory>(`/api/watchers/history?${query(period, chosen)}`),
        call<StreamWatchStatus>('/api/stream-watch'),
      ]);
      setChannels(list.channels);
      setOverview(history);
      setStatus(next);
      setError(null);
    } catch {
      setError('The embed history could not be loaded.');
    }
    // `chosenKey` stands in for `chosen`, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, period.from, period.to, chosenKey]);

  useEffect(() => {
    void loadPeriod();
  }, [loadPeriod]);

  // The period follows the clock only while the whole of it is on screen. A
  // brushed window is a place somebody is looking at, and moving it under them
  // would be the one thing this tab exists to let them stop doing.
  useEffect(() => {
    if (selection !== null) return;
    const timer = window.setInterval(() => setPeriod(periodEnding(hours)), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hours, selection]);

  // The channels the strip drew are the channels the focused window asks for,
  // so brushing never silently swaps which eight are on the chart.
  const drawn = overview?.channels ?? null;

  useEffect(() => {
    if (selection === null || drawn === null) {
      setFocus(null);
      return;
    }
    let current = true;
    void call<StreamWatchHistory>(`/api/watchers/history?${query(selection, drawn)}`)
      .then((history) => {
        if (current) setFocus(history);
      })
      .catch(() => {
        if (current) setError('That window could not be loaded.');
      });
    return () => {
      current = false;
    };
  }, [call, selection?.from, selection?.to, drawn?.join(',')]);

  const shown = useMemo(() => {
    if (channels === null) return [];
    const needle = search.trim().toLowerCase();
    return needle === ''
      ? channels
      : channels.filter((channel) => keyOf(channel).includes(needle));
  }, [channels, search]);

  // The hues live above every chart on the page and outlast each redraw, so
  // switching one channel off never repaints the ones left on. A hue is handed
  // on only once nothing is using it.
  const palette = useRef(new Map<string, string>());
  palette.current = assignSeriesColors(drawn ?? [], palette.current);

  const selected = new Set(chosen ?? drawn ?? []);
  const atLimit = selected.size >= STREAM_WATCH_MAX_CHANNELS;

  function toggle(key: string): void {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else if (!atLimit) next.add(key);
    else return;
    setChosen(next.size === 0 ? null : [...next]);
  }

  function choosePeriod(next: PeriodHours): void {
    setHours(next);
    setSelection(null);
    setPeriod(periodEnding(next));
  }

  const chart = selection === null ? overview : focus;
  const lastSample = channels?.[0] === undefined
    ? null
    : channels.reduce(
        (latest, channel) => (channel.lastSeenAt > latest ? channel.lastSeenAt : latest),
        channels[0].lastSeenAt,
      );

  return (
    <section className="admin-card">
      <h2>Embed history</h2>
      <p className="admin-help">
        Every embed destiny.gg listed, sampled every quarter of an hour. This runs on the live
        socket alone and does not wait for a channel to be followed, so the record is of the site
        rather than of the room's own stream. One number per channel: destiny.gg's own count of how
        many have that embed open, as it stood when the reading was taken. Who is in chat with it is
        a live thing the overlay draws and is never stored.
      </p>

      <dl className="admin-operation-counts">
        <div>
          <dt>Live socket</dt>
          <dd>{status?.sockets.live.connected ? 'connected' : 'down'}</dd>
        </div>
        <div>
          <dt>Last frame</dt>
          <dd>
            {status?.sockets.live.lastFrameAt
              ? sinceLabel(status.sockets.live.lastFrameAt)
              : 'never'}
          </dd>
        </div>
        <div>
          <dt>Last sample</dt>
          <dd>{lastSample ? sinceLabel(lastSample) : 'none in this period'}</dd>
        </div>
        <div>
          <dt>Channels seen</dt>
          <dd>{channels?.length ?? '—'}</dd>
        </div>
      </dl>

      <div className="embed-history-toolbar">
        <label>
          Period
          <select
            aria-label="Embed history period"
            value={hours}
            onChange={(event) => choosePeriod(Number(event.currentTarget.value) as PeriodHours)}
          >
            {PERIODS.map((choice) => (
              <option key={choice.hours} value={choice.hours}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>

        <button type="button" onClick={() => choosePeriod(hours)}>
          <RefreshCw size={14} /> Refresh
        </button>

        {selection !== null && (
          <button type="button" onClick={() => setSelection(null)}>
            Whole period
          </button>
        )}

        <p className="embed-history-window">
          {selection === null
            ? 'Showing the whole period.'
            : `Showing ${new Date(selection.from).toLocaleString()} to ${new Date(
                selection.to,
              ).toLocaleString()}.`}
        </p>
      </div>

      {error && <p className="admin-error">{error}</p>}

      <div className="embed-history-body">
        <div className="embed-history-picker">
          <div className="admin-section-subheading">
            <h3>Channels</h3>
            <span className="admin-meta">
              {selected.size} of {STREAM_WATCH_MAX_CHANNELS} drawn
            </span>
          </div>

          <label className="embed-history-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={search}
              placeholder="Find a channel"
              aria-label="Find a channel"
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </label>

          {chosen !== null && (
            <button type="button" className="embed-history-reset" onClick={() => setChosen(null)}>
              <Check size={13} /> Back to the busiest {STREAM_WATCH_MAX_CHANNELS}
            </button>
          )}

          {channels === null ? (
            <p className="admin-empty">Loading channels…</p>
          ) : shown.length === 0 ? (
            <p className="admin-empty">
              {channels.length === 0
                ? 'Nothing was sampled in this period.'
                : 'No channel here matches that.'}
            </p>
          ) : (
            <ul className="embed-history-channels">
              {shown.map((channel) => {
                const key = keyOf(channel);
                const on = selected.has(key);
                return (
                  <li key={key}>
                    <label className={on ? 'embed-history-channel-on' : undefined}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && atLimit}
                        onChange={() => toggle(key)}
                      />
                      <span className="embed-history-channel-name">{key}</span>
                      <span className="embed-history-peak">{channel.peak}</span>
                      <span className="embed-history-seen">{sinceLabel(channel.lastSeenAt)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="admin-help">
            Ranked by the most embeds open on it at once. Every channel sampled in the period is
            here, however quiet — that is the point of choosing rather than taking the busiest
            eight. Eight is the limit because it is how many lines one chart can tell apart. The
            channel the overlay follows is not special here: it is counted like any other.
          </p>
        </div>

        <div className="embed-history-charts">
          {chart === null ? (
            <p className="admin-empty">Loading the chart…</p>
          ) : (
            <p className="admin-help">
              One point every {chart.bucketMinutes} minutes. A line breaks where nothing was
              measured rather than dropping to zero.
            </p>
          )}

          {chart && (
            <EmbedHistoryChart
              history={chart}
              window={windowFor(period, selection)}
              palette={palette.current}
            />
          )}

          {/* The strip goes directly under the plot, and outside the branch
              above: a brushed window with nothing in it still has to offer the
              handle that brushed it, or there is no way back out of it. */}
          {overview && (
            <EmbedHistoryOverview
              history={overview}
              period={period}
              selection={selection}
              onSelect={setSelection}
              palette={palette.current}
            />
          )}

          {chart && <EmbedHistoryTable history={chart} palette={palette.current} />}
        </div>
      </div>
    </section>
  );
}
