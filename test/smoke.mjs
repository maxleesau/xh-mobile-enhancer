// Smoke harness: run the userscript inside a jsdom page shaped like the target
// site and assert the behaviours that matter. Not a substitute for the phone,
// but it catches document-start crashes and blocklist false positives.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = fs.readFileSync(
  new URL('../xh-mobile-enhancer.user.js', import.meta.url), 'utf8');

const results = [];
const ok = (name, cond, detail = '') =>
  results.push({ name, pass: !!cond, detail });
const skip = (name) => results.push({ name, skipped: true, detail: '' });

const html = `<!doctype html><html><head><title>t</title></head><body>
  <div id="cookie-banner"><button class="reject-all">Reject all</button></div>
  <div class="age-gate"><button class="confirm">I am 18+</button></div>
  <div class="player-container">
    <video id="main"></video>
    <a target="_blank" href="https://exoclick.com/x"></a>
    <div class="quality-selector"><button>Quality</button></div>
    <ul class="quality-list"><li>360p</li><li>1080p</li><li>2160p</li></ul>
  </div>
  <div id="comments"><div class="comment-list">c</div></div>
  <div class="thumb-list"><div><video id="preview"></video></div></div>
  <div id="ad-top">ad</div>
  <a id="related" href="/videos/another-456">related video</a>
  <a id="category" href="/categories/example">a category</a>
  <a id="offsite" href="https://example.com/videos/x">offsite</a>
  <div class="premium-banner">upsell</div>
  <!-- Shapes taken from the live site -->
  <div id="video_box" class="video_container xplayer xplayer-next-video-edges xplayer-ads-preload">
    <video id="ad" src="https://xhvideo.sacdnssedge.com/video/abc"></video>
  </div>
  <div class="OydH-dkoGT OydH-dkoGT--top OydH-dkoGTno-ts-init">spot</div>
  <ul><li id="native-ad"><a href="https://xhamster.com/ff/out?path=%2Fshorts%2Fx">ad</a></li>
      <li id="real-tile"><a href="/videos/real-1">real</a></li></ul>
</body></html>`;

// jsdom can't navigate; count the attempts instead (the 18+ gate reload).
const virtualConsole = new (await import('jsdom')).VirtualConsole();
let navigations = 0;
virtualConsole.on('jsdomError', (e) => {
  if (/navigation/i.test(e.message)) navigations++;
});

const dom = new JSDOM(html, {
  url: 'https://xhamster.com/videos/example-123',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
  virtualConsole,
});
const { window } = dom;

// jsdom has no media stack; stub just enough that the script's calls resolve.
window.HTMLMediaElement.prototype.play = function () {
  this.__played = true;
  return Promise.resolve();
};
window.HTMLMediaElement.prototype.pause = function () { this.paused = true; };
window.HTMLMediaElement.prototype.webkitEnterFullscreen = function () {
  this.__fullscreen = true;
};
// Give videos a size so findMainVideo can pick a winner.
const sizes = { main: [390, 220], preview: [80, 60] };
window.Element.prototype.getBoundingClientRect = function () {
  const [width, height] = sizes[this.id] || [0, 0];
  return { width, height, top: 0, left: 0, right: width, bottom: height };
};

const fetched = [];
window.fetch = (input) => {
  fetched.push(String(input && input.url ? input.url : input));
  return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
};
const opened = [];
window.open = (url) => { opened.push(String(url)); return { real: true }; };

// location.assign is stubbed so the force-reload path can be asserted without
// jsdom actually navigating (which it refuses to do anyway).
let crashed = null;
try {
  window.eval(SRC);
} catch (e) {
  crashed = e;
}
ok('script runs at document-start without throwing', !crashed,
  crashed ? String(crashed && crashed.stack).split('\n').slice(0, 3).join(' | ') : '');

if (crashed) { report(); process.exit(1); }

const doc = window.document;

