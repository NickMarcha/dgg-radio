import { describe, expect, it } from 'vitest';
import { resolveFlair } from './flair';

describe('resolveFlair', () => {
  it('takes the flair that wins in the stylesheet, not the first one held', () => {
    // flair1 is declared after subscriber, so it overrides it in chat.
    expect(resolveFlair(['flair5', 'flair1', 'subscriber'])).toBe('flair1');
    expect(resolveFlair(['flair5', 'flair3', 'subscriber'])).toBe('flair3');
  });

  it('does not depend on the order the features arrive in', () => {
    expect(resolveFlair(['subscriber', 'flair1'])).toBe('flair1');
    expect(resolveFlair(['flair1', 'subscriber'])).toBe('flair1');
  });

  it('lets admin outrank the ordinary flairs it is declared after', () => {
    expect(resolveFlair(['subscriber', 'admin'])).toBe('admin');
    expect(resolveFlair(['admin', 'flair17'])).toBe('flair17');
  });

  it('has no colour for flairs the stylesheet never colours', () => {
    expect(resolveFlair(['flair5'])).toBeNull();
    expect(resolveFlair([])).toBeNull();
  });
});
