import { describe, expect, it } from 'vitest';
import { ConnectionRegistry } from './connections';

describe('ConnectionRegistry', () => {
  it('counts duplicate room tabs for one signed-in user as one listener and one eligible voter', () => {
    const registry = new ConnectionRegistry<object>();
    const firstTab = {};
    const secondTab = {};

    registry.add(firstTab, { kind: 'room', userId: 'user-1', username: 'one', visitorId: 'visitor-1' });
    registry.add(secondTab, { kind: 'room', userId: 'user-1', username: 'one', visitorId: 'visitor-1' });

    expect(registry.listenerCount()).toBe(1);
    expect(registry.eligibleVoterCount()).toBe(1);
  });

  it('removes a listener only after their final room connection closes', () => {
    const registry = new ConnectionRegistry<object>();
    const firstTab = {};
    const secondTab = {};
    const metadata = { kind: 'room' as const, userId: 'user-1', username: 'one', visitorId: 'visitor-1' };

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

    registry.add({}, { kind: 'room', userId: null, username: null, visitorId: 'visitor-1' });
    registry.add({}, { kind: 'room', userId: null, username: null, visitorId: 'visitor-1' });

    expect(registry.listenerCount()).toBe(1);
    expect(registry.eligibleVoterCount()).toBe(0);
  });

  it('counts different signed-in users separately', () => {
    const registry = new ConnectionRegistry<object>();

    registry.add({}, { kind: 'room', userId: 'user-1', username: 'one', visitorId: 'visitor-1' });
    registry.add({}, { kind: 'room', userId: 'user-2', username: 'two', visitorId: 'visitor-2' });

    expect(registry.listenerCount()).toBe(2);
    expect(registry.eligibleVoterCount()).toBe(2);
  });

  it('excludes embed connections from listener and voter counts', () => {
    const registry = new ConnectionRegistry<object>();

    registry.add({}, { kind: 'embed-player', userId: null, username: null, visitorId: null });
    registry.add({}, { kind: 'embed-playing', userId: null, username: null, visitorId: null });
    registry.add({}, { kind: 'embed-queue', userId: null, username: null, visitorId: null });

    expect(registry.listenerCount()).toBe(0);
    expect(registry.eligibleVoterCount()).toBe(0);
  });

  it('keeps every socket available for room-change broadcasts', () => {
    const registry = new ConnectionRegistry<object>();
    const roomTab = {};
    const embed = {};

    registry.add(roomTab, { kind: 'room', userId: null, username: null, visitorId: 'visitor-1' });
    registry.add(embed, { kind: 'embed-player', userId: null, username: null, visitorId: null });

    expect([...registry.clients()]).toEqual([roomTab, embed]);
  });

  it('returns an admin-safe snapshot with source, username, and connection time', () => {
    const connectedAt = new Date('2026-08-30T03:00:00.000Z');
    const registry = new ConnectionRegistry<object>(() => connectedAt);

    registry.add({}, {
      kind: 'room',
      userId: 'user-1',
      username: 'StrawWaffle',
      visitorId: 'visitor-1',
    });
    registry.add({}, {
      kind: 'embed-player',
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
          kind: 'room',
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
});
