/**
 * The room's histories are searched the same way, so the one rule about it
 * lives here rather than in each of them.
 */

/**
 * A case-insensitive "contains" pattern. `%` and `_` are wildcards in LIKE, so
 * a search for `50_50` would otherwise quietly match more than it was asked
 * for; escaping them makes a typed search mean what it says.
 */
export function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
