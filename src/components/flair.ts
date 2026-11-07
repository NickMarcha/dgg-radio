import type { StationUser } from '../shared/contracts';

/**
 * The class that colours a username the way Destiny chat does. The winning
 * flair is chosen on the server; this only names the rule in flairs.css.
 */
export function userClass(user: StationUser, base?: string): string | undefined {
  const flair = user.flair ? `flair-${user.flair}` : '';
  const classes = [base ?? '', flair].filter(Boolean).join(' ');
  return classes || undefined;
}
