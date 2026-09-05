import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_EMOTE,
  DEFAULT_WATCHER_EMBED_OPTIONS,
  WATCHER_INSET_RANGE,
  WATCHER_ROAM_RANGE,
  WATCHER_SPEED_RANGE,
  watcherEntrances,
  watcherLayouts,
  watcherMotions,
  watcherNames,
  watcherShows,
  type Watcher,
  type WatcherEmbedOptions,
  type WatcherEntrance,
  type WatcherLayout,
} from '../shared/contracts';
import { spawnBody, stepBumpers, type BumperBody } from './bumperMotion';
import { useWatcherEmbedSettings } from './useWatcherEmbedSettings';
import { useWatchers } from './useWatchers';
import '../styles/flairs.css';
import './WatchersOverlay.css';

/** The arrivals `random` picks from, per watcher rather than per appearance. */
const ENTRANCES = ['fade', 'spin', 'slide'] as const;

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function wholeNumber(
  value: string | null,
  fallback: number,
  maximum: number,
  minimum = 1,
): number {
  // An absent option is the default, said out loud: `Number(null)` is 0, and 0
  // is a value somebody may legitimately ask for.
  if (value === null || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
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
    motion: oneOf(params.get('motion'), watcherMotions, DEFAULT_WATCHER_EMBED_OPTIONS.motion),
    speed: wholeNumber(
      params.get('speed'),
      DEFAULT_WATCHER_EMBED_OPTIONS.speed,
      WATCHER_SPEED_RANGE.max,
      WATCHER_SPEED_RANGE.min,
    ),
    roam: wholeNumber(
      params.get('roam'),
      DEFAULT_WATCHER_EMBED_OPTIONS.roam,
      WATCHER_ROAM_RANGE.max,
      WATCHER_ROAM_RANGE.min,
    ),
    inset: wholeNumber(
      params.get('inset'),
      DEFAULT_WATCHER_EMBED_OPTIONS.inset,
      WATCHER_INSET_RANGE.max,
      WATCHER_INSET_RANGE.min,
    ),
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

/**
 * How long one pass of the motion takes. `speed` is a percentage of the
 * standard pace, so 200 halves the duration and 50 doubles it.
 */
function pace(milliseconds: number, speed: number): string {
  return `${Math.round(milliseconds / Math.max(speed, 1) * 100)}ms`;
}

/**
 * The band a layout may place somebody in: `inset` percent is kept clear at
 * every edge, and the trailing allowance is the room a watcher's own box takes
 * up to the right of, or below, wherever their corner is put.
 */
function band(inset: number, allowance: number): { from: number; size: number } {
  return { from: inset, size: Math.max(2, 100 - inset * 2 - allowance) };
}

/** A stable free-floating position derived from the watcher's name. */
export function driftStyle(nick: string, options: WatcherEmbedOptions): Record<string, string> {
  const hash = hashNick(nick);
  const spread = (shift: number, range: number) => Math.abs((hash >>> shift) % range);
  const across = band(options.inset, 8);
  const down = band(options.inset, 12);

  return {
    '--left': `${across.from + spread(0, Math.round(across.size))}%`,
    '--top': `${down.from + spread(8, Math.round(down.size))}%`,
    '--delay': `-${spread(16, 9_000)}ms`,
    '--duration': pace(7_000 + spread(24, 6_000), options.speed),
  };
}

/** A fixed seat around the frame edge, with enough local motion to feel alive. */
export function safeDriftStyle(
  nick: string,
  slot: number,
  slotCount: number,
  options: WatcherEmbedOptions,
): Record<string, string> {
  const hash = hashNick(nick);
  const spread = (shift: number, range: number) => Math.abs((hash >>> shift) % range);
  const edge = slot % 4;
  const seat = Math.floor(slot / 4);
  const seatsOnEdge = Math.ceil((slotCount - edge) / 4);
  const progress = (seat + 0.5) / seatsOnEdge;
  const along = band(options.inset, 8);
  const down = band(options.inset, 24);
  const across = along.from + progress * along.size;
  const descent = down.from + 14 + progress * Math.max(2, down.size - 14);
  const near = options.inset;
  const far = 100 - options.inset;
  const positions = [
    { left: `${across}%`, top: `${near + 2}%`, shift: '-50%' },
    { left: `${across}%`, top: `${far - 18}%`, shift: '-50%' },
    { left: `${near}%`, top: `${descent}%`, shift: '0%' },
    { left: `${far}%`, top: `${descent}%`, shift: '-100%' },
  ];

  return {
    '--left': positions[edge].left,
    '--top': positions[edge].top,
    '--edge-shift': positions[edge].shift,
    '--delay': `-${spread(16, 9_000)}ms`,
    '--duration': pace(8_000 + spread(24, 6_000), options.speed),
  };
}

function slottedStyle(
  nick: string,
  layout: Exclude<WatcherLayout, 'float' | 'safe' | 'bump'>,
  slot: number,
  slotCount: number,
  options: WatcherEmbedOptions,
): Record<string, string> {
  const hash = hashNick(nick);
  const delay = Math.abs((hash >>> 16) % 9_000);
  const duration = 6_000 + Math.abs((hash >>> 24) % 4_000);
  const edge = `${options.inset}%`;
  const down = band(options.inset, 18);

  if (layout === 'rail') {
    return {
      '--slot-left': `${((slot + 0.5) / slotCount) * 100}%`,
      '--edge': edge,
      '--delay': `-${delay}ms`,
      '--duration': pace(duration + 1_000, options.speed),
    };
  }

  if (layout === 'column') {
    return {
      '--slot-top': `${down.from + ((slot + 0.5) / slotCount) * down.size}%`,
      '--edge': edge,
      '--delay': `-${delay}ms`,
      '--duration': pace(duration, options.speed),
    };
  }

  const rows = Math.ceil(slotCount / 2);
  const side = slot % 2;
  return {
    '--slot-left': side === 0 ? edge : `${100 - options.inset}%`,
    '--slot-top': `${down.from + ((Math.floor(slot / 2) + 0.5) / rows) * down.size}%`,
    '--edge-shift': side === 0 ? '0%' : '-100%',
    '--edge': edge,
    '--delay': `-${delay}ms`,
    '--duration': pace(duration, options.speed),
  };
}

/**
 * The one layout with a loop behind it. Everybody drifts, bounces off the frame
 * and off each other, and the positions are written straight to the elements:
 * putting them through React would re-render the whole overlay sixty times a
 * second to move six things.
 *
 * The elements come from a ref rather than the effect's dependencies, so a
 * watcher arriving or leaving joins the simulation on the next frame instead of
 * tearing it down and starting everybody over.
 */
function useBumperMotion(
  frame: React.RefObject<HTMLDivElement | null>,
  elements: React.RefObject<Map<string, HTMLElement>>,
  active: boolean,
  speed: number,
  inset: number,
): void {
  useEffect(() => {
    const container = frame.current;
    if (!active || !container) return;
    // The stylesheet stops every other layout for someone who asked for less
    // motion. This one has to stop itself.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const bodies = new Map<string, BumperBody>();
    let previous = performance.now();
    let request = 0;

    const tick = (now: number) => {
      request = requestAnimationFrame(tick);
      const elapsed = now - previous;
      previous = now;

      const margin = {
        x: (container.clientWidth * inset) / 100,
        y: (container.clientHeight * inset) / 100,
      };
      const bounds = {
        width: Math.max(1, container.clientWidth - margin.x * 2),
        height: Math.max(1, container.clientHeight - margin.y * 2),
      };

      for (const [nick, element] of elements.current) {
        if (bodies.has(nick)) continue;
        const box = element.getBoundingClientRect();
        bodies.set(
          nick,
          spawnBody(nick, bounds, { width: box.width, height: box.height }, speed),
        );
      }
      for (const nick of bodies.keys()) {
        if (!elements.current.has(nick)) bodies.delete(nick);
      }

      const moving = [...bodies.values()];
      stepBumpers(moving, bounds, elapsed);

      for (const body of moving) {
        const element = elements.current.get(body.nick);
        if (element) {
          element.style.translate = `${Math.round(body.x + margin.x)}px ${Math.round(body.y + margin.y)}px`;
        }
      }
    };

    request = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(request);
      for (const element of elements.current.values()) element.style.translate = '';
    };
  }, [frame, elements, active, speed, inset]);
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
  if (options.layout !== 'float' && options.layout !== 'bump') {
    slots = slotMaps.current.get(options.layout) ?? new Map<string, number>();
    slotMaps.current.set(options.layout, assignStableSlots(rendered.current, slotCount, slots));
  }

  const frame = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  useBumperMotion(frame, elements, options.layout === 'bump', options.speed, options.inset);

  const positionOf = (nick: string): Record<string, string> => {
    if (options.layout === 'bump') return {};
    if (options.layout === 'float') return driftStyle(nick, options);
    if (options.layout === 'safe') {
      return safeDriftStyle(nick, slots?.get(nick) ?? 0, slotCount, options);
    }
    return slottedStyle(nick, options.layout, slots?.get(nick) ?? 0, slotCount, options);
  };

  return (
    <div
      ref={frame}
      className={[
        'watchers',
        `watchers-${options.layout}`,
        `watchers-names-${options.names}`,
        `watchers-motion-${options.motion}`,
      ].join(' ')}
      style={{ '--roam': String(options.roam / 100) } as React.CSSProperties}
    >
      {rendered.current.map(({ watcher, leavingSince }) => (
        <div
          key={watcher.nick}
          ref={(element) => {
            if (element) elements.current.set(watcher.nick, element);
            else elements.current.delete(watcher.nick);
          }}
          className={[
            'watcher',
            leavingSince === null ? '' : 'watcher-leaving',
            `enter-${entranceFor(watcher.nick, options.enter)}`,
          ]
            .filter(Boolean)
            .join(' ')}
          style={positionOf(watcher.nick)}
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
