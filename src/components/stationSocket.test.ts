import { describe, expect, it, vi } from 'vitest';
import { createStationSocketUrl, getStationVisitorId } from './stationSocket';

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, nextValue: string) => {
      value = nextValue;
    }),
  };
}

describe('station WebSocket identity', () => {
  it('reuses one stable visitor ID across station tabs', () => {
    const storage = memoryStorage();
    const generateId = vi.fn(() => '00000000-0000-4000-8000-000000000001');

    expect(getStationVisitorId(storage, generateId)).toBe('00000000-0000-4000-8000-000000000001');
    expect(getStationVisitorId(storage, generateId)).toBe('00000000-0000-4000-8000-000000000001');
    expect(generateId).toHaveBeenCalledOnce();
  });

  it('replaces a malformed stored visitor ID before connecting', () => {
    const storage = memoryStorage('not-a-uuid');
    const generateId = vi.fn(() => '00000000-0000-4000-8000-000000000002');

    expect(getStationVisitorId(storage, generateId)).toBe('00000000-0000-4000-8000-000000000002');
    expect(storage.setItem).toHaveBeenCalledWith(
      'dgg-radio:visitor-id',
      '00000000-0000-4000-8000-000000000002',
    );
  });

  it('labels station and embed sockets explicitly, with the station they watch', () => {
    expect(
      createStationSocketUrl('https://radio.example', {
        kind: 'station',
        station: 'main',
        visitorId: '00000000-0000-4000-8000-000000000001',
      }).toString(),
    ).toBe(
      'wss://radio.example/ws?kind=station&station=main&visitorId=00000000-0000-4000-8000-000000000001',
    );
    expect(
      createStationSocketUrl('http://localhost:3000', { kind: 'embed-player', station: 'late-night' }).toString(),
    ).toBe('ws://localhost:3000/ws?kind=embed-player&station=late-night');
  });
});
