export type MoveDestination = 'up' | 'down' | 'top' | 'bottom';

/**
 * Reorders a list by moving one item, and returns the resulting ids. Used for
 * both queues and the rule list, so it works on anything carrying an id.
 * `lockedLastId` pins an item to the bottom: it never moves and nothing can be
 * placed after it.
 */
export function moveItem<T extends { id: string }>(
  items: T[],
  itemId: string,
  destination: MoveDestination,
  lockedLastId?: string,
): string[] | null {
  if (itemId === lockedLastId) return null;
  const movable = lockedLastId ? items.filter(({ id }) => id !== lockedLastId) : [...items];
  const from = movable.findIndex(({ id }) => id === itemId);
  if (from < 0) return null;
  const to =
    destination === 'top'
      ? 0
      : destination === 'bottom'
        ? movable.length - 1
        : from + (destination === 'up' ? -1 : 1);
  if (to < 0 || to >= movable.length || to === from) return null;
  const [moved] = movable.splice(from, 1);
  movable.splice(to, 0, moved!);
  const orderedIds = movable.map(({ id }) => id);
  if (lockedLastId) orderedIds.push(lockedLastId);
  return orderedIds;
}
