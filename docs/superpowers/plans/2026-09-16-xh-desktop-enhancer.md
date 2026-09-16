# xh Desktop Enhancer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `xh-desktop-enhancer.user.js` — a Chrome/Edge userscript that forces the highest playable video quality, buffers as far ahead as the browser allows, starts playback with sound, strips comments/promos/interstitials, and re-enhances in place across SPA navigation.

**Architecture:** A single-file userscript injected at `document-start` in the page world (`@grant none`). All features are declared in one `FEATURES` array of descriptors with lifecycle hooks (`onStart`, `onNavigate`, `onMutate`, `onSweep`, `css`); the settings panel and the lifecycle both iterate that one array. All mutable per-page state lives in a `PageContext` that is disposed and replaced on SPA navigation, which is what makes in-place re-enhancement safe.

**Tech Stack:** Vanilla ES2022 (evergreen Chromium only), no runtime dependencies, no build step. Tests: `@playwright/test` driving the installed Chrome via `channel: 'chrome'`.

**Spec:** `docs/superpowers/specs/2026-09-16-xh-desktop-enhancer-design.md`

## Global Constraints

- **Target:** Chrome and Edge only (evergreen Chromium). No Firefox, no Safari, no polyfills.
- **`@grant none` is mandatory** — it is what places the script in the page world. Adding any other `@grant` sandboxes the script and breaks the media-library hook. Never add one.
- **No ad, tracker, popunder or `window.open` features of any kind.** uBlock Origin handles that. This is a scope rule, not a preference.
- **No keyboard shortcuts** for playback.
- **Single file, no build step, no runtime dependencies.** Target under 500 lines (`CLAUDE.md` rule).
- **Settings storage key:** `xhe:desktop:v1` — distinct from the iOS script's `xhe:settings:v1`.
- **Script version:** `0.1.0` in the `@version` header and in `window.__xhe.version`. Both must match.
- **Playwright must use `channel: 'chrome'`** — the bundled Chromium has no H.264/AAC and cannot decode the site's video.
- **Never set `--autoplay-policy=no-user-gesture-required`** — it would make the sound-fallback path untestable.
- **No credentials anywhere.** Tests run logged out, against a fresh profile.
- **Commits carry no `Co-Authored-By` trailer** (this repo has no `.claude/settings.json` with `attribution.commit`).
- **Do not modify** `xh-mobile-enhancer.user.js` or `test/smoke.mjs`. `npm test` must keep working unchanged.

---

## File Structure

| File | Responsibility |
|---|---|
| `xh-desktop-enhancer.user.js` | Create. The entire userscript: CONFIG, FEATURES, PageContext, navigation, styles, panel. |
| `config/playwright.config.mjs` | Create. Playwright config — Chrome channel, single worker, long timeouts. |
| `tests/helpers.mjs` | Create. Test fixture that injects the userscript, plus `gotoWatchPage()`. |
| `tests/desktop.spec.mjs` | Create. The whole Playwright suite; one `test.describe` block per feature area. |
| `package.json` | Modify. Add `test:desktop` script and the `@playwright/test` devDependency. |
| `README.md` | Modify. Add a desktop section; keep the iOS content intact. |

---

## Task 0: Resolve the blocking unknown (no code)

**This gates Task 8, 9 and 10 only.** Tasks 1–7 and 11 can proceed without it.

Chromium has no native HLS, so the site is using MSE (hls.js or dash.js) or progressive MP4, and the quality feature is built differently for each.

- [ ] **Step 1: Inspect a watch page**

Open any video on `xhamster.com` in Chrome, open DevTools → Network, reload, and filter for `m3u8`, then `mpd`, then `.mp4`.

- [ ] **Step 2: Inspect the page globals**

In the DevTools Console on the same page:

```js
({ hls: typeof window.Hls, dash: typeof window.dashjs,
   src: document.querySelector('video')?.src?.slice(0, 80) })
```

- [ ] **Step 3: Record the verdict in the spec**

Append the finding to the "Open questions" section of `docs/superpowers/specs/2026-09-16-xh-desktop-enhancer-design.md`, then commit:

```bash
git add docs/superpowers/specs/2026-09-16-xh-desktop-enhancer-design.md
git commit -m "docs: record media delivery path finding"
```

Verdict decides which variant of Task 8 you implement:

| Finding | Variant |
|---|---|
| `m3u8` present and `typeof window.Hls === 'function'` | **8A — hls.js** |
| `mpd` present and `typeof window.dashjs === 'object'` | **8B — dash.js** |
| `video.src` is an `https://…mp4` URL, no blob | **8C — progressive MP4** |

---

## Task 1: Scaffold the userscript and the Playwright harness

**Files:**
- Create: `xh-desktop-enhancer.user.js`
- Create: `config/playwright.config.mjs`
- Create: `tests/helpers.mjs`
- Create: `tests/desktop.spec.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `defineFeature(descriptor)`, `FEATURES` array, `CONFIG` object, `settings` object, `loadSettings()`, `saveSettings()`, `qs(sel, root)`, `qsa(sel, root)`, `isVisible(el)`, `forEachSiteKey(pattern, fn)`, `writeSiteKey(key, value)`, `findMainVideo()`, and the debug seam `window.__xhe = { version, config, features, settings, get ctx(), get css() }`. Test helpers produce `test`, `expect`, `HOME`, `gotoWatchPage(page)`.

- [ ] **Step 1: Install the test dependency**

```bash
npm install --save-dev @playwright/test
```

- [ ] **Step 2: Add the test script to `package.json`**

Add to `scripts` (leave `test` exactly as it is — it runs the iOS harness):

```json
"test:desktop": "node --check xh-desktop-enhancer.user.js && playwright test -c config/playwright.config.mjs"
```

- [ ] **Step 3: Write `config/playwright.config.mjs`**

```js
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
```

- [ ] **Step 4: Write `tests/helpers.mjs`**

```js
import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'xh-desktop-enhancer.user.js');

export const HOME = 'https://xhamster.com/';

