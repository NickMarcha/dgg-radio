import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_EMOTE,
  DEFAULT_WATCHER_EMBED_OPTIONS,
  watcherEntrances,
  watcherLayouts,
  watcherNames,
  watcherShows,
  type Watcher,
  type WatcherEmbedOptions,
  type WatcherEntrance,
  type WatcherLayout,
} from '../shared/contracts';
import { useWatcherEmbedSettings } from './useWatcherEmbedSettings';
import { useWatchers } from './useWatchers';
import '../styles/flairs.css';
import './WatchersOverlay.css';

/** The arrivals `random` picks from, per watcher rather than per appearance. */
const ENTRANCES = ['fade', 'spin', 'slide'] as const;

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function wholeNumber(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

/**
 * Fixed browser sources carry their settings in the URL. A personal source
 * ignores these after it reads `profile` and takes its settings from the API.
 */
export function readWatchersOptions(search: string): WatcherEmbedOptions {
  const params = new URLSearchParams(search);
  return {
    show: oneOf(params.get('show'), watcherShows, DEFAULT_WATCHER_EMBED_OPTIONS.show),
    window: wholeNumber(params.get('window'), DEFAULT_WATCHER_EMBED_OPTIONS.window, 1_440),
    max: wholeNumber(params.get('max'), DEFAULT_WATCHER_EMBED_OPTIONS.max, 100),
    layout: oneOf(params.get('layout'), watcherLayouts, DEFAULT_WATCHER_EMBED_OPTIONS.layout),
    names: oneOf(params.get('names'), watcherNames, DEFAULT_WATCHER_EMBED_OPTIONS.names),
    enter: oneOf(params.get('enter'), watcherEntrances, DEFAULT_WATCHER_EMBED_OPTIONS.enter),
  };
}

/**
 * Who to draw: whoever is already on screen and still qualifies, then the most
 * recent newcomers to fill what is left.
 *
 * Holding on to them is the point. The snapshot is ordered by who spoke last,
 * so taking the top `max` of it means a busy chat swaps most of the overlay
 * every couple of seconds. A watcher now stays until they really go, either out
 * of the speaking window or out of chat.
 */
export function chooseWatchers(
  watchers: Watcher[],
  options: WatcherEmbedOptions,
  now: number = Date.now(),
  previous: string[] = [],
): Watcher[] {
  const since = now - options.window * 60_000;
  const eligible = watchers.filter((watcher) => {
    if (options.show === 'members') return watcher.member;
    if (options.show === 'all') return true;
    return watcher.lastSpokeAt !== null && new Date(watcher.lastSpokeAt).getTime() >= since;
  });

  const byNick = new Map(eligible.map((watcher) => [watcher.nick, watcher]));
  const held = new Set(previous);
  const kept = previous
    .map((nick) => byNick.get(nick))
    .filter((watcher): watcher is Watcher => watcher !== undefined);
  const arriving = eligible.filter((watcher) => !held.has(watcher.nick));

  return [...kept, ...arriving].slice(0, options.max);
}

function hashNick(nick: string): number {
  let hash = 2166136261;
  for (let index = 0; index < nick.length; index += 1) {
    hash ^= nick.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash;
}

/** A position in a fixed set of seats. Existing people keep theirs as others leave. */
export function assignStableSlots(
  watchers: RenderedWatcher[],
  slotCount: number,
  slots: Map<string, number>,
): Map<string, number> {
  const active = new Set(watchers.map(({ watcher }) => watcher.nick));
  for (const nick of slots.keys()) {
    if (!active.has(nick)) slots.delete(nick);
  }

  const occupied = new Set<number>();
  for (const { watcher } of watchers) {
    const slot = slots.get(watcher.nick);
    if (slot === undefined || slot >= slotCount || occupied.has(slot)) {
      slots.delete(watcher.nick);
      continue;
    }
    occupied.add(slot);
  }

  for (const { watcher } of watchers) {
    if (slots.has(watcher.nick)) continue;
    const first = Math.abs(hashNick(watcher.nick)) % slotCount;
    for (let offset = 0; offset < slotCount; offset += 1) {
      const slot = (first + offset) % slotCount;
      if (occupied.has(slot)) continue;
      slots.set(watcher.nick, slot);
      occupied.add(slot);
      break;
    }
  }

  return slots;
}

/** Which entrance somebody gets, kept theirs so they arrive the same way twice. */
export function entranceFor(nick: string, enter: WatcherEntrance): (typeof ENTRANCES)[number] {
  if (enter !== 'random') return enter;
  return ENTRANCES[Math.abs(hashNick(nick)) % ENTRANCES.length];
}

/** A stable free-floating position derived from the watcher's name. */
export function driftStyle(nick: string): Record<string, string> {
  const hash = hashNick(nick);
  const spread = (shift: number, range: number) => Math.abs((hash >>> shift) % range);

  return {
    '--left': `${4 + spread(0, 84)}%`,
    '--top': `${6 + spread(8, 74)}%`,
    '--delay': `-${spread(16, 9_000)}ms`,
    '--duration': `${7_000 + spread(24, 6_000)}ms`,
  };
}

/** A fixed seat around the frame edge, with enough local motion to feel alive. */
export function safeDriftStyle(
  nick: string,
  slot: number,
  slotCount: number,
): Record<string, string> {
  const hash = hashNick(nick);
  const spread = (shift: number, range: number) => Math.abs((hash >>> shift) % range);
  const edge = slot % 4;
  const seat = Math.floor(slot / 4);
  const seatsOnEdge = Math.ceil((slotCount - edge) / 4);
  const progress = (seat + 0.5) / seatsOnEdge;
  const across = 8 + progress * 78;
  const down = 20 + progress * 58;
  const positions = [
    { left: `${across}%`, top: '6%', shift: '-50%' },
    { left: `${across}%`, top: '82%', shift: '-50%' },
    { left: '3%', top: `${down}%`, shift: '0%' },
    { left: '97%', top: `${down}%`, shift: '-100%' },
  ];

  return {
    '--left': positions[edge].left,
    '--top': positions[edge].top,
    '--edge-shift': positions[edge].shift,
    '--delay': `-${spread(16, 9_000)}ms`,
    '--duration': `${8_000 + spread(24, 6_000)}ms`,
  };
}

function slottedStyle(
  nick: string,
  layout: Exclude<WatcherLayout, 'float' | 'safe'>,
  slot: number,
  slotCount: number,
): Record<string, string> {
  const hash = hashNick(nick);
  const delay = Math.abs((hash >>> 16) % 9_000);
  const duration = 6_000 + Math.abs((hash >>> 24) % 4_000);

  if (layout === 'rail') {
    return {
      '--slot-left': `${((slot + 0.5) / slotCount) * 100}%`,
      '--delay': `-${delay}ms`,
      '--duration': `${duration + 1_000}ms`,
    };
  }

  if (layout === 'column') {
    return {
      '--slot-top': `${8 + ((slot + 0.5) / slotCount) * 82}%`,
      '--delay': `-${delay}ms`,
      '--duration': `${duration}ms`,
    };
  }

  const rows = Math.ceil(slotCount / 2);
  const side = slot % 2;
  return {
    '--slot-left': side === 0 ? '2.5%' : '97.5%',
    '--slot-top': `${8 + ((Math.floor(slot / 2) + 0.5) / rows) * 82}%`,
    '--edge-shift': side === 0 ? '0%' : '-100%',
    '--delay': `-${delay}ms`,
    '--duration': `${duration}ms`,
  };
}

/** How long a watcher stays on screen after they stop being drawn, fading out. */
export const LEAVE_MS = 450;

export interface RenderedWatcher {
  watcher: Watcher;
  /** When they stopped being drawn, or null while they still are. */
  leavingSince: number | null;
}

/** The chosen watchers plus anyone still completing their exit animation. */
export function mergeRendered(
  previous: RenderedWatcher[],
  chosen: Watcher[],
  now: number,
): RenderedWatcher[] {
  const drawn = new Set(chosen.map((watcher) => watcher.nick));
  const leaving = previous
    .filter((entry) => !drawn.has(entry.watcher.nick))
    .map((entry) => (entry.leavingSince === null ? { ...entry, leavingSince: now } : entry))
    .filter((entry) => now - (entry.leavingSince ?? now) < LEAVE_MS);

  return [
    ...chosen.map((watcher) => ({ watcher, leavingSince: null })),
    ...leaving,
  ];
}

export default function WatchersOverlay({ apiUrl }: { apiUrl: string }) {
  const snapshot = useWatchers(apiUrl);
  // A prerender has no query string. Apply it only after hydration so the
  // server and browser produce the same first frame.
  const [fixedOptions, setFixedOptions] = useState<WatcherEmbedOptions>(
    DEFAULT_WATCHER_EMBED_OPTIONS,
  );
  const [profileId, setProfileId] = useState<string | null>(null);
  const personalOptions = useWatcherEmbedSettings(apiUrl, profileId);

  useEffect(() => {
    setFixedOptions(readWatchersOptions(window.location.search));
    setProfileId(new URLSearchParams(window.location.search).get('profile'));
  }, []);

  const options = profileId ? (personalOptions ?? DEFAULT_WATCHER_EMBED_OPTIONS) : fixedOptions;

  // `speakers` is a moving window and a fade has to end, so reconsider the
  // list on a tick as well as whenever the server pushes.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((count) => count + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const rendered = useRef<RenderedWatcher[]>([]);
  const onScreen = rendered.current
    .filter((entry) => entry.leavingSince === null)
    .map((entry) => entry.watcher.nick);
  const watchers = chooseWatchers(snapshot?.watchers ?? [], options, Date.now(), onScreen);
  rendered.current = mergeRendered(rendered.current, watchers, Date.now());

  const slotCount = Math.max(1, options.max);
  const slotMaps = useRef(new Map<WatcherLayout, Map<string, number>>());
  let slots: Map<string, number> | undefined;
  if (options.layout !== 'float') {
    slots = slotMaps.current.get(options.layout) ?? new Map<string, number>();
    slotMaps.current.set(options.layout, assignStableSlots(rendered.current, slotCount, slots));
  }

  return (
    <div className={`watchers watchers-${options.layout} watchers-names-${options.names}`}>
      {rendered.current.map(({ watcher, leavingSince }) => (
        <div
          key={watcher.nick}
          className={[
            'watcher',
            leavingSince === null ? '' : 'watcher-leaving',
            `enter-${entranceFor(watcher.nick, options.enter)}`,
          ]
            .filter(Boolean)
            .join(' ')}
          style={
            options.layout === 'float'
              ? driftStyle(watcher.nick)
              : options.layout === 'safe'
                ? safeDriftStyle(watcher.nick, slots?.get(watcher.nick) ?? 0, slotCount)
                : slottedStyle(
                    watcher.nick,
                    options.layout,
                    slots?.get(watcher.nick) ?? 0,
                    slotCount,
                  )
          }
        >
          <div className="watcher-body">
            <span className={`emote ${watcher.lastEmote ?? watcher.emote ?? DEFAULT_EMOTE}`} />
            {options.names !== 'off' && (
              <span
                className={watcher.flair ? `watcher-name flair-${watcher.flair}` : 'watcher-name'}
              >
                {watcher.nick}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
