export interface FairQueueCandidate {
  id: string;
  requesterId: string;
  requestedAt: Date;
  requesterLastPlayedAt: Date | null;
}

function compareDates(left: Date | null, right: Date | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left.getTime() - right.getTime();
}

export function orderQueueRoundRobin<T extends FairQueueCandidate>(items: T[]): T[] {
  const requestsByUser = new Map<string, T[]>();
  const lastPlayedByUser = new Map<string, Date | null>();

  for (const item of items) {
    const requests = requestsByUser.get(item.requesterId) ?? [];
    requests.push(item);
    requestsByUser.set(item.requesterId, requests);
    lastPlayedByUser.set(item.requesterId, item.requesterLastPlayedAt);
  }
  for (const requests of requestsByUser.values()) {
    requests.sort((left, right) => left.requestedAt.getTime() - right.requestedAt.getTime());
  }

  const ordered: T[] = [];
  let syntheticPlayTime = Date.now();
  while (requestsByUser.size > 0) {
    const nextUser = [...requestsByUser.keys()].sort((left, right) => {
      const lastPlayed = compareDates(lastPlayedByUser.get(left) ?? null, lastPlayedByUser.get(right) ?? null);
      if (lastPlayed !== 0) return lastPlayed;
      const leftRequest = requestsByUser.get(left)?.[0];
      const rightRequest = requestsByUser.get(right)?.[0];
      return (leftRequest?.requestedAt.getTime() ?? 0) - (rightRequest?.requestedAt.getTime() ?? 0);
    })[0];

    if (!nextUser) break;
    const requests = requestsByUser.get(nextUser);
    const nextItem = requests?.shift();
    if (nextItem) ordered.push(nextItem);
    if (!requests?.length) requestsByUser.delete(nextUser);
    lastPlayedByUser.set(nextUser, new Date(syntheticPlayTime++));
  }
  return ordered;
}
