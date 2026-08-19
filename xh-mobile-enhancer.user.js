// ==UserScript==
// @name         xh Mobile Enhancer
// @namespace    maxleesau.xh-mobile-enhancer
// @version      0.2.0
// @description  Max quality, autostart with full buffering, ad and tracker removal, and speed-ups for xhamster.com in Safari on iPhone.
// @match        https://xhamster.com/*
// @match        https://*.xhamster.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// @noframes
// ==/UserScript==

/*
 * xh Mobile Enhancer
 * ------------------
 * Local, client-side enhancements for iPhone Safari (Userscripts extension).
 *
 * IMPORTANT: set this script's "Inject Into" option to **page** in the
 * Userscripts extension. Quality forcing and request blocking both need
 * page-world globals and silently do nothing in an isolated world.
 *
 * Every selector this script depends on lives in CONFIG below. When the site
 * ships a redesign and a feature stops working, the fix is usually just
 * updating a selector there. Every feature no-ops silently when its selectors
 * match nothing, so a stale selector can't break the site.
 *
 * Known trade-offs (all deliberate):
 *   - Initialises on full page loads only. Taps on video links are therefore
 *     turned into real page loads so every watch page arrives enhanced; other
 *     in-page navigation (categories, pagination, search) is left on the site's
 *     own faster routing and is not re-enhanced.
 *   - The main player buffers the whole file at max quality, on cellular as on
 *     Wi-Fi. That is real data whether or not you finish the video.
 *   - Quality never steps down, so a weak signal shows up as buffering rather
 *     than a softer picture.
 *   - Handing off to the iOS native player means the site's own quality menu
 *     is not reachable; quality is forced before the handoff so it carries in.
 *   - The script is completely silent. If something breaks there is nothing in
 *     the console — isolate it by switching features off in the ≡ panel.
 *
 * The only outbound request it ever makes is an ad-filter list refresh, at
 * most once a week, after the page is already interactive. Everything else,
 * settings included, stays in this browser.
 */
