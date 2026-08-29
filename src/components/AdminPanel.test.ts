import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './AdminPanel';

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