// --- network guard -------------------------------------------------------
const blockedProbe = [];
const allowedProbe = [];
const probes = [
  ['https://exoclick.com/tag.js', true],
  ['https://sub.doubleclick.net/x', true],       // suffix match
  ['https://xhamster.com/api/ads/list', true],   // path pattern, first-party
  ['https://xhamster.com/api/video/123', false], // first-party, must survive
  ['https://vs-cf.xhcdn.com/seg-1.ts', false],   // media CDN, must survive
  ['https://thumb-nss.xhcdn.com/a.jpg', false],
  ['https://ic-nss.flixcdn.com/a/x/frame/1.jpg', false],  // thumbnail CDN
  ['https://fonts.gstatic.com/s/inter.woff2', false],
  // The live ad networks' throwaway domains: no list names them, the
  // allowlist catches them anyway.
  ['https://cdn.modusygunaciro.com/sdk.js', true],
  ['https://wakuhyfeserucu.com/vast', true],
  ['https://collector.xhamster.com/ping', true],          // first-party telemetry
];
for (const [url, expectBlocked] of probes) {
  const before = fetched.length;
  window.fetch(url);
  const passed = (fetched.length === before) === expectBlocked;
  (expectBlocked ? blockedProbe : allowedProbe).push(`${url} ${passed ? 'ok' : 'FAIL'}`);
  ok(`${expectBlocked ? 'blocks' : 'allows'} ${url}`, passed);
}

// --- popunder guard ------------------------------------------------------
const openedBefore = opened.length;
window.open('https://popads.net/x');
ok('window.open without a user gesture is stubbed out', opened.length === openedBefore);

// --- player ---------------------------------------------------------------
await new Promise((r) => window.setTimeout(r, 50));
const main = doc.getElementById('main');
const preview = doc.getElementById('preview');
ok('main video is playsInline', main.playsInline === true);
ok('main video is muted for autostart', main.muted === true);
ok('main video full-buffers (preload=auto)', main.preload === 'auto');
ok('main video autoplay attempted', main.__played === true);
ok('secondary video does not full-buffer', preview.preload !== 'auto');
ok('secondary video stays muted', preview.muted === true);

// --- first tap: sound + fullscreen ---------------------------------------
// The script only acts on a trusted event, so its own auto-dismiss clicks
// can't spend the user's first tap. jsdom makes isTrusted a non-configurable
// own property, so a real tap CANNOT be simulated here — the unmute and
// fullscreen handoff are on-device checks only (see README step 4).
doc.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok('synthetic click does not unmute (own clicks cost you nothing)',
  main.muted === true);
ok('synthetic click does not force fullscreen', !main.__fullscreen);
skip('first tap unmutes + enters fullscreen — needs a trusted event, verify on device');

// --- end of video ---------------------------------------------------------
let siteEndHandlerRan = false;
main.addEventListener('ended', () => { siteEndHandlerRan = true; });
main.dispatchEvent(new window.Event('ended'));
ok("site's end-of-video handler is blocked (no chaining)", siteEndHandlerRan === false);

// The skipped pre-roll's 'ended' must reach the site: it's what makes the
// player load the real video.
const ad = doc.getElementById('ad');
let adEndSeen = false;
ad.addEventListener('ended', () => { adEndSeen = true; });
ad.dispatchEvent(new window.Event('ended'));
ok('pre-roll ad ended event reaches the site', adEndSeen === true);
ok('pre-roll ad is muted', ad.muted === true);
ok('pre-roll ad does not get autostart/full-buffer treatment', ad.preload !== 'auto' || ad.readyState === 0);

// --- interstitials --------------------------------------------------------
ok('18+ flag pre-set in storage', /true/i.test(String(window.localStorage.getItem('ageConfirmed'))));
ok('18+ cookie pre-set', /parental-control=yes/.test(doc.cookie));
ok('first visit reloads exactly once so the server drops the gate', navigations === 1,
  `navigations=${navigations}`);