(function () {
  'use strict';

  // =====================================================================
  // CONFIG — the only block that should need editing after a redesign
  // =====================================================================
  var CONFIG = Object.freeze({
    STORAGE_KEY: 'xhe:settings:v1',
    BLOCKLIST_KEY: 'xhe:blocklist:v1',
    BLOCKLIST_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000, // weekly refresh
    BLOCKLIST_MAX_HOSTS: 40000,

    // Public host lists, tried in order. Both are plain host-per-line and
    // served with permissive CORS headers; a failure here is harmless because
    // BLOCK_HOSTS below is always active regardless.
    BLOCKLIST_URLS: Object.freeze([
      'https://raw.githubusercontent.com/anudeepND/blacklist/master/adservers.txt',
      'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=plain&showintro=0&mimetype=plaintext',
    ]),

    // Built-in ad/tracker hosts. Suffix-matched, so "doubleclick.net" also
    // covers "stats.g.doubleclick.net". Deliberately a host list rather than a
    // block-all-third-parties rule, so the video CDN is never at risk.
    BLOCK_HOSTS: Object.freeze([
      'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
      'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
      'adservice.google.com', 'scorecardresearch.com', 'quantserve.com',
      'quantcount.com', 'moatads.com', 'adsafeprotected.com', 'adnxs.com',
      'rubiconproject.com', 'pubmatic.com', 'openx.net', 'criteo.com',
      'criteo.net', 'taboola.com', 'outbrain.com', 'mgid.com', 'revcontent.com',
      'popads.net', 'popcash.net', 'propellerads.com', 'poweradnetwork.com',
      'adsterra.com', 'exoclick.com', 'exosrv.com', 'realsrv.com',
      'juicyads.com', 'trafficjunky.com', 'trafficjunky.net', 'tsyndicate.com',
      'trafficfactory.biz', 'adtng.com', 'ads-twitter.com', 'adroll.com',
      'bidswitch.net', 'casalemedia.com', 'contextweb.com', 'sharethrough.com',
      'smartadserver.com', 'sonobi.com', 'spotxchange.com', 'teads.tv',
      'yieldmo.com', 'zedo.com', 'clickaine.com', 'clicksgear.com',
      'hilltopads.net', 'plugrush.com', 'trafficstars.com', 'tsyndicate.net',
      'stripchat.com', 'chaturbate.com', 'bongacams.com', 'xhcdn-ads.com',
      'branch.io', 'amplitude.com', 'mixpanel.com', 'segment.io',
      'sentry.io', 'bugsnag.com', 'newrelic.com', 'hotjar.com',
    ]),

    // URL path/query fragments that mark a request as advertising regardless
    // of host, so a first-party ad endpoint is caught too.
    BLOCK_PATHS: Object.freeze([
      // Deliberately no bare '/ad/' — short enough to false-positive on a
      // legitimate media path, and the host list already covers the networks.
      '/ads/', '/adserver', '/adframe', '/advert', '/banner',
      '/popunder', '/popup-ad', '/prebid', '/gpt.js', '/adsbygoogle',
      '/analytics', '/telemetry', '/beacon', '/tracker', '/tracking',
    ]),

    // Never host-blocked, even if a remote list names them. Path patterns
    // still apply, so a first-party ad endpoint is caught.
    ALLOW_HOSTS: Object.freeze([
      'xhamster.com', 'xhwebsite.com',
    ]),

    // Media delivery — exempt from every rule, host and path alike. This is
    // what keeps an over-broad pattern from ever killing playback.
    MEDIA_HOSTS: Object.freeze([
      'xhcdn.com', 'xhamster.desi',
    ]),

    SEL: Object.freeze({
      // Players. `player` is the container the main <video> lives in.
      player: '.player-container, #player, .xplayer, [data-role="player"]',
      // Transparent tap-catchers the site lays over the player to open ads.
      clickCatcher:
        '.player-container a[target="_blank"], .video-overlay-ad, ' +
        '[class*="click-catch"], [id*="clickcatch"], [class*="overlay-ad"]',
      // End-of-video card / next-video countdown.
      endCard:
        '[class*="next-video"], [class*="autoplay-overlay"], ' +
        '[class*="video-ended"], [class*="end-card"], [class*="up-next"]',
      // The player's own quality menu.
      qualityMenuButton:
        '[data-role="quality-button"], .quality-selector, ' +
        '[class*="quality"] button, button[class*="quality"]',
      qualityMenuItem:
        '[data-role="quality-item"], .quality-list li, ' +
        '[class*="quality"] [role="menuitem"], [class*="quality-option"]',

      // Cookie / consent banner.
      consentRoot:
        '#cookie-banner, .cookie-banner, [class*="cookies-modal"], ' +
        '[id*="consent"], [class*="consent-banner"], [class*="gdpr"]',
      consentReject:
        '[data-role="reject-all"], [class*="reject"], [class*="decline"], ' +
        '[class*="deny"], button[class*="necessary-only"]',
      consentClose: '[class*="close"], [aria-label*="close" i]',

      // 18+ interstitial.
      ageGateRoot:
        '[class*="age-verification"], [class*="age-gate"], ' +
        '[id*="age-verification"], [class*="disclaimer-modal"]',
      ageGateConfirm:
        '[data-role="age-confirm"], [class*="confirm"], [class*="enter"], ' +
        '[class*="agree"], [class*="over-18"], [class*="i-am"]',

      // Hidden outright: ad slots, promos, nags, the whole comments block.
      hideAds: Object.freeze([
        '[id^="ad-"]', '[id*="-ad-"]', '[class^="ad-"]', '[class*="-ads-"]',
        '[class*="advertis"]', '[class*="ad-banner"]', '[class*="ad-slot"]',
        '[class*="ad-container"]', '[class*="ad-wrapper"]', '[class*="adzone"]',
        '[data-role*="ad-"]', 'iframe[src*="ads"]', 'iframe[src*="doubleclick"]',
        '.trafficjunky', '#ad_top', '#ad_bottom',
      ]),
      hidePromos: Object.freeze([
        '[class*="premium-banner"]', '[class*="upsell"]', '[class*="promo-"]',
        '[class*="-promo"]', '[class*="subscribe-banner"]',
        '[class*="newsletter"]', '[class*="app-install"]', '[class*="pwa-"]',
        '[class*="push-notification"]', '[class*="get-app"]',
        '[class*="paysite"]', '[class*="gold-"]', '[class*="upgrade-banner"]',
      ]),
      hideComments: Object.freeze([
        '#comments', '.comments', '[class*="comments-block"]',
        '[class*="comment-list"]', '[class*="comments-wrapper"]',
        '[class*="comment-form"]', '[data-role="comments"]',
        '[class*="comments-header"]', '[class*="comments-counter"]',
      ]),
      // Thumbnail grids — given content-visibility so offscreen tiles are free.
      thumbGrid: '[class*="thumb-list"], [class*="video-thumb"], [class*="thumbs-"]',
    }),

    // What counts as a watch page. Taps on links matching this are turned
    // into real page loads, because the script initialises on full loads only
    // and an in-page navigation would otherwise land you on an un-enhanced
    // video. Non-matching links keep the site's own (faster) routing.
    WATCH_PATH: /^\/(videos?|embed|moments)\//i,

    // Storage keys the site itself uses, matched by pattern so a renamed key
    // is still found. Written to steer the site's own preferences.
    SITE_KEYS: Object.freeze({
      quality: /qual/i,
      autoplayNext: /(autoplay|auto_?next|continuous)/i,
      ageConfirmed: /(age|adult|disclaimer|over_?18|nsfw)/i,
    }),
  });

  // =====================================================================
  // Pristine references — captured before anything is patched, so our own
  // code can never be caught by our own guards.
  // =====================================================================
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  var nativeOpen = window.open ? window.open.bind(window) : null;
  var nativeAddEventListener = EventTarget.prototype.addEventListener;

  // =====================================================================
  // Settings
  // =====================================================================
  var DEFAULT_SETTINGS = {
    maxQuality: true,
    autostart: true,
    fullBuffer: true,
    tapToUnmute: true,
    blockAds: true,
    hidePromos: true,
    hideComments: true,
    performance: true,
    dismissConsent: true,
    skipAgeGate: true,
    noAutoplayNext: true,
    forceReload: true,
  };

  var settings = loadSettings();

  function loadSettings() {
    try {
      var raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (e) {
      /* private browsing or corrupt value — fall through to defaults */
    }
    return Object.assign({}, DEFAULT_SETTINGS);
  }

  function saveSettings() {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      /* private browsing — settings live for this page load only */
    }
  }

  // =====================================================================
  // Blocklist — built-in list is authoritative from the first millisecond;
  // the cached remote list is additive.
  // =====================================================================
  var blockedHosts = new Set(CONFIG.BLOCK_HOSTS);
  var allowedHosts = CONFIG.ALLOW_HOSTS;

  (function loadCachedBlocklist() {
    try {
      var raw = localStorage.getItem(CONFIG.BLOCKLIST_KEY);
      if (!raw) return;
      var cached = JSON.parse(raw);
      if (!cached || !cached.hosts) return;
      var hosts = cached.hosts.split('\n');
      for (var i = 0; i < hosts.length; i++) {
        if (hosts[i]) blockedHosts.add(hosts[i]);
      }
    } catch (e) {
      /* unreadable cache — the built-in list stands on its own */
    }
  })();

  function blocklistIsStale() {
    try {
      var raw = localStorage.getItem(CONFIG.BLOCKLIST_KEY);
      if (!raw) return true;
      var cached = JSON.parse(raw);
      return !cached || (Date.now() - (cached.ts || 0)) > CONFIG.BLOCKLIST_MAX_AGE_MS;
    } catch (e) {
      return false; // can't cache it anyway, so don't burn data trying
    }
  }

  // Deliberately deferred: this runs well after the page is interactive, so a
  // multi-hundred-KB download never sits on the critical path.
  function refreshBlocklist() {
    if (!settings.blockAds || !nativeFetch || !blocklistIsStale()) return;
    var urls = CONFIG.BLOCKLIST_URLS.slice();

    (function tryNext() {
      if (!urls.length) return;
      var url = urls.shift();
      nativeFetch(url, { credentials: 'omit', cache: 'no-cache' })
        .then(function (res) { return res.ok ? res.text() : Promise.reject(); })
        .then(function (text) { storeBlocklist(parseHostList(text)); })
        .catch(function () { tryNext(); });
    })();
  }

  // Accepts both plain host-per-line and `0.0.0.0 host` hosts-file format.
  function parseHostList(text) {
    var out = [];
    var lines = text.split('\n');
    for (var i = 0; i < lines.length && out.length < CONFIG.BLOCKLIST_MAX_HOSTS; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#' || line.charAt(0) === '!') continue;
      var parts = line.split(/\s+/);
      var host = parts.length > 1 ? parts[1] : parts[0];
      if (!host || host.indexOf('.') === -1) continue;
      if (host === 'localhost' || host === 'local') continue;
      if (isAllowedHost(host)) continue;
      out.push(host.toLowerCase());
    }
    return out;
  }

  function storeBlocklist(hosts) {
    if (!hosts.length) return;
    for (var i = 0; i < hosts.length; i++) blockedHosts.add(hosts[i]);
    try {
      localStorage.setItem(CONFIG.BLOCKLIST_KEY, JSON.stringify({
        ts: Date.now(),
        hosts: hosts.join('\n'),
      }));
    } catch (e) {
      /* over quota — the in-memory set still helps for this page load */
    }
  }

  function matchesHostList(host, list) {
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (host === a || host.slice(-(a.length + 1)) === '.' + a) return true;
    }
    return false;
  }

  function isAllowedHost(host) {
    return matchesHostList(host, allowedHosts) || isMediaHost(host);
  }

  function isMediaHost(host) {
    return matchesHostList(host, CONFIG.MEDIA_HOSTS);
  }

  function isBlockedHost(host) {
    if (isAllowedHost(host)) return false;
    if (blockedHosts.has(host)) return true;
    // Suffix match, so a subdomain of a blocked host is blocked too.
    var dot = host.indexOf('.');
    while (dot !== -1) {
      host = host.slice(dot + 1);
      if (blockedHosts.has(host)) return true;
      dot = host.indexOf('.');
    }
    return false;
  }

  function shouldBlock(url) {
    if (!settings.blockAds || !url) return false;
    try {
      var u = new URL(String(url), location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      var host = u.hostname.toLowerCase();
      if (isMediaHost(host)) return false;   // playback is never at risk
      if (isBlockedHost(host)) return true;
      var path = (u.pathname + u.search).toLowerCase();
      for (var i = 0; i < CONFIG.BLOCK_PATHS.length; i++) {
        if (path.indexOf(CONFIG.BLOCK_PATHS[i]) !== -1) return true;
      }
    } catch (e) {
      /* unparseable URL — let it through rather than risk a false positive */
    }
    return false;
  }

  // =====================================================================
  // Network guard — must run before any site script gets a chance
  // =====================================================================
  function installNetworkGuard() {
    // fetch: resolve empty rather than reject, so site code awaiting an ad
    // response doesn't throw its way into a broken state.
    if (nativeFetch) {
      window.fetch = function (input, init) {
        var url = (input && input.url) ? input.url : input;
        if (shouldBlock(url)) {
          try {
            return Promise.resolve(new Response('', { status: 200, statusText: 'OK' }));
          } catch (e) {
            // No Response constructor — a never-settling promise is still
            // better than a rejection the site isn't expecting.
            return new Promise(function () {});
          }
        }
        return nativeFetch(input, init);
      };
    }

    // XHR: point blocked requests at a data: URI so the request never leaves
    // the device but the object still completes normally.
    try {
      var xhrOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        var args = Array.prototype.slice.call(arguments);
        if (shouldBlock(url)) args[1] = 'data:text/plain,';
        return xhrOpen.apply(this, args);
      };
    } catch (e) { /* leave XHR alone if it can't be patched */ }

    try {
      var beacon = navigator.sendBeacon;
      if (beacon) {
        navigator.sendBeacon = function (url, data) {
          if (shouldBlock(url)) return true;
          return beacon.call(navigator, url, data);
        };
      }
    } catch (e) { /* non-configurable in some builds */ }

    // Script/iframe/img src assignment.
    patchSrcSetter(HTMLScriptElement);
    patchSrcSetter(HTMLIFrameElement);
    patchSrcSetter(HTMLImageElement);

    // Anything injected before the patches landed, plus anything added later.
    stripAdNodes(document);
  }

  function patchSrcSetter(ctor) {
    try {
      var desc = Object.getOwnPropertyDescriptor(ctor.prototype, 'src');
      if (!desc || !desc.set) return;
      Object.defineProperty(ctor.prototype, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (value) {
          if (shouldBlock(value)) return;
          desc.set.call(this, value);
        },
      });
    } catch (e) { /* locked down — the fetch/XHR guards still apply */ }
  }

  function stripAdNodes(root) {
    if (!settings.blockAds || !root || !root.querySelectorAll) return;
    try {
      var nodes = root.querySelectorAll('script[src], iframe[src]');
      for (var i = 0; i < nodes.length; i++) {
        if (shouldBlock(nodes[i].src)) nodes[i].remove();
      }
    } catch (e) { /* mid-parse DOM — the observer will catch it next tick */ }
  }

  // =====================================================================
  // Popunder / navigation-hijack guard
  // =====================================================================
  var lastTrustedAnchorTap = 0;

  function installHijackGuard() {
    // A real tap on a real same-origin link is the only thing that earns the
    // right to open a window.
    nativeAddEventListener.call(document, 'click', function (ev) {
      if (!ev.isTrusted) return;
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!a) return;
      try {
        if (new URL(a.href, location.href).origin === location.origin) {
          lastTrustedAnchorTap = Date.now();
        }
      } catch (e) { /* malformed href */ }
    }, true);

    if (nativeOpen) {
      window.open = function (url) {
        if (!settings.blockAds) return nativeOpen.apply(window, arguments);
        var sameOrigin = false;
        try {
          sameOrigin = !url || new URL(String(url), location.href).origin === location.origin;
        } catch (e) { /* treat unparseable as foreign */ }
        if (sameOrigin && (Date.now() - lastTrustedAnchorTap) < 200) {
          return nativeOpen.apply(window, arguments);
        }
        // A stub, not null — site code often dereferences the result blindly.
        return {
          closed: true, document: null, location: { href: '' },
          focus: function () {}, blur: function () {}, close: function () {},
        };
      };
    }

    // beforeunload traps ("are you sure you want to leave?") exist here only
    // to hold you on the page while an interstitial loads.
    try {
      EventTarget.prototype.addEventListener = function (type) {
        if (settings.blockAds && type === 'beforeunload') return;
        return nativeAddEventListener.apply(this, arguments);
      };
      Object.defineProperty(window, 'onbeforeunload', {
        configurable: true,
        get: function () { return null; },
        set: function () {},
      });
    } catch (e) { /* leave it if the environment won't allow the patch */ }
  }

  // The script initialises on full page loads only, so a tap on a video link
  // has to become a real navigation — otherwise the site routes in-page and
  // you land on a watch page with no forced quality and no autostart. Scoped
  // to video links: everything else keeps the site's own routing, which is
  // faster and is not worth breaking for pages that have no player.
  function installVideoLinkReload() {
    nativeAddEventListener.call(document, 'click', function (ev) {
      if (!settings.forceReload || !ev.isTrusted || ev.defaultPrevented) return;
      // Let the browser's own affordances win: modified taps, middle-click.
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      if (typeof ev.button === 'number' && ev.button !== 0) return;

      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!a || a.hasAttribute('download')) return;
      if (a.target && a.target !== '_self') return;
      if (!isWatchLink(a)) return;

      ev.preventDefault();
      location.assign(a.href);
    }, true);
  }

  function isWatchLink(a) {
    try {
      var u = new URL(a.href, location.href);
      if (u.origin !== location.origin) return false;
      return CONFIG.WATCH_PATH.test(u.pathname);
    } catch (e) {
      return false; // malformed href — leave it to the browser
    }
  }

  // Transparent tap-catchers laid over the player. Restricted to elements
  // inside the player that have no content of their own, so a real control is
  // never removed by accident.
  function removeClickCatchers() {
    if (!settings.blockAds) return;
    try {
      var nodes = document.querySelectorAll(CONFIG.SEL.clickCatcher);
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.childElementCount === 0 && !(n.textContent || '').trim()) n.remove();
      }
    } catch (e) { /* selector missed — nothing to do */ }
  }

  // Anchors routed through an ad redirector, restored to their real target.
  function unwrapRedirectAnchors() {
    if (!settings.blockAds) return;
    try {
      var anchors = document.querySelectorAll('a[href*="http"][href*="="]');
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var u;
        try { u = new URL(a.href, location.href); } catch (e) { continue; }
        if (!isBlockedHost(u.hostname.toLowerCase())) continue;
        var real = u.searchParams.get('url') || u.searchParams.get('u') ||
                   u.searchParams.get('r') || u.searchParams.get('target');
        if (real && /^https?:\/\//.test(real)) a.href = real;
        else a.removeAttribute('href');
      }
    } catch (e) { /* nothing matched */ }
  }

  // =====================================================================
  // Interstitials
  // =====================================================================
  // Scope note: this handles the site's own "I am 18+" click-through only.
  // If a region serves a real age-verification wall (ID upload, face scan),
  // the script leaves it completely alone.
  function presetSiteFlags() {
    if (!settings.skipAgeGate) return;
    // Setting the site's own confirmation flag stops the interstitial from
    // rendering at all, rather than flashing it and clicking it away.
    forEachSiteKey(CONFIG.SITE_KEYS.ageConfirmed, function (key, value) {
      if (/^(0|false|no)$/i.test(String(value))) writeSiteKey(key, 'true');
    });
    writeSiteKey('ageConfirmed', 'true');
    writeSiteKey('age_verified', 'true');
  }

  // Each gate is dismissed once. Without the latches the observer would keep
  // re-clicking, which on a toggle-style control means opening it again.
  var consentDismissed = false;
  var ageGateDismissed = false;

  function dismissInterstitials() {
    if (settings.dismissConsent && !consentDismissed) {
      consentDismissed =
        clickWithin(CONFIG.SEL.consentRoot, CONFIG.SEL.consentReject) ||
        clickWithin(CONFIG.SEL.consentRoot, CONFIG.SEL.consentClose);
    }
    if (settings.skipAgeGate && !ageGateDismissed) {
      ageGateDismissed = clickWithin(CONFIG.SEL.ageGateRoot, CONFIG.SEL.ageGateConfirm);
    }
  }

  function clickWithin(rootSel, buttonSel) {
    try {
      var roots = document.querySelectorAll(rootSel);
      for (var i = 0; i < roots.length; i++) {
        if (!isVisible(roots[i])) continue;
        var btn = roots[i].querySelector(buttonSel);
        if (btn) { btn.click(); return true; }
      }
    } catch (e) { /* selector missed */ }
    return false;
  }

  // =====================================================================
  // Site preference plumbing
  // =====================================================================
  function forEachSiteKey(pattern, fn) {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && pattern.test(key) && key.indexOf('xhe:') !== 0) {
          fn(key, localStorage.getItem(key));
        }
      }
    } catch (e) { /* storage unavailable */ }
  }

  function writeSiteKey(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* quota or private mode */ }
  }

  // =====================================================================
  // Quality — layered, because iOS Safari plays HLS natively on some paths
  // and through hls.js on others. Each layer is independent; the first one
  // that applies wins and the rest quietly do nothing.
  // =====================================================================
  function installHlsHook() {
    if (!settings.maxQuality) return;
    var stored = window.Hls;
    try {
      Object.defineProperty(window, 'Hls', {
        configurable: true,
        get: function () { return stored; },
        set: function (value) { stored = wrapHls(value); },
      });
      if (stored) stored = wrapHls(stored);
    } catch (e) { /* non-configurable — the DOM fallback still applies */ }
  }

  function wrapHls(Hls) {
    if (typeof Hls !== 'function' || Hls.__xheWrapped) return Hls;
    function WrappedHls(config) {
      var cfg = Object.assign({}, config || {}, {
        startLevel: -1,          // -1 means "highest" once capping is off
        autoStartLoad: true,
        capLevelToPlayerSize: false,
        abrMaxWithRealBitrate: false,
      });
      if (settings.fullBuffer) {
        // Buffer as far ahead as the player will let us. Main player only —
        // see attachToVideo(), which is what gates fullBuffer per element.
        cfg.maxBufferLength = 3600;
        cfg.maxMaxBufferLength = 7200;
        cfg.maxBufferSize = 2 * 1024 * 1024 * 1024;
        cfg.backBufferLength = 90;
      }
      var inst = new Hls(cfg);
      try {
        inst.on(Hls.Events.MANIFEST_PARSED, function () {
          pinToTopLevel(inst);
        });
        inst.on(Hls.Events.LEVEL_SWITCHED, function () {
          // Pinned even through stalls: if anything drops the level, put it
          // straight back. No step-down, ever.
          pinToTopLevel(inst);
        });
      } catch (e) { /* older hls.js event names — DOM fallback covers it */ }
      return inst;
    }
    WrappedHls.prototype = Hls.prototype;
    Object.keys(Hls).forEach(function (k) {
      try { WrappedHls[k] = Hls[k]; } catch (e) { /* read-only static */ }
    });
    WrappedHls.__xheWrapped = true;
    return WrappedHls;
  }

  function pinToTopLevel(hls) {
    try {
      if (!settings.maxQuality || !hls.levels || !hls.levels.length) return;
      hls.autoLevelCapping = -1;
      var top = hls.levels.length - 1;
      if (hls.currentLevel !== top) hls.currentLevel = top;
      if (hls.nextLevel !== top) hls.nextLevel = top;
    } catch (e) { /* instance torn down mid-switch */ }
  }

  // Persist the site's own quality preference, so the choice sticks across
  // videos instead of being re-applied from scratch each time. Once is enough:
  // the observer calls this often and localStorage writes aren't free.
  var qualityPreferenceWritten = false;

  function writeQualityPreference() {
    if (!settings.maxQuality || qualityPreferenceWritten) return;
    var best = highestAdvertisedQuality();
    if (!best) return;
    qualityPreferenceWritten = true;
    forEachSiteKey(CONFIG.SITE_KEYS.quality, function (key) {
      writeSiteKey(key, best);
    });
  }

  function highestAdvertisedQuality() {
    var best = 0;
    try {
      var items = document.querySelectorAll(CONFIG.SEL.qualityMenuItem);
      for (var i = 0; i < items.length; i++) {
        var m = (items[i].textContent || '').match(/(\d{3,4})\s*p/i);
        if (m && Number(m[1]) > best) best = Number(m[1]);
      }
    } catch (e) { /* menu not rendered */ }
    return best ? best + 'p' : null;
  }

  // Last resort, and the most redesign-proof of the layers: drive the site's
  // own quality menu the way a finger would. Capped at a few attempts — the
  // menu button is usually a toggle, so retrying forever would just flap it
  // open and shut every animation frame.
  var qualityClickAttempts = 0;
  var MAX_QUALITY_CLICK_ATTEMPTS = 3;

  function clickHighestQuality() {
    if (!settings.maxQuality || qualityClickAttempts >= MAX_QUALITY_CLICK_ATTEMPTS) return;
    try {
      var items = document.querySelectorAll(CONFIG.SEL.qualityMenuItem);
      if (!items.length) {
        var opener = document.querySelector(CONFIG.SEL.qualityMenuButton);
        if (!opener) return; // player not rendered yet; not an attempt
        qualityClickAttempts++;
        opener.click();
        items = document.querySelectorAll(CONFIG.SEL.qualityMenuItem);
      }
      var best = null, bestVal = -1;
      for (var i = 0; i < items.length; i++) {
        var m = (items[i].textContent || '').match(/(\d{3,4})\s*p/i);
        if (m && Number(m[1]) > bestVal) { bestVal = Number(m[1]); best = items[i]; }
      }
      if (best && !best.getAttribute('data-xhe-picked')) {
        best.setAttribute('data-xhe-picked', '1');
        best.click();
      }
    } catch (e) { /* menu structure changed — other layers still apply */ }
  }

  // =====================================================================
  // Autostart, buffering, sound, fullscreen
  // =====================================================================
  var seenVideos = new WeakSet();
  var mainVideo = null;
  var soundArmed = false;

  function findMainVideo() {
    var best = null, bestArea = 0;
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      var r = videos[i].getBoundingClientRect();
      var area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = videos[i]; }
    }
    return best;
  }

  function attachToVideo(video, isMain) {
    if (!video) return;
    try {
      video.playsInline = true;              // without this, no autostart at all
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');

      if (settings.autostart) {
        // iOS refuses unmuted autoplay outright, so muted-first is the only
        // hands-free start available. Once you've tapped for sound, the main
        // player is left alone — this runs on every mutation, and without the
        // guard the next DOM change would silently mute it again.
        if (!isMain || !firstTapDone) video.muted = true;
        video.autoplay = true;
        // Full buffering is main-player only, so a page of inline players
        // doesn't turn into several full-length downloads.
        video.preload = (isMain && settings.fullBuffer) ? 'auto' : 'metadata';
        tryPlay(video);
      }

      if (settings.noAutoplayNext) video.loop = false;
    } catch (e) { /* element detached mid-setup */ }

    if (seenVideos.has(video)) return;
    seenVideos.add(video);

    if (settings.autostart) {
      nativeAddEventListener.call(video, 'loadedmetadata', function () { tryPlay(video); });
      nativeAddEventListener.call(video, 'canplay', function () { tryPlay(video); });
    }
  }

  function tryPlay(video) {
    try {
      var p = video.play();
      if (p && p.catch) p.catch(function () { /* iOS not ready yet — the events retry */ });
    } catch (e) { /* not ready — retried on canplay */ }
  }

  // One tap: sound on, and hand off to the iOS native player. Passive and
  // non-capturing, so the tap still does whatever it would normally do.
  var firstTapDone = false;

  function armFirstTap() {
    if (!settings.tapToUnmute || soundArmed) return;
    soundArmed = true;
    // Both events are registered because a tap fires touchend then click;
    // whichever lands first wins and onFirstTap short-circuits the other.
    nativeAddEventListener.call(document, 'touchend', onFirstTap, { passive: true });
    nativeAddEventListener.call(document, 'click', onFirstTap, { passive: true });
  }

  function onFirstTap(ev) {
    if (firstTapDone) return;
    // Only a real finger counts. The script's own synthetic clicks — dismissing
    // the consent banner, picking a quality — bubble to document too, and
    // without this they'd spend your first tap for you. (iOS would refuse the
    // fullscreen call on an untrusted event anyway, but it would still unmute.)
    if (ev && ev.isTrusted === false) return;
    // A tap on our own settings UI shouldn't be the one that goes fullscreen.
    var target = ev && ev.target;
    if (target && target.closest && target.closest('.xhe-fab, .xhe-panel')) return;
    // Nor should a tap on a video link: that navigation is about to unload the
    // page, and unmuting plus entering fullscreen on the way out is just noise.
    if (target && target.closest) {
      var link = target.closest('a[href]');
      if (link && isWatchLink(link)) return;
    }
    firstTapDone = true;

    var video = mainVideo || findMainVideo();
    if (!video) { firstTapDone = false; return; }
    try {
      video.muted = false;
      if (!video.volume) video.volume = 1;
      tryPlay(video);
    } catch (e) { /* nothing to unmute */ }
    try {
      // Quality is already forced by now, so the pinned rendition carries
      // into the native player even though its menu isn't reachable there.
      if (typeof video.webkitEnterFullscreen === 'function') video.webkitEnterFullscreen();
    } catch (e) { /* fullscreen refused — playback continues inline */ }
  }

  // Every player other than the main one stays muted permanently, so audio
  // never overlaps.
  function enforceMutedSecondaries() {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      if (videos[i] !== mainVideo && !videos[i].muted) {
        try { videos[i].muted = true; } catch (e) { /* detached */ }
      }
    }
  }

  // =====================================================================
  // End of video: stop on the last frame, never chain to the next one
  // =====================================================================
  function installEndGuard() {
    if (!settings.noAutoplayNext) return;
    // 'ended' doesn't bubble, but a capture-phase listener on the document
    // still sees it — and stopping propagation here means the site's own
    // handlers on the <video> never run.
    nativeAddEventListener.call(document, 'ended', function (ev) {
      if (!settings.noAutoplayNext) return;
      if (!ev.target || ev.target.tagName !== 'VIDEO') return;
      ev.stopPropagation();
      try { ev.target.pause(); } catch (e) { /* already stopped */ }
    }, true);

    forEachSiteKey(CONFIG.SITE_KEYS.autoplayNext, function (key, value) {
      if (/^(1|true|yes|on)$/i.test(String(value))) writeSiteKey(key, 'false');
    });
  }

  // =====================================================================
  // Style engine — one sheet, rebuilt wholesale on any toggle change
  // =====================================================================
  var adoptedSheet = null;
  var styleEl = null;

  function buildCss() {
    var css = baseUiCss();
    if (settings.blockAds) css += hideListCss(CONFIG.SEL.hideAds);
    if (settings.hidePromos) css += hideListCss(CONFIG.SEL.hidePromos);
    if (settings.hideComments) css += hideListCss(CONFIG.SEL.hideComments);
    if (settings.noAutoplayNext) css += hideListCss([CONFIG.SEL.endCard]);
    if (settings.performance) css += performanceCss();
    return css;
  }

  function hideListCss(list) {
    return list.join(',') + '{display:none !important;}';
  }

  function performanceCss() {
    return (
      // Offscreen thumbnail tiles skip layout and paint entirely. The
      // intrinsic size keeps the scrollbar from jumping as they resolve.
      CONFIG.SEL.thumbGrid + ' > *{content-visibility:auto;contain-intrinsic-size:200px 260px;}' +
      // Hover-preview videos are a live decode each and useless on a
      // touchscreen — the deliberate exception to "autostart everywhere".
      CONFIG.SEL.thumbGrid + ' video{display:none !important;}' +
      // Animation is the cheapest thing to give up on a phone.
      '*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;' +
      'transition-duration:0s !important;transition-delay:0s !important;}'
    );
  }

  function baseUiCss() {
    return (
      '.xhe-fab{position:fixed;left:8px;bottom:calc(env(safe-area-inset-bottom) + 84px);z-index:2147483000;' +
      'width:44px;height:44px;border-radius:50%;border:none;background:#1c1c22;color:#fff;font-size:20px;' +
      'display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.45);' +
      'touch-action:manipulation;cursor:pointer;padding:0;opacity:1;transition:opacity .2s;}' +
      '.xhe-fab:active{transform:scale(.94);}' +
      // Auto-hide while a video is playing, so it never sits on the controls.
      '.xhe-fab.xhe-dim{opacity:0;pointer-events:none;}' +

      '.xhe-panel{position:fixed;left:8px;bottom:calc(env(safe-area-inset-bottom) + 136px);z-index:2147483001;' +
      'width:min(280px, calc(100vw - 16px));background:#1c1c22;color:#eee;border-radius:14px;' +
      'box-shadow:0 4px 24px rgba(0,0,0,.55);padding:10px 12px;font:14px/1.4 -apple-system,system-ui,sans-serif;' +
      'max-height:70dvh;overflow-y:auto;-webkit-overflow-scrolling:touch;}' +
      '@supports not (max-height: 70dvh){.xhe-panel{max-height:70vh;}}' +
      '.xhe-panel h3{margin:2px 0 8px;font-size:13px;font-weight:600;letter-spacing:.4px;color:#9aa;text-transform:uppercase;}' +
      '.xhe-panel label{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:38px;' +
      'padding:0 2px;touch-action:manipulation;}' +
      '.xhe-panel label span{flex:1;}' +
      '.xhe-panel input[type=checkbox]{width:20px;height:20px;accent-color:#e0b34c;}' +
      '.xhe-panel .xhe-note{margin:8px 0 0;font-size:11px;color:#889;}'
    );
  }

  function applyCss() {
    var css = buildCss();
    // Primary path: constructable stylesheet (CSP-proof, iOS Safari 16.4+)
    try {
      if (!adoptedSheet && typeof CSSStyleSheet !== 'undefined' && document.adoptedStyleSheets !== undefined) {
        adoptedSheet = new CSSStyleSheet();
        document.adoptedStyleSheets = document.adoptedStyleSheets.concat([adoptedSheet]);
      }
      if (adoptedSheet) { adoptedSheet.replaceSync(css); return; }
    } catch (e) {
      adoptedSheet = null;
    }
    // Fallback: <style> tag, re-appended by the observer if the site drops it
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'xhe-style';
    }
    styleEl.textContent = css;
    if (!styleEl.isConnected) {
      (document.head || document.documentElement).appendChild(styleEl);
    }
  }

  // =====================================================================
  // Settings panel
  // =====================================================================
  var panel = null;

  var TOGGLES = [
    ['maxQuality', 'Force highest quality'],
    ['autostart', 'Autostart videos'],
    ['fullBuffer', 'Buffer the whole video'],
    ['tapToUnmute', 'Tap: sound + fullscreen'],
    ['blockAds', 'Block ads & trackers'],
    ['hidePromos', 'Hide promos & nags'],
    ['hideComments', 'Hide comments'],
    ['performance', 'Performance tweaks'],
    ['dismissConsent', 'Auto-dismiss cookie banner'],
    ['skipAgeGate', 'Skip 18+ interstitial'],
    ['noAutoplayNext', 'Stop at end of video'],
    ['forceReload', 'Full reload on video links'],
  ];

  // Changing these mid-page can't retroactively un-load what already loaded.
  var NEEDS_RELOAD = { blockAds: true, skipAgeGate: true, noAutoplayNext: true };

  function mountFab() {
    if (!document.body || document.querySelector('.xhe-fab')) return;
    var fab = document.createElement('button');
    fab.className = 'xhe-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Mobile Enhancer settings');
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
    var p = document.createElement('div');
    p.className = 'xhe-panel';

    var h = document.createElement('h3');
    h.textContent = 'Mobile Enhancer';
    p.appendChild(h);

    var note = document.createElement('p');
    note.className = 'xhe-note';
    note.textContent = 'v0.2.0 · settings stay in this browser';

    TOGGLES.forEach(function (t) {
      var key = t[0], text = t[1];
      var label = document.createElement('label');
      var span = document.createElement('span');
      span.textContent = text;
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !!settings[key];
      box.addEventListener('change', function () {
        settings[key] = box.checked;
        saveSettings();
        applyCss();
        onDomChanged();
        // Guards installed at document-start can't retroactively un-load what
        // already loaded, so say so rather than looking broken.
        if (NEEDS_RELOAD[key]) note.textContent = 'Reload the page to apply that one.';
      });
      label.appendChild(span);
      label.appendChild(box);
      p.appendChild(label);
    });

    p.appendChild(note);
    return p;
  }

  function syncFabVisibility() {
    var fab = document.querySelector('.xhe-fab');
    if (!fab) return;
    var playing = mainVideo && !mainVideo.paused && !mainVideo.ended;
    fab.classList.toggle('xhe-dim', !!playing && !panel);
  }

  // =====================================================================
  // Bootstrap
  // =====================================================================
  // Full page loads only: no history patching, no popstate handling. The
  // observer below keeps up with late-rendered nodes within a page, but an
  // in-page navigation to another video is not re-enhanced.
  var rafScheduled = false;
  var lastSweep = 0;
  var SWEEP_INTERVAL_MS = 500;

  function onDomChanged() {
    mainVideo = findMainVideo();

    // Cheap, every time.
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      attachToVideo(videos[i], videos[i] === mainVideo);
    }
    enforceMutedSecondaries();

    if (styleEl && !styleEl.isConnected) {
      (document.head || document.documentElement).appendChild(styleEl);
    }
    mountFab();
    syncFabVisibility();

    // Whole-document queries — throttled, because a busy page can fire
    // mutations every frame and these would then dominate the main thread,
    // which is the opposite of the point.
    var now = Date.now();
    if (now - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = now;

    stripAdNodes(document);
    removeClickCatchers();
    unwrapRedirectAnchors();
    dismissInterstitials();
    clickHighestQuality();
    writeQualityPreference();
  }

  function startObserver() {
    var observer = new MutationObserver(function () {
      if (rafScheduled) return;
      rafScheduled = true;
      requestAnimationFrame(function () {
        rafScheduled = false;
        onDomChanged();
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function onReady() {
    applyCss();
    mountFab();
    armFirstTap();
    onDomChanged();
    // Deferred so a filter-list download never sits on the critical path.
    setTimeout(refreshBlocklist, 5000);
  }

  // --- document-start work, in order of urgency ---
  installNetworkGuard();
  installHijackGuard();
  installVideoLinkReload();
  installHlsHook();
  installEndGuard();
  presetSiteFlags();
  applyCss();
  startObserver();

  if (document.readyState === 'loading') {
    nativeAddEventListener.call(document, 'DOMContentLoaded', onReady);
  } else {
    onReady();
  }

  nativeAddEventListener.call(document, 'play', syncFabVisibility, true);
  nativeAddEventListener.call(document, 'pause', syncFabVisibility, true);
})();
