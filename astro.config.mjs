// @ts-check
import react from '@astrojs/react';
import posthog from '@posthog/rollup-plugin';
import { defineConfig } from 'astro/config';

/**
 * Source maps go to PostHog so error tracking can turn a minified frame back
 * into a line of TypeScript, and are deleted from `dist` once uploaded so the
 * site stops serving them.
 *
 * The upload needs a personal API key, which a build has no business requiring:
 * without one the build runs exactly as before and keeps the maps in `dist`,
 * which is what a local build wants anyway. Netlify supplies `COMMIT_REF`, so a
 * resolved trace names the commit that produced it.
 *
 * Astro builds more than once and uploads from each pass, so a deploy sends
 * some chunks that only ever ran during prerendering. Telling the passes apart
 * means reading `isSsrBuild`, which Astro leaves undefined for some of them;
 * getting that wrong uploads nothing and says nothing, so the wasted upload is
 * the better trade.
 */
const personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY;
const projectId = process.env.POSTHOG_PROJECT_ID;

const uploadSourceMaps =
  personalApiKey && projectId
    ? [
        posthog({
          personalApiKey,
          projectId,
          // The same PostHog instance the browser reports to.
          host: process.env.PUBLIC_POSTHOG_HOST,
          sourcemaps: {
            releaseName: 'dgg-radio-web',
            releaseVersion: process.env.COMMIT_REF,
            deleteAfterUpload: true,
          },
        }),
      ]
    : [];

export default defineConfig({
  integrations: [react()],
  vite: {
    build: {
      sourcemap: true,
    },
    plugins: uploadSourceMaps,
  },
});
