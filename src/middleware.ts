import { defineMiddleware } from 'astro:middleware';

/**
 * Netlify applies the matching rule in public/_redirects after deployment.
 * Astro's local dev server does not read that file, so make the profile shell
 * reachable at the same URL while developing locally.
 */
export const onRequest = defineMiddleware((context, next) => {
  if (/^\/profile\/[^/]+\/?$/.test(context.url.pathname)) {
    return context.rewrite('/profile/');
  }
  return next();
});
