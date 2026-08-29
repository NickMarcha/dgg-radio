import { afterEach, describe, expect, it, vi } from 'vitest';
import { cooldownParts, cooldownSeconds, copyText } from './AdminPanel';

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
