import { describe, expect, it } from 'vitest';
import { orderQueueRoundRobin, type FairQueueCandidate } from './queue-order';

const at = (second: number) => new Date(`2026-01-01T00:00:${String(second).padStart(2, '0')}Z`);

function item(
  id: string,
  requesterId: string,
  requestedSecond: number,
  lastPlayedSecond: number | null,
): FairQueueCandidate {
  return {
    id,
    requesterId,
    requestedAt: at(requestedSecond),
    requesterLastPlayedAt: lastPlayedSecond === null ? null : at(lastPlayedSecond),
  };
}

describe('orderQueueRoundRobin', () => {
  it('gives each requester one turn before their second request', () => {
    const result = orderQueueRoundRobin([
      item('a1', 'a', 1, null),
      item('a2', 'a', 2, null),
      item('b1', 'b', 3, null),
      item('b2', 'b', 4, null),
    ]);
    expect(result.map(({ id }) => id)).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('starts with the requester who has waited longest since playing', () => {
    const result = orderQueueRoundRobin([
      item('recent', 'a', 1, 20),
      item('waiting', 'b', 2, 10),
    ]);
    expect(result.map(({ id }) => id)).toEqual(['waiting', 'recent']);
  });
});
