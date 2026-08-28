import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    // The integration suites share one Postgres and truncate between cases, so
    // running two files at once lets one wipe the other's rows mid-test.
    fileParallelism: false,
  },
});
