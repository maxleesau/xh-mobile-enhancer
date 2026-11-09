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

  // ===================================================================
  // Quality — hls.js path. The hook must land before the site
  // constructs its player, hence onStart.
  //
  // Variant 8A was selected on indirect evidence (the iOS script wraps
  // window.Hls against the same site, and Chromium has no native HLS);
  // confirm against the live site per the spec's open question. If the
  // site turns out to use dash.js or progressive MP4, only this block and
  // pinToTopLevel change — the menu layer below still applies either way.
  // ===================================================================
  function wrapHls(Hls) {
    if (typeof Hls !== 'function' || Hls.__xheWrapped) return Hls;
    function WrappedHls(config) {
      // Reflect.construct keeps `new.target`, so a site class that extends
      // the wrapper still gets its own prototype.
      const inst = Reflect.construct(Hls, [{
        ...(config || {}),
        startLevel: -1,
        autoStartLoad: true,
        capLevelToPlayerSize: false,
        abrMaxWithRealBitrate: false,
        ...bufferConfig(),
      }], new.target || WrappedHls);
      try {
        inst.on(Hls.Events.MANIFEST_PARSED, () => { ctx.player = inst; pinToTopLevel(ctx); });
        inst.on(Hls.Events.LEVEL_SWITCHED, () => pinToTopLevel(ctx));
        inst.on(Hls.Events.ERROR, (_e, data) => { if (data?.fatal) demote(ctx); });
      } catch (e) { /* older event names — the menu layer still applies */ }
      return inst;
    }
    WrappedHls.prototype = Hls.prototype;
    // Inherit statics rather than copying: Hls.isSupported and friends are
    // non-enumerable, which Object.keys doesn't see — copying left them
    // undefined and broke the site's capability check (learned on iOS).
    Object.setPrototypeOf(WrappedHls, Hls);
    WrappedHls.__xheWrapped = true;
    return WrappedHls;
  }

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
    onNavigate: (c) => installStallWatchdog(c),
    onSweep: (c) => { pinToTopLevel(c); writeQualityPreference(c); clickHighestQuality(c); },
  });

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
      try { if (c.player) { c.player.autoLevelCapping = -1; c.player.currentLevel = -1; } } catch (e) {}
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

  // ===================================================================
  // Buffering. Chromium enforces a per-SourceBuffer quota (order of
  // ~150 MB of video) and evicts to stay under it; hls.js catches the
  // QuotaExceededError and shrinks its own target. So this asks for the
  // maximum and gets runway, not the whole file — which is why the panel
  // label promises "as far ahead as possible" rather than "the whole
  // video".
  // ===================================================================
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

  // ===================================================================
  // Bootstrap
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
    get css() { return currentCss; },
    debug: { stepDownTarget, demote },
  };

  applyCss();

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
      player: null,
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

  function sweep() {
    // Backstop: catches routers that captured a history reference before
    // our patch landed.
    if (location.href !== ctx.url) { maybeNavigate(); return; }
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
    each('onNavigate', ctx);
  }

  ctx = newPageContext();
  each('onStart', ctx);
  installNavigationWatcher();
  applyCss();
  startObserver();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
