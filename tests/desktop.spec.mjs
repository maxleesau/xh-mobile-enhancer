import { test, expect, HOME, gotoWatchPage } from './helpers.mjs';

test.describe('boot', () => {
  test('runs at document-start and exposes the debug seam', async ({ page }) => {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(HOME, { waitUntil: 'domcontentloaded' });

    const seam = await page.evaluate(() => window.__xhe && {
      version: window.__xhe.version,
      featureCount: window.__xhe.features.length,
      hasConfig: !!window.__xhe.config.SEL,
    });

    expect(seam, 'window.__xhe missing — script did not run in the page world').toBeTruthy();
    expect(seam.version).toBe('0.1.0');
    expect(seam.hasConfig).toBe(true);
    expect(errors.filter((e) => /xhe/i.test(e))).toEqual([]);
  });
});

test.describe('settings panel', () => {
  test('renders one toggle per feature and persists a change', async ({ page }) => {
    await page.goto(HOME, { waitUntil: 'domcontentloaded' });

    const fab = page.locator('.xhe-fab');
    await expect(fab, 'the ≡ button never mounted').toBeVisible();
    await fab.click();

    const boxes = page.locator('.xhe-panel input[type=checkbox]');
    const featureCount = await page.evaluate(() => window.__xhe.features.length);
    await expect(boxes).toHaveCount(featureCount);

    const first = await page.evaluate(() => window.__xhe.features[0].id);
    await page.locator(`.xhe-panel input[data-xhe-id="${first}"]`).uncheck();
    await page.reload({ waitUntil: 'domcontentloaded' });

    const persisted = await page.evaluate((id) => window.__xhe.settings[id], first);
    expect(persisted, 'toggle did not survive a reload').toBe(false);
  });
});

test.describe('layout', () => {
  test('hides comments and promos and suppresses preview videos', async ({ page }) => {
    await gotoWatchPage(page);

    const css = await page.evaluate(() => window.__xhe.css);
    expect(css, 'comments selectors missing from the stylesheet').toContain('#comments');
    expect(css, 'promo selectors missing from the stylesheet').toContain('premium-banner');
    expect(css, 'content-visibility not applied to thumbnail grids').toContain('content-visibility');

    const visibleComments = await page.evaluate(() => {
      const sel = window.__xhe.config.SEL.hideComments.join(',');
      return [...document.querySelectorAll(sel)]
        .filter((el) => el.getBoundingClientRect().height > 0).length;
    });
    expect(visibleComments, 'a comments block is still visible').toBe(0);

    const playingPreviews = await page.evaluate(() => {
      const grid = window.__xhe.config.SEL.thumbGrid;
      return [...document.querySelectorAll(`${grid} video`)].filter((v) => !v.paused).length;
    });
    expect(playingPreviews, 'thumbnail preview videos are decoding').toBe(0);
  });
});

test.describe('interstitials', () => {
  test('cookie banner and 18+ gate are gone', async ({ page }) => {
    await gotoWatchPage(page);

    await expect.poll(async () => page.evaluate(() => {
      const { consentRoot, ageGateRoot } = window.__xhe.config.SEL;
      return [...document.querySelectorAll(`${consentRoot},${ageGateRoot}`)]
        .filter((el) => el.getBoundingClientRect().height > 0).length;
    }), { timeout: 20_000, message: 'an interstitial is still on screen' }).toBe(0);
  });
});

test.describe('spa navigation', () => {
  test('rebuilds the context in place without a document load', async ({ page }) => {
    await gotoWatchPage(page);

    // Survives an in-page route change; dies on a real navigation.
    await page.evaluate(() => { window.__navMarker = true; });
    const before = await page.evaluate(() => window.__xhe.ctx.id);

    const related = page.locator('a[href*="/videos/"]').nth(3);
    await related.scrollIntoViewIfNeeded();
    await related.click();

    await expect.poll(() => page.evaluate(() => window.__xhe.ctx.id),
      { timeout: 20_000, message: 'context was never rebuilt' }).not.toBe(before);

    const state = await page.evaluate(() => ({
      marker: window.__navMarker === true,
      disposers: window.__xhe.ctx.disposers.length,
    }));

    // If the marker is gone the site did a real page load; that is acceptable
    // behaviour for the site, but then the context test above is vacuous.
    expect(state.marker, 'the site performed a full page load, not SPA routing').toBe(true);
    expect(state.disposers, 'disposers accumulated across navigation').toBeLessThan(20);
  });
});