// addInitScript runs before any page script, in the page world — the exact
// equivalent of @run-at document-start with @grant none. The file under test
// is byte-identical to the file a user installs.
export const test = base.extend({
  page: async ({ browser }, use) => {
    const context = await browser.newContext();
    await context.addInitScript({ path: SCRIPT });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };

// Video IDs rot, so never hardcode one: land on the home page and follow the
// first watch link the site offers.
export async function gotoWatchPage(page) {
  await page.goto(HOME, { waitUntil: 'domcontentloaded' });
  const link = page.locator('a[href*="/videos/"]').first();
  await link.waitFor({ state: 'attached', timeout: 20_000 });
  const href = await link.getAttribute('href');
  await page.goto(new URL(href, HOME).href, { waitUntil: 'domcontentloaded' });
  return page.url();
}
```

- [ ] **Step 5: Write the failing test**

Create `tests/desktop.spec.mjs`:

```js
import { test, expect, HOME } from './helpers.mjs';

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
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm run test:desktop -- -g "debug seam"`
Expected: FAIL — `xh-desktop-enhancer.user.js` does not exist (`node --check` errors first).

- [ ] **Step 7: Write the userscript skeleton**

Create `xh-desktop-enhancer.user.js`:

```js
// ==UserScript==
// @name         xh Desktop Enhancer
// @namespace    maxleesau.xh-desktop-enhancer
// @version      0.1.0
// @description  Max quality, autostart with sound, and a clean page for xhamster.com in Chrome and Edge.
// @match        https://xhamster.com/*
// @match        https://*.xhamster.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * xh Desktop Enhancer — Chrome/Edge companion to xh-mobile-enhancer.
 *
 * @grant none is load-bearing: it puts this script in the PAGE world, which
 * the media-library hook needs. Any other @grant sandboxes it.
 *
 * Assumes uBlock Origin handles ads and trackers. This script has no ad
 * features and never blocks a request.
 *
 * Every selector lives in CONFIG. Each feature no-ops silently when its
 * selectors miss, so a stale selector cannot break the site.
 */
(() => {
  'use strict';

  const VERSION = '0.1.0';

  // ===================================================================
  // CONFIG — the only block that should need editing after a redesign
  // ===================================================================
  const CONFIG = Object.freeze({
    STORAGE_KEY: 'xhe:desktop:v1',
    SWEEP_INTERVAL_MS: 500,

    SEL: Object.freeze({
      player: '.player-container, #player, .xplayer, [data-role="player"]',
      endCard: '[class*="next-video"], [class*="autoplay-overlay"], ' +
               '[class*="video-ended"], [class*="end-card"], [class*="up-next"]',
      qualityMenuButton: '[data-role="quality-button"], .quality-selector, ' +
                         '[class*="quality"] button, button[class*="quality"]',
      qualityMenuItem: '[data-role="quality-item"], .quality-list li, ' +
                       '[class*="quality"] [role="menuitem"], [class*="quality-option"]',
      consentRoot: '#cookie-banner, .cookie-banner, [class*="cookies-modal"], ' +
                   '[id*="consent"], [class*="consent-banner"], [class*="gdpr"]',
      consentReject: '[data-role="reject-all"], [class*="reject"], [class*="decline"], ' +
                     '[class*="deny"], button[class*="necessary-only"]',
      consentClose: '[class*="close"], [aria-label*="close" i]',
      ageGateRoot: '[class*="age-verification"], [class*="age-gate"], ' +
                   '[id*="age-verification"], [class*="disclaimer-modal"]',
      ageGateConfirm: '[data-role="age-confirm"], [class*="confirm"], [class*="enter"], ' +
                      '[class*="agree"], [class*="over-18"], [class*="i-am"]',
      hidePromos: Object.freeze([
        '[class*="premium-banner"]', '[class*="upsell"]', '[class*="promo-"]',
        '[class*="-promo"]', '[class*="subscribe-banner"]', '[class*="newsletter"]',
        '[class*="app-install"]', '[class*="pwa-"]', '[class*="push-notification"]',
        '[class*="get-app"]', '[class*="paysite"]', '[class*="gold-"]',
        '[class*="upgrade-banner"]',
      ]),
      hideComments: Object.freeze([
        '#comments', '.comments', '[class*="comments-block"]',
        '[class*="comment-list"]', '[class*="comments-wrapper"]',
        '[class*="comment-form"]', '[data-role="comments"]',
        '[class*="comments-header"]', '[class*="comments-counter"]',
      ]),
      thumbGrid: '[class*="thumb-list"], [class*="video-thumb"], [class*="thumbs-"]',
    }),

    // Which URL changes deserve a fresh PageContext. Browsing categories and
    // search must not churn.
    WATCH_PATH: /^\/(videos?|embed|moments)\//i,

    SITE_KEYS: Object.freeze({
      quality: /qual/i,
      autoplayNext: /(autoplay|auto_?next|continuous)/i,
      ageConfirmed: /(age|adult|disclaimer|over_?18|nsfw)/i,
    }),
  });

  // ===================================================================
  // Feature registry — the only list of features
  // ===================================================================
  const FEATURES = [];
  const NOOP = () => {};

  function defineFeature(f) {
    FEATURES.push({
      needsReload: false,
      css: () => '',
      onStart: NOOP,
      onNavigate: NOOP,
      onMutate: NOOP,
      onSweep: NOOP,
      ...f,
    });
    return f;
  }

  const enabled = (f) => settings[f.id] !== false;
  const each = (hook, ...args) => {
    for (const f of FEATURES) {
      if (!enabled(f)) continue;
      try { f[hook](...args); } catch (e) { /* one feature must never break the rest */ }
    }
  };

  // ===================================================================
  // Settings
  // ===================================================================
  let settings = loadSettings();

  function defaults() {
    return Object.fromEntries(FEATURES.map((f) => [f.id, f.default !== false]));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* private mode or corrupt value */ }
    return {};
  }

  function saveSettings() {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(settings));
    } catch (e) { /* private mode — settings live for this page load only */ }
  }

  // ===================================================================
  // Small helpers
  // ===================================================================
  const qs = (sel, root = document) => { try { return root.querySelector(sel); } catch (e) { return null; } };
  const qsa = (sel, root = document) => { try { return [...root.querySelectorAll(sel)]; } catch (e) { return []; } };

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function forEachSiteKey(pattern, fn) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && pattern.test(key) && !key.startsWith('xhe:')) fn(key, localStorage.getItem(key));
      }
    } catch (e) { /* storage unavailable */ }
  }

  function writeSiteKey(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* quota or private mode */ }
  }

  function findMainVideo() {
    let best = null, bestArea = 0;
    for (const v of qsa('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
  }

  // ===================================================================
  // Bootstrap (expanded in later tasks)
  // ===================================================================
  let ctx = null;

  settings = { ...defaults(), ...settings };

  // Deliberate testability seam: the Playwright suite has no other way to
  // assert internal state against a real player.
  window.__xhe = {
    version: VERSION,
    config: CONFIG,
    features: FEATURES,
    get settings() { return settings; },
    get ctx() { return ctx; },
    get css() { return ''; },
  };
})();
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm run test:desktop -- -g "debug seam"`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add xh-desktop-enhancer.user.js config/playwright.config.mjs tests/helpers.mjs tests/desktop.spec.mjs package.json package-lock.json
git commit -m "feat: scaffold desktop userscript and Playwright harness"
```

