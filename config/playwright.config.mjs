import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../tests',
  testMatch: /.*\.spec\.mjs/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    // The bundled Chromium has no H.264/AAC and cannot decode the site's
    // video. This must stay 'chrome' (or 'msedge').
    channel: 'chrome',
    headless: false,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    // Silences the machine without touching the autoplay policy, which keys
    // off the element's muted property, not the process audio mute.
    launchOptions: { args: ['--mute-audio'] },
  },
});
