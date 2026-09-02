import { defineMiddleware } from 'astro:middleware';

/**
 * Netlify applies the matching rules in public/_redirects after deployment.
 * Astro's local dev server does not read that file, so the shells that stand
 * behind a path segment are made reachable at the same URLs while developing.
 *
 * Each of these is one prerendered page serving every id under it, because the
 * ids are not knowable at build time: a listener's name, a provider's id for a
 * track, a channel. Keep this list and `public/_redirects` in step.
 */
const SHELLS = [
  { path: /^\/profile\/[^/]+\/?$/, shell: '/profile/' },
  { path: /^\/track\/[^/]+\/[^/]+\/?$/, shell: '/track/' },
  { path: /^\/artist\/[^/]+\/[^/]+\/?$/, shell: '/artist/' },
];

export const onRequest = defineMiddleware((context, next) => {
  for (const { path, shell } of SHELLS) {
    if (path.test(context.url.pathname)) return context.rewrite(shell);
  }
  return next();
});
