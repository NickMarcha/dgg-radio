import { MAIN_ROOM_SLUG, roomSlugSchema } from '../shared/roomConnection';

const LAST_ROOM_STORAGE_KEY = 'dgg-radio:last-room';

/** `/r/<slug>` names a room; every other room page is the main room. */
export function roomSlugFromPath(pathname: string): string {
  const match = /^\/r\/([^/]+)\/?$/.exec(pathname);
  const slug = match?.[1]?.toLowerCase();
  return slug && roomSlugSchema.safeParse(slug).success ? slug : MAIN_ROOM_SLUG;
}

/** An OBS source names its room in the query string, as it does every other option. */
export function roomSlugFromSearch(search: string): string {
  const slug = new URLSearchParams(search).get('room')?.toLowerCase();
  return slug && roomSlugSchema.safeParse(slug).success ? slug : MAIN_ROOM_SLUG;
}

/** Where a room's page lives. The main room keeps the root. */
export function roomPath(slug: string): string {
  return slug === MAIN_ROOM_SLUG ? '/' : `/r/${slug}`;
}

/**
 * The room this browser last opened, which is where a page with no room of its
 * own — history, a playlist — sends a request. Storage can be missing or
 * refuse, and then the answer is the main room.
 */
export function lastRoomSlug(): string {
  try {
    const slug = window.localStorage.getItem(LAST_ROOM_STORAGE_KEY);
    return slug && roomSlugSchema.safeParse(slug).success ? slug : MAIN_ROOM_SLUG;
  } catch {
    return MAIN_ROOM_SLUG;
  }
}

export function rememberRoom(slug: string): void {
  try {
    window.localStorage.setItem(LAST_ROOM_STORAGE_KEY, slug);
  } catch {
    // Remembering is a convenience; a browser that will not store it loses nothing else.
  }
}