test.describe('autostart and sound', () => {
  test('starts on its own, with sound or a one-click fallback', async ({ page }) => {
    await gotoWatchPage(page);

    await expect.poll(() => page.evaluate(() => {
      const v = window.__xhe.ctx.mainVideo;
      return !!v && !v.paused;
    }), { timeout: 30_000, message: 'the main video never started' }).toBe(true);

    const state = await page.evaluate(() => {
      const c = window.__xhe.ctx;
      return { muted: c.mainVideo.muted, granted: c.soundGranted, awaiting: c.awaitingGesture };
    });
    expect(state.granted || state.awaiting,
      'neither sound path was taken — autostart is not wired to the sound logic').toBe(true);

    if (state.awaiting) {
      // Playwright clicks are trusted, which is exactly what the guard wants.
      await page.mouse.click(5, 5);
      await expect.poll(() => page.evaluate(() => window.__xhe.ctx.mainVideo.muted),
        { timeout: 10_000, message: 'first click did not unmute' }).toBe(false);
    } else {
      expect(state.muted, 'sound was granted but the element is muted').toBe(false);
    }

    const noisySecondaries = await page.evaluate(() => {
      const c = window.__xhe.ctx;
      return [...document.querySelectorAll('video')].filter((v) => v !== c.mainVideo && !v.muted).length;
    });
    expect(noisySecondaries, 'a secondary player can make noise').toBe(0);
  });
});

test.describe('end of video', () => {
  test('stops rather than chaining to the next video', async ({ page }) => {
    await gotoWatchPage(page);
    await expect.poll(() => page.evaluate(() => !!window.__xhe.ctx.mainVideo),
      { timeout: 30_000 }).toBe(true);

    const result = await page.evaluate(() => {
      const v = window.__xhe.ctx.mainVideo;
      let siteHandlerRan = false;
      v.addEventListener('ended', () => { siteHandlerRan = true; });
      v.dispatchEvent(new Event('ended'));
      return { siteHandlerRan, paused: v.paused };
    });

    expect(result.siteHandlerRan, "the site's end handler still runs — chaining is possible").toBe(false);
    expect(result.paused, 'the player did not pause at the end').toBe(true);

    const css = await page.evaluate(() => window.__xhe.css);
    expect(css, 'end-card selectors missing from the stylesheet').toContain('next-video');
  });
});

test.describe('quality', () => {
  test('pins to the highest rendition that plays', async ({ page }) => {
    await gotoWatchPage(page);

    await expect.poll(() => page.evaluate(() => window.__xhe.ctx.qualityTarget !== null),
      { timeout: 30_000, message: 'quality was never pinned' }).toBe(true);

    const q = await page.evaluate(() => {
      const c = window.__xhe.ctx;
      return { target: c.qualityTarget, demotions: c.qualityDemotions, playing: !c.mainVideo.paused };
    });

    expect(q.target, 'pinned to a negative index').toBeGreaterThanOrEqual(0);
    expect(q.playing, 'pinning the top rendition stalled playback').toBe(true);
  });
});

test.describe('quality step-down', () => {
  test('step-down arithmetic is correct', async ({ page }) => {
    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    const table = await page.evaluate(() => {
      const f = window.__xhe.debug.stepDownTarget;
      return [f(5, 0, 3), f(5, 1, 3), f(5, 3, 3), f(0, 0, 3)];
    });
    // demote by one each time; null means "give up and let ABR decide"
    expect(table).toEqual([4, 4, null, null]);
  });

  test('a demoted context keeps playing', async ({ page }) => {
    await gotoWatchPage(page);
    await expect.poll(() => page.evaluate(() => !!window.__xhe.ctx.mainVideo), { timeout: 30_000 }).toBe(true);

    const result = await page.evaluate(async () => {
      const c = window.__xhe.ctx;
      window.__xhe.debug.demote(c);
      await new Promise((r) => setTimeout(r, 4000));
      return { demotions: c.qualityDemotions, paused: c.mainVideo.paused };
    });

    expect(result.demotions, 'demotion was not recorded').toBe(1);
    expect(result.paused, 'playback died after a demotion').toBe(false);
  });
});

test.describe('buffering', () => {
  test('buffer runs ahead of playback', async ({ page }) => {
    await gotoWatchPage(page);
    await expect.poll(() => page.evaluate(() => {
      const v = window.__xhe.ctx.mainVideo;
      return !!v && !v.paused;
    }), { timeout: 30_000 }).toBe(true);

    expect(await page.evaluate(() => window.__xhe.ctx.mainVideo.preload)).toBe('auto');

    await expect.poll(() => page.evaluate(() => {
      const v = window.__xhe.ctx.mainVideo;
      if (!v.buffered.length) return 0;
      return v.buffered.end(v.buffered.length - 1) - v.currentTime;
    }), { timeout: 45_000, message: 'buffer never ran ahead of playback' }).toBeGreaterThan(20);
  });
});
