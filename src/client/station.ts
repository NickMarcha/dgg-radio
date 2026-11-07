import { MAIN_STATION_SLUG, stationSlugSchema } from '../shared/stationConnection';

const LAST_STATION_STORAGE_KEY = 'dgg-radio:last-station';

/** `/s/<slug>` names a station; every other station page is the main station. */
export function stationSlugFromPath(pathname: string): string {
  const match = /^\/s\/([^/]+)\/?$/.exec(pathname);
  const slug = match?.[1]?.toLowerCase();
  return slug && stationSlugSchema.safeParse(slug).success ? slug : MAIN_STATION_SLUG;
}

/** An OBS source names its station in the query string, as it does every other option. */
export function stationSlugFromSearch(search: string): string {
  const slug = new URLSearchParams(search).get('station')?.toLowerCase();
  return slug && stationSlugSchema.safeParse(slug).success ? slug : MAIN_STATION_SLUG;
}

/** Where a station's page lives. The main station keeps the root. */
export function stationPath(slug: string): string {
  return slug === MAIN_STATION_SLUG ? '/' : `/s/${slug}`;
}

/**
 * The station this browser last opened, which is where a page with no station of its
 * own — history, a playlist — sends a request. Storage can be missing or
 * refuse, and then the answer is the main station.
 */
export function lastStationSlug(): string {
  try {
    const slug = window.localStorage.getItem(LAST_STATION_STORAGE_KEY);
    return slug && stationSlugSchema.safeParse(slug).success ? slug : MAIN_STATION_SLUG;
  } catch {
    return MAIN_STATION_SLUG;
  }
}

export function rememberStation(slug: string): void {
  try {
    window.localStorage.setItem(LAST_STATION_STORAGE_KEY, slug);
  } catch {
    // Remembering is a convenience; a browser that will not store it loses nothing else.
  }
}
