import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cooldownParts,
  cooldownSeconds,
  copyText,
  elapsedTime,
  formatBytes,
  formatShare,
  moderationSummary,
  tabFromHash,
} from './AdminPanel';

describe('track repeat cooldown fields', () => {
  it('shows stored seconds in the largest whole unit', () => {
    expect(cooldownParts(5_400)).toEqual({ amount: 90, unit: 'minutes' });
    expect(cooldownParts(7_200)).toEqual({ amount: 2, unit: 'hours' });
    expect(cooldownParts(172_800)).toEqual({ amount: 2, unit: 'days' });
  });

  it('converts the admin amount back to seconds', () => {
    expect(cooldownSeconds(5, 'minutes')).toBe(300);
    expect(cooldownSeconds(24, 'hours')).toBe(86_400);
    expect(cooldownSeconds(30, 'days')).toBe(2_592_000);
  });
});

describe('storage figures', () => {
  it('reports bytes in the same units as pg_size_pretty', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(900)).toBe('900 bytes');
    expect(formatBytes(1_024)).toBe('1.0 kB');
    expect(formatBytes(5_242_880)).toBe('5.0 MB');
    expect(formatBytes(12_582_912)).toBe('12 MB');
    expect(formatBytes(3 * 1_024 ** 3)).toBe('3.0 GB');
  });

  it('keeps a share visible when rounding would hide it', () => {
    expect(formatShare(0)).toBe('0.0%');
    expect(formatShare(0.0004)).toBe('<0.1%');
    expect(formatShare(0.4167)).toBe('41.7%');
    expect(formatShare(1)).toBe('100.0%');
  });
});

describe('summarising a moderation record', () => {
  const entry = (action: string, details: Record<string, unknown>) => ({
    id: 'a',
    actor: 'StrawWaffle',
    action,
    track: null,
    target: null,
    reason: null,
    details,
    createdAt: '2026-08-30T04:00:00.000Z',
  });

  it('names the settings that changed', () => {
    expect(moderationSummary(entry('update_settings', { skipDownvotes: 3, targetCountry: 'AE' }))).toBe(
      'Changed skipDownvotes, targetCountry.',
    );
  });

  it('counts what a cleared queue dropped', () => {
    expect(moderationSummary(entry('clear_queue', { removed: 1 }))).toBe('1 track dropped.');
    expect(moderationSummary(entry('clear_queue', { removed: 4 }))).toBe('4 tracks dropped.');
  });

  it('counts a reordered queue', () => {
    expect(moderationSummary(entry('reorder_room_queue', { orderedIds: ['a', 'b'] }))).toBe(
      '2 tracks put in a new order.',
    );
  });

  // A skip carries its reason, which is shown on its own line instead.
  it('adds nothing for an action that explains itself', () => {
    expect(moderationSummary(entry('skip', { reason: 'off theme' }))).toBeNull();
  });
});

describe('the tab in the URL hash', () => {
  it('opens the named tab', () => {
    expect(tabFromHash('#server')).toBe('server');
    expect(tabFromHash('#people')).toBe('people');
    expect(tabFromHash('#obs')).toBe('obs');
  });

  it('falls back to the room tab for an empty or unknown hash', () => {
    expect(tabFromHash('')).toBe('room');
    expect(tabFromHash('#')).toBe('room');
    expect(tabFromHash('#storage')).toBe('room');
  });
});

describe('server activity durations', () => {
  it('formats a connection age from the captured snapshot time', () => {
    expect(elapsedTime('2026-08-30T03:00:00.000Z', '2026-08-30T03:04:08.000Z')).toBe('4m 8s');
    expect(elapsedTime('2026-08-29T01:00:00.000Z', '2026-08-30T03:00:00.000Z')).toBe('1d 2h');
  });
});

describe('copyText', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the Clipboard API when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await copyText('http://radio.test/embed/player');

    expect(writeText).toHaveBeenCalledWith('http://radio.test/embed/player');
  });

  it('falls back to execCommand on an insecure origin', async () => {
    const textarea = {
      value: '',
      setAttribute: vi.fn(),
      style: {},
      select: vi.fn(),
      remove: vi.fn(),
    };
    const append = vi.fn();
    const execCommand = vi.fn(() => true);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {
      createElement: vi.fn(() => textarea),
      body: { append },
      execCommand,
    });

    await copyText('http://192.168.1.10:4321/embed/player');

    expect(textarea.value).toBe('http://192.168.1.10:4321/embed/player');
    expect(append).toHaveBeenCalledWith(textarea);
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(textarea.remove).toHaveBeenCalledOnce();
  });

  it('rejects when the fallback copy is refused', async () => {
    const textarea = {
      value: '',
      setAttribute: vi.fn(),
      style: {},
      select: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {
      createElement: vi.fn(() => textarea),
      body: { append: vi.fn() },
      execCommand: vi.fn(() => false),
    });

    await expect(copyText('http://radio.test')).rejects.toThrow(
      'The browser refused to copy the URL.',
    );
    expect(textarea.remove).toHaveBeenCalledOnce();
  });
});
