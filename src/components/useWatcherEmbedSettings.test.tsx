// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WatcherEmbedSettings } from '../shared/contracts';
import { useWatcherEmbedSettings } from './useWatcherEmbedSettings';

const API = 'http://api.test';
const OWNER = '00000000-0000-4000-8000-000000000001';

function settings(
  layout: WatcherEmbedSettings['layout'],
  updatedAt: string,
): WatcherEmbedSettings {
  return {
    ownerId: OWNER,
    show: 'speakers',
    window: 10,
    max: 12,
    layout,
    names: 'under',
    enter: 'fade',
    motion: 'drift',
    speed: 100,
    roam: 100,
    inset: 4,
    updatedAt,
  };
}

function Harness() {
  const current = useWatcherEmbedSettings(API, OWNER);
  return <p>{current?.layout ?? 'loading'}</p>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useWatcherEmbedSettings', () => {
  it('bypasses the browser cache and checks again while the source stays open', async () => {
    const calls: RequestInit[] = [];
    let count = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init ?? {});
        count += 1;
        const body = count === 1
          ? settings('float', '2026-09-05T21:00:00.000Z')
          : settings('climb', '2026-09-05T21:00:01.000Z');
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
      }),
    );

    render(<Harness />);

    await screen.findByText('float');
    await waitFor(() => expect(screen.getByText('climb')).toBeDefined(), { timeout: 1_500 });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((init) => init.cache === 'no-store')).toBe(true);
  });
});