---

## Task 2: Settings persistence, style engine and the ≡ panel

**Files:**
- Modify: `xh-desktop-enhancer.user.js`
- Modify: `tests/desktop.spec.mjs`

**Interfaces:**
- Consumes: `FEATURES`, `defineFeature`, `settings`, `saveSettings()`, `enabled(f)`, `qs`, `qsa`.
- Produces: `buildCss()`, `applyCss()`, `mountFab()`, `togglePanel()`, `hideListCss(list)`, and a working `window.__xhe.css` getter returning the current stylesheet text.

- [ ] **Step 1: Write the failing test**

Append to `tests/desktop.spec.mjs`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:desktop -- -g "one toggle per feature"`
Expected: FAIL — `.xhe-fab` is not visible (nothing mounts it yet).

- [ ] **Step 3: Add the style engine**

Insert above the Bootstrap section of `xh-desktop-enhancer.user.js`:

```js
  // ===================================================================
  // Style engine — one sheet, rebuilt wholesale on any toggle change
  // ===================================================================
  let adoptedSheet = null;
  let styleEl = null;
  let currentCss = '';

  const hideListCss = (list) => list.join(',') + '{display:none !important;}';

  function buildCss() {
    let css = baseUiCss();
    for (const f of FEATURES) if (enabled(f)) css += f.css();
    return css;
  }

  function baseUiCss() {
    return (
      '.xhe-fab{position:fixed;left:10px;bottom:16px;z-index:2147483000;width:28px;height:28px;' +
      'border-radius:50%;border:none;background:#1c1c22;color:#fff;font-size:15px;line-height:1;' +
      'display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.45);' +
      'cursor:pointer;padding:0;opacity:.25;transition:opacity .15s;}' +
      '.xhe-fab:hover{opacity:1;}' +
      '.xhe-fab.xhe-dim{opacity:0;pointer-events:none;}' +

      '.xhe-panel{position:fixed;left:10px;bottom:52px;z-index:2147483001;width:min(300px,calc(100vw - 20px));' +
      'background:#1c1c22;color:#eee;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.55);' +
      'padding:10px 12px;font:13px/1.4 system-ui,-apple-system,sans-serif;max-height:70vh;overflow-y:auto;}' +
      '.xhe-panel h3{margin:2px 0 8px;font-size:11px;font-weight:600;letter-spacing:.4px;color:#9aa;text-transform:uppercase;}' +
      '.xhe-panel label{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:28px;}' +
      '.xhe-panel label span{flex:1;}' +
      '.xhe-panel input[type=checkbox]{width:15px;height:15px;accent-color:#e0b34c;}' +
      '.xhe-panel .xhe-note{margin:8px 0 0;font-size:10px;color:#889;}'
    );
  }

  function applyCss() {
    currentCss = buildCss();
    try {
      if (!adoptedSheet && document.adoptedStyleSheets !== undefined) {
        adoptedSheet = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, adoptedSheet];
      }
      if (adoptedSheet) { adoptedSheet.replaceSync(currentCss); return; }
    } catch (e) { adoptedSheet = null; }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'xhe-style';
    }
    styleEl.textContent = currentCss;
    if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl);
  }

  // ===================================================================
  // Settings panel — rendered from FEATURES, never a second list
  // ===================================================================
  let panel = null;

  function mountFab() {
    if (!document.body || qs('.xhe-fab')) return;
    const fab = document.createElement('button');
    fab.className = 'xhe-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Desktop Enhancer settings');
    fab.textContent = '≡';
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);
  }

  function togglePanel() {
    if (panel) { panel.remove(); panel = null; return; }
    panel = buildPanel();
    document.body.appendChild(panel);
  }

  function buildPanel() {
    const p = document.createElement('div');
    p.className = 'xhe-panel';

    const h = document.createElement('h3');
    h.textContent = 'Desktop Enhancer';
    p.appendChild(h);

    const note = document.createElement('p');
    note.className = 'xhe-note';
    note.textContent = `v${VERSION} · settings stay in this browser`;

    for (const f of FEATURES) {
      const label = document.createElement('label');
      const span = document.createElement('span');
      span.textContent = f.label;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.xheId = f.id;
      box.checked = enabled(f);
      box.addEventListener('change', () => {
        settings[f.id] = box.checked;
        saveSettings();
        applyCss();
        if (ctx) { try { f.onNavigate(ctx); } catch (e) { /* re-apply is best-effort */ } }
        if (f.needsReload) note.textContent = 'Reload the page to apply that one.';
      });
      label.append(span, box);
      p.appendChild(label);
    }

    p.appendChild(note);
    return p;
  }
