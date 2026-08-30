import { describe, expect, it, vi } from 'vitest';
import { createRoomSocketUrl, getRoomVisitorId } from './roomSocket';

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, nextValue: string) => {
      value = nextValue;
    }),
  };
}

describe('room WebSocket identity', () => {
  it('reuses one stable visitor ID across room tabs', () => {
    const storage = memoryStorage();
    const generateId = vi.fn(() => '00000000-0000-4000-8000-000000000001');

    expect(getRoomVisitorId(storage, generateId)).toBe('00000000-0000-4000-8000-000000000001');
    expect(getRoomVisitorId(storage, generateId)).toBe('00000000-0000-4000-8000-000000000001');
    expect(generateId).toHaveBeenCalledOnce();
  });

  it('replaces a malformed stored visitor ID before connecting', () => {
    const storage = memoryStorage('not-a-uuid');
    const generateId = vi.fn(() => '00000000-0000-4000-8000-000000000002');

    expect(getRoomVisitorId(storage, generateId)).toBe('00000000-0000-4000-8000-000000000002');
    expect(storage.setItem).toHaveBeenCalledWith(
      'dgg-radio:visitor-id',
      '00000000-0000-4000-8000-000000000002',
    );
  });

  it('labels room and embed sockets explicitly', () => {
    expect(
      createRoomSocketUrl('https://radio.example', {
        kind: 'room',
        visitorId: '00000000-0000-4000-8000-000000000001',
      }).toString(),
    ).toBe(
      'wss://radio.example/ws?kind=room&visitorId=00000000-0000-4000-8000-000000000001',
    );
    expect(createRoomSocketUrl('http://localhost:3000', { kind: 'embed-player' }).toString()).toBe(
      'ws://localhost:3000/ws?kind=embed-player',
    );
  });
});