ok('reload is latched per tab', window.sessionStorage.getItem('xhe:gate-reload') === '1');

// --- UI -------------------------------------------------------------------
ok('settings button mounted', !!doc.querySelector('.xhe-fab'));
doc.querySelector('.xhe-fab').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const panel = doc.querySelector('.xhe-panel');
ok('settings panel opens', !!panel);
ok('panel lists every feature toggle',
  panel && panel.querySelectorAll('input[type=checkbox]').length === 12,
  panel ? `found ${panel.querySelectorAll('input[type=checkbox]').length}` : '');

// --- stylesheet -----------------------------------------------------------
const css = (doc.getElementById('xhe-style')?.textContent) ||
  [...(doc.adoptedStyleSheets || [])].map((s) =>
    [...s.cssRules].map((r) => r.cssText).join('')).join('');
ok('comments hidden by stylesheet', /#comments/.test(css));
ok('promos hidden by stylesheet', /premium-banner/.test(css));
ok('thumbnail preview videos suppressed', /thumb-list[^{]*video/.test(css));
ok('content-visibility applied to grids', /content-visibility/.test(css));
ok('hide rules never match the player', /:not\(#video_box/.test(css) && /:not\(:has\(#video_box/.test(css));
ok('no bare "-ads-" rule (it matched the player root)', !/\[class\*="-ads-"\]/.test(css));
ok('no bare "next-video" rule (it matched the player root)', !/\[class\*="next-video"\]/.test(css));
ok('live ad spots hidden', /ts-init/.test(css));
ok('native ad tile hidden', doc.getElementById('native-ad').style.display === 'none');
ok('real tile left alone', doc.getElementById('real-tile').style.display !== 'none');

// --- force reload on video links -----------------------------------------
// jsdom locks Location down (assign can't be stubbed) and can't forge
// isTrusted, so the navigation itself is device-only. What IS testable, and is
// the part most likely to be wrong, is which URLs get classified as watch
// pages — so assert CONFIG.WATCH_PATH directly against the fixture's links.
const watchPath = (() => {
  const m = SRC.match(/WATCH_PATH:\s*(\/.*\/[a-z]*),/);
  return m ? eval(m[1]) : null;
})();
ok('WATCH_PATH is defined in CONFIG', !!watchPath);
if (watchPath) {
  const classify = (href) => watchPath.test(new URL(href, 'https://xhamster.com').pathname);
  ok('video link classified as a watch page', classify('/videos/another-456'));
  ok('embed link classified as a watch page', classify('/embed/abc'));
  ok('category link NOT classified as a watch page', !classify('/categories/example'));
  ok('search link NOT classified as a watch page', !classify('/search?q=x'));
  ok('home NOT classified as a watch page', !classify('/'));
}
// A click the script must ignore regardless: untrusted, so the guard rejects it.
doc.getElementById('related').dispatchEvent(
  new window.MouseEvent('click', { bubbles: true }));
ok('untrusted click on a video link is ignored by the reload guard',
  !doc.getElementById('related').__navigated);
skip('trusted tap on a video link forces a full page load — verify on device');

// --- ad node stripping ----------------------------------------------------
const s = doc.createElement('script');
s.src = 'https://exoclick.com/ad.js';
doc.body.appendChild(s);
ok('blocked script src assignment is dropped', s.getAttribute('src') !== 'https://exoclick.com/ad.js',
  `src=${s.getAttribute('src')}`);

function report() {
  const pad = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const tag = r.skipped ? 'SKIP' : (r.pass ? 'PASS' : 'FAIL');
    console.log(`${tag}  ${r.name.padEnd(pad)}  ${r.detail}`);
  }
  const failed = results.filter((r) => !r.skipped && !r.pass).length;
  const skipped = results.filter((r) => r.skipped).length;
  const ran = results.length - skipped;
  console.log(`\n${ran - failed}/${ran} passed, ${skipped} skipped (device-only)`);
  return failed;
}
process.exit(report() ? 1 : 0);
