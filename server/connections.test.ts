import { describe, expect, it } from 'vitest';
import { ConnectionRegistry } from './connections';

describe('ConnectionRegistry', () => {
  it('counts duplicate station tabs for one signed-in user as one listener and one eligible voter', () => {
    const registry = new ConnectionRegistry<object>();
    const firstTab = {};
    const secondTab = {};

    registry.add(firstTab, { kind: 'station', stationId: 'station-a', userId: 'user-1', username: 'one', visitorId: 'visitor-1' });
    registry.add(secondTab, { kind: 'station', stationId: 'station-a', userId: 'user-1', username: 'one', visitorId: 'visitor-1' });

    expect(registry.listenerCount()).toBe(1);
    expect(registry.eligibleVoterCount()).toBe(1);
  });

  it('removes a listener only after their final station connection closes', () => {
    const registry = new ConnectionRegistry<object>();
    const firstTab = {};
    const secondTab = {};
    const metadata = { kind: 'station' as const, stationId: 'station-a', userId: 'user-1', username: 'one', visitorId: 'visitor-1' };

    registry.add(firstTab, metadata);
    registry.add(secondTab, metadata);
    registry.delete(firstTab);
    expect(registry.listenerCount()).toBe(1);

    registry.delete(secondTab);
    expect(registry.listenerCount()).toBe(0);
    expect(registry.eligibleVoterCount()).toBe(0);
  });

  it('counts anonymous tabs with the same browser ID once', () => {
    const registry = new ConnectionRegistry<object>();

    registry.add({}, { kind: 'station', stationId: 'station-a', userId: null, username: null, visitorId: 'visitor-1' });
    registry.add({}, { kind: 'station', stationId: 'station-a', userId: null, username: null, visitorId: 'visitor-1' });

    expect(registry.listenerCount()).toBe(1);
    expect(registry.eligibleVoterCount()).toBe(0);
  });

  it('counts different signed-in users separately', () => {
    const registry = new ConnectionRegistry<object>();

    registry.add({}, { kind: 'station', stationId: 'station-a', userId: 'user-1', username: 'one', visitorId: 'visitor-1' });
    registry.add({}, { kind: 'station', stationId: 'station-a', userId: 'user-2', username: 'two', visitorId: 'visitor-2' });

    expect(registry.listenerCount()).toBe(2);
    expect(registry.eligibleVoterCount()).toBe(2);
  });

  it('excludes embed connections from listener and voter counts', () => {
    const registry = new ConnectionRegistry<object>();

    registry.add({}, { kind: 'embed-player', stationId: 'station-a', userId: null, username: null, visitorId: null });
    registry.add({}, { kind: 'embed-playing', stationId: 'station-a', userId: null, username: null, visitorId: null });
    registry.add({}, { kind: 'embed-queue', stationId: 'station-a', userId: null, username: null, visitorId: null });

    expect(registry.listenerCount()).toBe(0);
    expect(registry.eligibleVoterCount()).toBe(0);
  });

  it('keeps every socket available for station-change broadcasts', () => {
    const registry = new ConnectionRegistry<object>();
    const stationTab = {};
    const embed = {};

    registry.add(stationTab, { kind: 'station', stationId: 'station-a', userId: null, username: null, visitorId: 'visitor-1' });
    registry.add(embed, { kind: 'embed-player', stationId: 'station-a', userId: null, username: null, visitorId: null });

    expect([...registry.clients()]).toEqual([stationTab, embed]);
  });

  it('returns an admin-safe snapshot with source, username, and connection time', () => {
    const connectedAt = new Date('2026-08-30T03:00:00.000Z');
    const registry = new ConnectionRegistry<object>(() => connectedAt);

    registry.add({}, {
      kind: 'station',
      stationId: 'station-a',
      userId: 'user-1',
      username: 'StrawWaffle',
      visitorId: 'visitor-1',
    });
    registry.add({}, {
      kind: 'embed-player',
      stationId: 'station-a',
      userId: null,
      username: null,
      visitorId: null,
    });

    expect(registry.snapshot()).toEqual({
      socketCount: 2,
      listenerCount: 1,
      eligibleVoterCount: 1,
      connections: [
        {
          kind: 'station',
          username: 'StrawWaffle',
          connectedAt: '2026-08-30T03:00:00.000Z',
        },
        {
          kind: 'embed-player',
          username: null,
          connectedAt: '2026-08-30T03:00:00.000Z',
        },
      ],
    });
  });

  it('counts each station on its own, and every station together', () => {
    const registry = new ConnectionRegistry<object>();
    const inA = {};
    const inB = {};

    registry.add(inA, { kind: 'station', stationId: 'station-a', userId: 'user-1', username: 'one', visitorId: 'v-1' });
    registry.add(inB, { kind: 'station', stationId: 'station-b', userId: 'user-2', username: 'two', visitorId: 'v-2' });
    registry.add({}, { kind: 'station', stationId: 'station-b', userId: null, username: null, visitorId: 'v-3' });

    expect(registry.listenerCount('station-a')).toBe(1);
    expect(registry.listenerCount('station-b')).toBe(2);
    expect(registry.listenerCount()).toBe(3);
    expect(registry.eligibleVoterCount('station-b')).toBe(1);
    expect([...registry.clientsInStation('station-a')]).toEqual([inA]);
    expect(registry.stationIds()).toEqual(new Set(['station-a', 'station-b']));
  });
});
