import { describe, expect, it } from 'vitest';
import { teamFromFeatures } from './auth';

describe('teamFromFeatures', () => {
  it('maps the production Destiny team flair features', () => {
    expect(teamFromFeatures(['flair35'])).toBe('pepe');
    expect(teamFromFeatures(['flair36'])).toBe('yee');
  });

  it('does not guess if both or neither team feature is present', () => {
    expect(teamFromFeatures([])).toBeNull();
    expect(teamFromFeatures(['flair35', 'flair36'])).toBeNull();
  });
});