```

- [ ] **Step 4: Wire it into the bootstrap**

Replace the Bootstrap section's tail (from `let ctx = null;` to the end of the IIFE) with:

```js
  let ctx = null;

  settings = { ...defaults(), ...settings };

  window.__xhe = {
    version: VERSION,
    config: CONFIG,
    features: FEATURES,
    get settings() { return settings; },
    get ctx() { return ctx; },
    get css() { return currentCss; },
  };

  applyCss();

  function onReady() {
    applyCss();
    mountFab();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:desktop -- -g "one toggle per feature"`
Expected: PASS. (`FEATURES` is still empty, so the count assertion is `0 === 0` — it becomes meaningful in Task 3 and can never drift.)

- [ ] **Step 6: Commit**

```bash
git add xh-desktop-enhancer.user.js tests/desktop.spec.mjs
git commit -m "feat: style engine and settings panel rendered from the feature registry"
```

---

## Task 3: Layout features — promos, comments, performance

**Files:**
- Modify: `xh-desktop-enhancer.user.js`
- Modify: `tests/desktop.spec.mjs`

**Interfaces:**
- Consumes: `defineFeature`, `hideListCss`, `CONFIG.SEL`.
- Produces: features `hidePromos`, `hideComments`, `performance`.

- [ ] **Step 1: Write the failing test**

Append to `tests/desktop.spec.mjs`:

```js
import { gotoWatchPage } from './helpers.mjs';

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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:desktop -- -g "hides comments and promos"`
Expected: FAIL — `css` is the base UI sheet only, so `toContain('#comments')` fails.

- [ ] **Step 3: Register the three features**

Insert immediately after the `defineFeature` helper in `xh-desktop-enhancer.user.js`:

```js
  // ===================================================================
  // Layout features — pure CSS, no ad slots (uBlock Origin covers those)
  // ===================================================================
  defineFeature({
    id: 'hidePromos',
    label: 'Hide promos & nags',
    css: () => hideListCss(CONFIG.SEL.hidePromos),
  });

  defineFeature({
    id: 'hideComments',
    label: 'Hide comments',
    css: () => hideListCss(CONFIG.SEL.hideComments),
  });

  defineFeature({
    id: 'performance',
    label: 'Performance tweaks',
    css: () => (
      // Offscreen tiles skip layout and paint; the intrinsic size stops the
      // scrollbar jumping as they resolve.
      `${CONFIG.SEL.thumbGrid} > *{content-visibility:auto;contain-intrinsic-size:200px 260px;}` +
      // Hover-preview videos are a live decode each — the deliberate
      // exception to "autostart everywhere".
      `${CONFIG.SEL.thumbGrid} video{display:none !important;}` +
      '*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;' +
      'transition-duration:0s !important;transition-delay:0s !important;}'
    ),
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:desktop -- -g "hides comments and promos"`
Expected: PASS.

- [ ] **Step 5: Re-run the panel test**

Run: `npm run test:desktop -- -g "one toggle per feature"`
Expected: PASS with three checkboxes now rendered.

- [ ] **Step 6: Commit**

```bash
git add xh-desktop-enhancer.user.js tests/desktop.spec.mjs
git commit -m "feat: hide promos, comments and preview videos"
```

---

## Task 4: Interstitials — cookie banner and 18+ gate

**Files:**
- Modify: `xh-desktop-enhancer.user.js`
- Modify: `tests/desktop.spec.mjs`

**Interfaces:**
- Consumes: `defineFeature`, `qsa`, `isVisible`, `forEachSiteKey`, `writeSiteKey`, `CONFIG.SEL`, `CONFIG.SITE_KEYS`.
- Produces: features `dismissConsent`, `skipAgeGate`; helper `clickWithin(rootSel, buttonSel)`. Both features read and write `ctx.consentDismissed` / `ctx.ageGateDismissed`, which Task 5 adds to `PageContext`; until then they latch on module-level fallbacks created in Step 3.

- [ ] **Step 1: Write the failing test**

Append to `tests/desktop.spec.mjs`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:desktop -- -g "18\\+ gate are gone"`
Expected: FAIL — on a fresh profile the age gate and cookie banner both render and nothing dismisses them.

- [ ] **Step 3: Implement both features**

Insert after the layout features:

```js
  // ===================================================================
  // Interstitials — the site's own click-throughs only. A real
  // age-verification wall (ID upload, face scan) is left alone.
  // ===================================================================
  function clickWithin(rootSel, buttonSel) {
    for (const root of qsa(rootSel)) {
      if (!isVisible(root)) continue;
      const btn = qs(buttonSel, root);
      if (btn) { btn.click(); return true; }
    }
    return false;
  }

  defineFeature({
    id: 'dismissConsent',
    label: 'Auto-dismiss cookie banner',
    // Latched per context: without it the sweep re-clicks, and on a
    // toggle-style control that means opening the banner again.
    onSweep: (c) => {
      if (c.consentDismissed) return;
      c.consentDismissed =
        clickWithin(CONFIG.SEL.consentRoot, CONFIG.SEL.consentReject) ||
        clickWithin(CONFIG.SEL.consentRoot, CONFIG.SEL.consentClose);
    },
  });

  defineFeature({
    id: 'skipAgeGate',
    label: 'Skip 18+ interstitial',
    needsReload: true,
    // Setting the site's own flag stops the gate rendering at all, rather
    // than flashing it and clicking it away.
    onStart: () => {
      forEachSiteKey(CONFIG.SITE_KEYS.ageConfirmed, (key, value) => {
        if (/^(0|false|no)$/i.test(String(value))) writeSiteKey(key, 'true');
      });
      writeSiteKey('ageConfirmed', 'true');
      writeSiteKey('age_verified', 'true');
    },
    onSweep: (c) => {
      if (c.ageGateDismissed) return;
      c.ageGateDismissed = clickWithin(CONFIG.SEL.ageGateRoot, CONFIG.SEL.ageGateConfirm);
    },
  });
```

- [ ] **Step 4: Add a minimal context and sweep so the hooks actually run**

Replace the bootstrap tail's `onReady` and add a scheduler (Task 5 replaces this with the full lifecycle):

```js
  function newPageContext() {
    return { url: location.href, consentDismissed: false, ageGateDismissed: false, lastSweep: 0 };
  }

  function sweep() {
    const now = Date.now();
    if (now - ctx.lastSweep < CONFIG.SWEEP_INTERVAL_MS) return;
    ctx.lastSweep = now;
    each('onSweep', ctx);
  }

  function startObserver() {
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; sweep(); });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  function onReady() {
    applyCss();
    mountFab();
    sweep();
  }

  ctx = newPageContext();
  each('onStart', ctx);
  applyCss();
  startObserver();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:desktop -- -g "18\\+ gate are gone"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add xh-desktop-enhancer.user.js tests/desktop.spec.mjs
git commit -m "feat: dismiss cookie banner and skip the 18+ interstitial"
```

---

## Task 5: PageContext, disposers and SPA navigation

**Files:**
- Modify: `xh-desktop-enhancer.user.js`
- Modify: `tests/desktop.spec.mjs`

**Interfaces:**
- Consumes: `each`, `CONFIG.WATCH_PATH`, `newPageContext` (replaced here).
- Produces: the full `PageContext` shape — `{ id, url, mainVideo, player, seenVideos, consentDismissed, ageGateDismissed, qualityPreferenceWritten, qualityClickAttempts, qualityTarget, qualityDemotions, soundGranted, awaitingGesture, lastSweep, disposers, on(target, type, fn, opts), dispose() }` — plus `installNavigationWatcher()` and `navigate()`.

- [ ] **Step 1: Write the failing test**

Append to `tests/desktop.spec.mjs`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:desktop -- -g "rebuilds the context"`
Expected: FAIL — `ctx.id` is undefined and `ctx.disposers` does not exist.

- [ ] **Step 3: Replace `newPageContext` with the full shape**

```js
  // ===================================================================
  // PageContext — every piece of mutable per-page state. Replaced
  // wholesale on navigation, which is what makes in-place
  // re-enhancement safe: there is no reset checklist to get wrong.
  // ===================================================================
  let contextSeq = 0;

  function newPageContext() {
    const c = {
      id: ++contextSeq,
      url: location.href,
      mainVideo: null,
      seenVideos: new WeakSet(),
      consentDismissed: false,
      ageGateDismissed: false,
      qualityPreferenceWritten: false,
      qualityClickAttempts: 0,
      qualityTarget: null,
      qualityDemotions: 0,
      soundGranted: false,
      awaitingGesture: false,
      lastSweep: 0,
      disposers: [],
      on(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        c.disposers.push(() => {
          try { target.removeEventListener(type, fn, opts); } catch (e) { /* detached */ }
        });
      },
      dispose() {
        for (const d of c.disposers.splice(0)) {
          try { d(); } catch (e) { /* best effort */ }
        }
      },
    };
    return c;
  }
```

- [ ] **Step 4: Add the navigation watcher**

```js
  // ===================================================================
  // Navigation — three signals, because routers vary
  // ===================================================================
  const isWatchUrl = (href) => {
    try { return CONFIG.WATCH_PATH.test(new URL(href, location.href).pathname); }
    catch (e) { return false; }
  };

  function installNavigationWatcher() {
    const fire = () => window.dispatchEvent(new Event('xhe:locationchange'));
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name];
      history[name] = function (...args) {
        const r = original.apply(this, args);
        fire();
        return r;
      };
    }
    window.addEventListener('popstate', fire);
    window.addEventListener('xhe:locationchange', () => maybeNavigate());
  }

  function maybeNavigate() {
    if (location.href === ctx.url) return;
    // Only a move onto or off a watch page is worth rebuilding for;
    // browsing categories and search must not churn.
    if (!isWatchUrl(location.href) && !isWatchUrl(ctx.url)) { ctx.url = location.href; return; }
    navigate();
  }

  function navigate() {
    ctx.dispose();
    ctx = newPageContext();
    each('onNavigate', ctx);
  }
```

- [ ] **Step 5: Wire the backstop and `onNavigate` into the lifecycle**

In `sweep()`, add the href backstop as the first statement (it catches routers that captured a `history` reference before our patch landed):

```js
  function sweep() {
    if (location.href !== ctx.url) { maybeNavigate(); return; }
    const now = Date.now();
    if (now - ctx.lastSweep < CONFIG.SWEEP_INTERVAL_MS) return;
    ctx.lastSweep = now;
    each('onSweep', ctx);
  }
```

And in the bootstrap tail, replace `ctx = newPageContext(); each('onStart', ctx);` with:

```js
  ctx = newPageContext();
  each('onStart', ctx);
  installNavigationWatcher();
```

and add `each('onNavigate', ctx);` as the last line of `onReady()`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:desktop -- -g "rebuilds the context"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add xh-desktop-enhancer.user.js tests/desktop.spec.mjs
git commit -m "feat: PageContext with disposers and SPA navigation re-enhancement"
```

---

## Task 6: Autostart and sound, with the muted fallback

**Files:**
- Modify: `xh-desktop-enhancer.user.js`
- Modify: `tests/desktop.spec.mjs`

**Interfaces:**
- Consumes: `defineFeature`, `findMainVideo`, `qsa`, `ctx.on`, `ctx.soundGranted`, `ctx.awaitingGesture`, `ctx.mainVideo`.
- Produces: features `autostart`, `soundOnStart`; helpers `attachToVideo(c, video, isMain)`, `tryPlay(video)`, `armGesture(c)`, `enforceMutedSecondaries(c)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/desktop.spec.mjs`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:desktop -- -g "one-click fallback"`
Expected: FAIL — `ctx.mainVideo` is null; nothing attaches to videos yet.

- [ ] **Step 3: Implement the features**

```js
  // ===================================================================
  // Autostart and sound
  //
  // Chromium refuses unmuted autoplay until the site earns enough Media
  // Engagement. So: try unmuted, and on refusal restart muted and unmute
  // on the first real click. After a few visits the unmuted attempt
  // starts succeeding on its own.
  // ===================================================================
  function tryPlay(video) {
    try {
      const p = video.play();
      return (p && p.catch) ? p : Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function attachToVideo(c, video, isMain) {
    try {
      if (!isMain) { video.muted = true; video.preload = 'metadata'; return; }
      c.mainVideo = video;
      video.autoplay = true;
      if (c.awaitingGesture) {
        video.muted = true;
      } else if (c.soundGranted && video.muted) {
        // Polarity is the opposite of the iOS script: here the site's player
        // is the adversary, re-muting an element we hold sound on.
        video.muted = false;
      }
    } catch (e) { /* element detached mid-setup */ }

    if (c.seenVideos.has(video)) return;
    c.seenVideos.add(video);
    if (!isMain) return;

    c.on(video, 'loadedmetadata', () => startMain(c, video));
    c.on(video, 'canplay', () => startMain(c, video));
    startMain(c, video);
  }

  function startMain(c, video) {
    if (c.soundGranted || c.awaitingGesture) { tryPlay(video).catch(() => {}); return; }
    video.muted = false;
    tryPlay(video)
      .then(() => { c.soundGranted = true; })
      .catch(() => {
        video.muted = true;
        c.awaitingGesture = true;
        tryPlay(video).catch(() => {});
        armGesture(c);
      });
  }

  function armGesture(c) {
    const onClick = (ev) => {
      if (!c.awaitingGesture || ev.isTrusted === false) return;
      // Our own dismissal clicks must not spend the gesture, and a click on
      // our settings UI is not a request for sound.
      if (ev.target?.closest?.('.xhe-fab, .xhe-panel')) return;
      c.awaitingGesture = false;
      c.soundGranted = true;
      const v = c.mainVideo;
      if (!v) return;
      try {
        v.muted = false;
        if (!v.volume) v.volume = 1;
        tryPlay(v).catch(() => {});
      } catch (e) { /* nothing to unmute */ }
    };
    c.on(document, 'click', onClick, true);
  }

  function enforceMutedSecondaries(c) {
    for (const v of qsa('video')) {
      if (v !== c.mainVideo && !v.muted) {
        try { v.muted = true; } catch (e) { /* detached */ }
      }
    }
  }

  defineFeature({
    id: 'autostart',
    label: 'Autostart videos',
    onNavigate: (c) => refreshVideos(c),
    onSweep: (c) => refreshVideos(c),
  });

  defineFeature({
    id: 'soundOnStart',
    label: 'Start with sound',
    onSweep: (c) => enforceMutedSecondaries(c),
  });

  function refreshVideos(c) {
    const main = findMainVideo();
    for (const v of qsa('video')) attachToVideo(c, v, v === main);
    enforceMutedSecondaries(c);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:desktop -- -g "one-click fallback"`
Expected: PASS. On a fresh profile the `awaiting` branch is the one exercised.

- [ ] **Step 5: Re-run the navigation test**

Run: `npm run test:desktop -- -g "rebuilds the context"`
Expected: PASS — the disposer bound must still hold now that each context registers a gesture listener.

- [ ] **Step 6: Commit**

```bash
git add xh-desktop-enhancer.user.js tests/desktop.spec.mjs
git commit -m "feat: autostart with unmuted-first playback and a muted fallback"
```

---

## Task 7: Stop at the end of a video

**Files:**
- Modify: `xh-desktop-enhancer.user.js`
- Modify: `tests/desktop.spec.mjs`

**Interfaces:**
- Consumes: `defineFeature`, `ctx.on`, `hideListCss`, `forEachSiteKey`, `writeSiteKey`, `CONFIG.SEL.endCard`, `CONFIG.SITE_KEYS.autoplayNext`.
- Produces: feature `noAutoplayNext`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:desktop -- -g "rather than chaining"`
Expected: FAIL — `siteHandlerRan` is `true`.

- [ ] **Step 3: Implement the feature**

```js
  // ===================================================================
  // End of video: stop on the last frame, never chain
  // ===================================================================
  defineFeature({
    id: 'noAutoplayNext',
    label: 'Stop at end of video',
    css: () => hideListCss([CONFIG.SEL.endCard]),
    // 'ended' does not bubble, but a capture-phase listener on document
    // still sees it first — so the site's own handlers never run.
    onNavigate: (c) => {
      c.on(document, 'ended', (ev) => {
        if (ev.target?.tagName !== 'VIDEO') return;
        ev.stopPropagation();
        try { ev.target.pause(); } catch (e) { /* already stopped */ }
      }, true);
      forEachSiteKey(CONFIG.SITE_KEYS.autoplayNext, (key, value) => {
        if (/^(1|true|yes|on)$/i.test(String(value))) writeSiteKey(key, 'false');
      });
    },
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:desktop -- -g "rather than chaining"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add xh-desktop-enhancer.user.js tests/desktop.spec.mjs
git commit -m "feat: stop at the end of a video instead of chaining"
```

---

## Task 8: Quality forcing — implement the variant Task 0 selected

**Files:**
- Modify: `xh-desktop-enhancer.user.js`
- Modify: `tests/desktop.spec.mjs`

**Interfaces:**
- Consumes: `defineFeature`, `qs`, `qsa`, `ctx.qualityTarget`, `ctx.qualityPreferenceWritten`, `ctx.qualityClickAttempts`, `forEachSiteKey`, `writeSiteKey`, `CONFIG.SEL.qualityMenuButton`, `CONFIG.SEL.qualityMenuItem`, `CONFIG.SITE_KEYS.quality`.
- Produces: feature `maxQuality`; `pinToTopLevel(c)`; `ctx.player` (the media-library instance, or `null` on the progressive path); `writeQualityPreference(c)`; `clickHighestQuality(c)`.

Implement **exactly one** of 8A / 8B / 8C. The test in Step 1 is shared.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:desktop -- -g "highest rendition that plays"`
Expected: FAIL — `qualityTarget` stays `null`.

- [ ] **Step 3A (hls.js): implement the hook**

```js
  // ===================================================================
  // Quality — hls.js path. The hook must land before the site
  // constructs its player, hence onStart.
  // ===================================================================
  function wrapHls(Hls) {
    if (typeof Hls !== 'function' || Hls.__xheWrapped) return Hls;
    function WrappedHls(config) {
      const inst = new Hls({
        ...(config || {}),
        startLevel: -1,
        autoStartLoad: true,
        capLevelToPlayerSize: false,
        abrMaxWithRealBitrate: false,
        ...bufferConfig(),
      });
      try {
        inst.on(Hls.Events.MANIFEST_PARSED, () => { ctx.player = inst; pinToTopLevel(ctx); });
        inst.on(Hls.Events.LEVEL_SWITCHED, () => pinToTopLevel(ctx));
      } catch (e) { /* older event names — the menu layer still applies */ }
      return inst;
    }
    WrappedHls.prototype = Hls.prototype;
    for (const k of Object.keys(Hls)) {
      try { WrappedHls[k] = Hls[k]; } catch (e) { /* read-only static */ }
    }
    WrappedHls.__xheWrapped = true;
    return WrappedHls;
  }

  // Replaced with real values in Task 10; keeps this task self-contained.
  function bufferConfig() { return {}; }

  function pinToTopLevel(c) {
    const hls = c.player;
    try {
      if (!hls?.levels?.length) return;
      if (c.qualityTarget === null) c.qualityTarget = hls.levels.length - 1;
      hls.autoLevelCapping = -1;
      if (hls.currentLevel !== c.qualityTarget) hls.currentLevel = c.qualityTarget;
      if (hls.nextLevel !== c.qualityTarget) hls.nextLevel = c.qualityTarget;
    } catch (e) { /* instance torn down mid-switch */ }
  }

  defineFeature({
    id: 'maxQuality',
    label: 'Force highest quality',
    onStart: () => {
      let stored = window.Hls;
      try {
        Object.defineProperty(window, 'Hls', {
          configurable: true,
          get: () => stored,
          set: (value) => { stored = wrapHls(value); },
        });
        if (stored) stored = wrapHls(stored);
      } catch (e) { /* non-configurable — the menu layer still applies */ }
    },
    onSweep: (c) => { writeQualityPreference(c); clickHighestQuality(c); },
  });
```

- [ ] **Step 3B (dash.js): implement the hook instead**

```js
  // ===================================================================
  // Quality — dash.js path.
  // ===================================================================
  function attachDash(player) {
    try {
      player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
      const list = player.getBitrateInfoListFor('video') || [];
      if (!list.length) return;
      ctx.player = player;
      if (ctx.qualityTarget === null) ctx.qualityTarget = list.length - 1;
      player.setQualityFor('video', ctx.qualityTarget);
    } catch (e) { /* player not ready — the sweep retries */ }
  }

  function pinToTopLevel(c) {
    try {
      if (!c.player || c.qualityTarget === null) return;
      if (c.player.getQualityFor('video') !== c.qualityTarget) {
        c.player.setQualityFor('video', c.qualityTarget);
      }
    } catch (e) { /* torn down mid-switch */ }
  }

  defineFeature({
    id: 'maxQuality',
    label: 'Force highest quality',
    onStart: () => {
      let stored = window.dashjs;
      const wrap = (dashjs) => {
        if (!dashjs?.MediaPlayer || dashjs.__xheWrapped) return dashjs;
        const originalCreate = dashjs.MediaPlayer;
        dashjs.MediaPlayer = function (...args) {
          const factory = originalCreate.apply(this, args);
          const originalPlayer = factory.create;
          factory.create = function (...a) {
            const player = originalPlayer.apply(this, a);
            player.on('streamInitialized', () => attachDash(player));
            return player;
          };
          return factory;
        };
        dashjs.__xheWrapped = true;
        return dashjs;
      };
      try {
        Object.defineProperty(window, 'dashjs', {
          configurable: true,
          get: () => stored,
          set: (value) => { stored = wrap(value); },
        });
        if (stored) stored = wrap(stored);
      } catch (e) { /* non-configurable — the menu layer still applies */ }
    },
    onSweep: (c) => { pinToTopLevel(c); writeQualityPreference(c); clickHighestQuality(c); },
  });
```

- [ ] **Step 3C (progressive MP4): drive the menu as the primary lever**

```js
  // ===================================================================
  // Quality — progressive MP4 path. There are no renditions to pin: the
  // quality menu IS the mechanism, and switching means swapping src.
  // ===================================================================
  function pinToTopLevel(c) {
    // No MSE levels on this path; the menu layer does the work.
    if (c.qualityTarget === null && c.mainVideo?.currentSrc) c.qualityTarget = 0;
  }

  function swapSource(c, url) {
    const v = c.mainVideo;
    if (!v || !url || v.currentSrc === url) return;
    const at = v.currentTime;
    const wasPlaying = !v.paused;
    v.src = url;
    v.addEventListener('loadedmetadata', function once() {
      v.removeEventListener('loadedmetadata', once);
      try { v.currentTime = at; } catch (e) { /* unseekable yet */ }
      if (wasPlaying) v.play().catch(() => {});
    });
  }

  defineFeature({
    id: 'maxQuality',
    label: 'Force highest quality',
    onSweep: (c) => { pinToTopLevel(c); writeQualityPreference(c); clickHighestQuality(c); },
  });
```

- [ ] **Step 4: Add the shared menu and preference layers (all variants)**

```js
  function highestAdvertisedQuality() {
    let best = 0;
    for (const item of qsa(CONFIG.SEL.qualityMenuItem)) {
      const m = (item.textContent || '').match(/(\d{3,4})\s*p/i);
      if (m && Number(m[1]) > best) best = Number(m[1]);
    }
    return best ? `${best}p` : null;
  }

  // Once is enough — the sweep runs often and localStorage writes are not free.
  function writeQualityPreference(c) {
    if (c.qualityPreferenceWritten) return;
    const best = highestAdvertisedQuality();
    if (!best) return;
    c.qualityPreferenceWritten = true;
    forEachSiteKey(CONFIG.SITE_KEYS.quality, (key) => writeSiteKey(key, best));
  }

  // Capped: the menu button is usually a toggle, so retrying forever would
  // just flap it open and shut every sweep.
  const MAX_QUALITY_CLICK_ATTEMPTS = 3;

  function clickHighestQuality(c) {
    if (c.qualityClickAttempts >= MAX_QUALITY_CLICK_ATTEMPTS) return;
    let items = qsa(CONFIG.SEL.qualityMenuItem);
    if (!items.length) {
      const opener = qs(CONFIG.SEL.qualityMenuButton);
      if (!opener) return; // player not rendered yet; not an attempt
      c.qualityClickAttempts++;
      opener.click();
      items = qsa(CONFIG.SEL.qualityMenuItem);
    }
    let best = null, bestVal = -1;
    for (const item of items) {
      const m = (item.textContent || '').match(/(\d{3,4})\s*p/i);
      if (m && Number(m[1]) > bestVal) { bestVal = Number(m[1]); best = item; }
    }
    if (best && !best.dataset.xhePicked) {
      best.dataset.xhePicked = '1';
      best.click();
    }
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:desktop -- -g "highest rendition that plays"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add xh-desktop-enhancer.user.js tests/desktop.spec.mjs
git commit -m "feat: force the highest rendition"
```

---

## Task 9: Quality step-down when the top rendition will not play

**Files:**
- Modify: `xh-desktop-enhancer.user.js`
- Modify: `tests/desktop.spec.mjs`

**Interfaces:**
- Consumes: `pinToTopLevel(c)`, `ctx.qualityTarget`, `ctx.qualityDemotions`, `ctx.mainVideo`, `ctx.on`.
- Produces: `stepDownTarget(target, demotions, maxDemotions)` (pure, exposed as `window.__xhe.debug.stepDownTarget`), `installStallWatchdog(c)`, `demote(c)`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:desktop -- -g "step-down"`
Expected: FAIL — `window.__xhe.debug` is undefined.

- [ ] **Step 3: Implement the step-down**

```js
  // ===================================================================
  // Step-down — the watchdog is what separates "gated rendition that
  // will never load" from "slow connection": both stall, but only the
  // former stays stalled after a re-pin.
  // ===================================================================
  const MAX_DEMOTIONS = 3;
  const STALL_TIMEOUT_MS = 8000;

  function stepDownTarget(target, demotions, maxDemotions) {
    if (demotions >= maxDemotions) return null;
    const next = target - 1;
    return next >= 0 ? next : null;
  }

  function demote(c) {
    const next = stepDownTarget(c.qualityTarget, c.qualityDemotions, MAX_DEMOTIONS);
    c.qualityDemotions++;
    if (next === null) {
      // Out of road: hand control back to the player's own ABR.
      try { if (c.player) c.player.autoLevelCapping = -1, c.player.currentLevel = -1; } catch (e) {}
      return;
    }
    c.qualityTarget = next;
    pinToTopLevel(c);
  }

  function installStallWatchdog(c) {
    let lastEnd = 0;
    let lastProgress = Date.now();
    const timer = setInterval(() => {
      const v = c.mainVideo;
      if (!v || v.paused || v.ended) { lastProgress = Date.now(); return; }
      const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      if (end > lastEnd + 0.1) { lastEnd = end; lastProgress = Date.now(); return; }
      if (Date.now() - lastProgress > STALL_TIMEOUT_MS) {
        lastProgress = Date.now();
        demote(c);
      }
    }, 2000);
    c.disposers.push(() => clearInterval(timer));
  }
```

- [ ] **Step 4: Hook the watchdog and the fatal-error path into `maxQuality`**

Add to the `maxQuality` descriptor:

```js
    onNavigate: (c) => installStallWatchdog(c),
```

On the hls.js variant only, also register the fatal-error demotion inside `wrapHls`, beside the other `inst.on` calls:

```js
        inst.on(Hls.Events.ERROR, (_e, data) => { if (data?.fatal) demote(ctx); });
```

- [ ] **Step 5: Expose the debug helpers**

Add to the `window.__xhe` object literal:

```js
    debug: { stepDownTarget, demote },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:desktop -- -g "step-down"`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add xh-desktop-enhancer.user.js tests/desktop.spec.mjs
git commit -m "feat: step down when the top rendition will not play"
```

---

## Task 10: Buffer as far ahead as the browser allows

**Files:**
- Modify: `xh-desktop-enhancer.user.js`
- Modify: `tests/desktop.spec.mjs`

**Interfaces:**
- Consumes: `defineFeature`, `bufferConfig()` (stub from Task 8, replaced here), `attachToVideo`, `ctx.mainVideo`.
- Produces: feature `fullBuffer`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:desktop -- -g "buffer runs ahead"`
Expected: FAIL — `preload` is not `'auto'`.

- [ ] **Step 3: Register the feature and fill in the buffer config**

Replace the `bufferConfig()` stub from Task 8 with:

```js
  // Chromium enforces a per-SourceBuffer quota (order of ~150 MB of video)
  // and evicts to stay under it; hls.js catches the QuotaExceededError and
  // shrinks its own target. So this asks for the maximum and gets runway,
  // not the whole file — which is why the panel label promises "as far
  // ahead as possible" rather than "the whole video".
  function bufferConfig() {
    if (settings.fullBuffer === false) return {};
    return {
      maxBufferLength: 1800,
      maxMaxBufferLength: 3600,
      maxBufferSize: 600 * 1024 * 1024,
      backBufferLength: 60,
    };
  }

  defineFeature({
    id: 'fullBuffer',
    label: 'Buffer as far ahead as possible',
    needsReload: true, // the player is constructed once, with this config
    onSweep: (c) => {
      // Main player only: a page of inline players must not each become a
      // full-length download.
      if (c.mainVideo && c.mainVideo.preload !== 'auto') c.mainVideo.preload = 'auto';
    },
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:desktop -- -g "buffer runs ahead"`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm run test:desktop`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add xh-desktop-enhancer.user.js tests/desktop.spec.mjs
git commit -m "feat: buffer as far ahead as the browser allows"
```

---

## Task 11: README, install instructions and version housekeeping

**Files:**
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Restructure the README around two scripts**

Give `README.md` a short intro naming both scripts, then keep the existing iOS content under a `## iPhone (Safari)` heading, and add a `## Desktop (Chrome / Edge)` section covering:

- What it does — the ten features, in a table matching the existing style.
- Install: a userscript manager (Tampermonkey or Violentmonkey), open the raw `xh-desktop-enhancer.user.js`, confirm. **No "Inject Into" step** — `@grant none` already runs it in the page world.
- Assumes uBlock Origin is installed; the desktop script has no ad features by design.
- Known trade-offs: sound may start muted until Chromium's Media Engagement threshold is met (grant the site Sound permission via the padlock to fix permanently); buffering is capped by Chromium's MSE quota on streamed video; quality can step down if the top rendition is gated.
- Tests: `npm run test:desktop` drives your installed Chrome against the live site; `npm test` still runs the iOS jsdom harness.

- [ ] **Step 2: Fix the version drift**

`package.json` currently says `0.1.0` while the iOS script header says `0.2.0`. Each userscript owns its own `@version`, so decouple the package version — set `"version": "0.0.0"` and add a comment-free note in the README's Tests section that the two scripts version independently.

- [ ] **Step 3: Verify both suites still run**

Run: `npm test`
Expected: the iOS jsdom harness passes exactly as before.

Run: `npm run test:desktop`
Expected: all desktop tests pass.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json
git commit -m "docs: document the desktop script and decouple package version"
```

---

## Notes for the executor

- **Task 0 gates Tasks 8–10 only.** If it is unanswered, build Tasks 1–7 and 11 first; they are independent of the delivery path.
- **A failing test against the live site is not automatically a bug in your code.** The site may have redesigned. Every assertion names the selector or API it depended on — check `CONFIG` against the live DOM before changing logic.
- **Never add a `@grant`** to fix a problem. It sandboxes the script and silently breaks quality forcing.
- **Keep the file under 500 lines.** If it grows past that, the likely cause is a feature that should be expressed as CSS rather than JavaScript.
