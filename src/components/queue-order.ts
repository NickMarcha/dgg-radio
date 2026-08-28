import type { QueueItem } from '../shared/contracts';

export type MoveDestination = 'up' | 'down' | 'top' | 'bottom';

export function moveQueueItem(
  items: QueueItem[],
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
