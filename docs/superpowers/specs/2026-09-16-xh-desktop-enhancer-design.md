# xh Desktop Enhancer — Design

**Date:** 2026-09-16
**Status:** Approved in brainstorming; one blocking unknown (see Open Questions)
**Scope:** A new desktop userscript, `xh-desktop-enhancer.user.js`, built as a lean rewrite
alongside the existing iOS script. The iOS script is not modified.

---

## 1. Why this exists

`xh-mobile-enhancer.user.js` (1118 lines) targets iPhone Safari via the Userscripts
extension. Its constraints do not transfer to desktop:

| iOS constraint | Desktop reality |
|---|---|
| No real ad blocker available | uBlock Origin already installed |
| Unmuted autoplay categorically refused | Allowed once Media Engagement is earned |
| Native HLS in Safari | **No native HLS in Chromium** — site must use MSE or progressive MP4 |
| Script initialises on full page loads only | SPA routing can be hooked and re-enhanced |
| ES5-defensive style for engine variance | Evergreen Chromium only |

Roughly half the iOS script (blocklist, network guard, hijack guard, click-catchers,
redirect unwrapping, forced reloads, tap-to-fullscreen) is either redundant or wrong here.

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Target Chrome/Edge with uBlock Origin present | User's environment |
| 2 | Features: max quality + buffering, clean layout, autoplay with sound | Explicitly chosen; **no keyboard layer** |
| 3 | Separate desktop-only file, no shared build step | Selector fixes applied twice is the only cost, and it is small |
| 4 | **No ad/tracker features at all** | uBO handles it; drops blocklist, network guard, hijack guard, click-catchers |
| 5 | Re-enhance in place on SPA navigation, no forced reloads | A reload throws away warm cache and page state for no benefit |
| 6 | Quality: highest rendition that **actually plays**, with step-down | Top rendition is often login/premium gated |
| 7 | Sound: attempt unmuted, fall back to muted + unmute on first real click | Chromium refuses unmuted autoplay below the MEI threshold |
| 8 | Keep the ≡ FAB, restyled for mouse | Discoverable; a `@grant` for a manager menu would sandbox the script |
| 9 | Playwright against the live site, **only** harness | User's call; no jsdom layer for the desktop script |
| 10 | Tests run logged out; no credentials anywhere | Harsher case — if quality forcing works logged out it works logged in |
| 11 | Buffering asks for the max and is labelled honestly | Chromium's MSE quota overrides whatever we request |
| 12 | Both `.user.js` files at repo root; tests under `tests/` | They are published artifacts; root keeps the raw install URL working |

### Non-goals

- Ad, tracker, popunder or `window.open` blocking of any kind.
- Keyboard shortcuts for playback.
- Supporting Firefox, Safari desktop, or any non-Chromium browser.
- Modifying, refactoring or re-testing the iOS script.
- A shared core or build step between the two scripts.

## 3. Open questions

**BLOCKING — media delivery path.** Chromium has no native HLS, so the site must be doing
one of three things, and the quality design differs per path. To be resolved by inspecting
DevTools → Network on a watch page (`m3u8` / `mpd` / `.mp4`) and the console value of
`typeof window.Hls`, `typeof window.dashjs`, and `document.querySelector('video')?.src`.

| Finding | Primary quality lever | Layer 3 role |
|---|---|---|
| `m3u8` + `window.Hls` | Wrap `window.Hls`, pin `currentLevel` | Fallback |
| `mpd` + `window.dashjs` | Wrap `dashjs`, `setQualityFor` + `setAutoSwitchQuality(false)` | Fallback |
| `.mp4`, `video.src` is https | **Quality menu is primary**; swap `video.src`, preserve `currentTime` | Primary |

Implementation of the quality feature does not start until this is answered. Everything
else in the design is independent of it.

**Non-blocking assumptions** (stated, not asked):

- `hideAds` selectors are dropped — uBO's cosmetic filters cover ad slots. Promos, comments,
  end cards and the performance CSS are kept.
- Cookie banner and 18+ interstitial are treated as *not* ad-related and are kept.
- Each `.user.js` owns its own `@version`; `package.json`'s `version` field is decoupled.
  The existing 0.1.0/0.2.0 drift is fixed as housekeeping, not as part of this feature.
- Userscript manager is Tampermonkey or Violentmonkey; `@grant none` works identically on both.

## 4. Architecture

```
xh-desktop-enhancer.user.js
├── CONFIG          frozen: selectors, WATCH_PATH, SITE_KEYS
├── FEATURES[]      one descriptor per toggle — the only list of features
├── PageContext     all mutable per-page state; replaced on navigation
├── Navigation      history patch + popstate + href backstop
├── Scheduler       MutationObserver → rAF → throttled 500ms sweep
├── Styles          one stylesheet, rebuilt on any toggle change
└── Panel           ≡ FAB, rendered from FEATURES
```

Header: `@grant none`, `@run-at document-start`, `@noframes`, matching
`https://xhamster.com/*` and `https://*.xhamster.com/*`. `@grant none` places the script in
the **page world** on both managers, which the media-library hook requires. Any other
`@grant` would sandbox it and force every page-global access through `unsafeWindow`.

### 4.1 Feature descriptor

```js
{
  id, label, default, needsReload,
  css:        ()    => '',   // folded into the stylesheet while enabled
  onStart:    (ctx) => {},   // once per real page load — global patches only
  onNavigate: (ctx) => {},   // once per PageContext, first load included
  onMutate:   (ctx) => {},   // cheap, every mutation frame
  onSweep:    (ctx) => {},   // throttled, whole-document queries
}
```

The panel renders from `FEATURES`; the lifecycle dispatches into `FEATURES`. The iOS script
keeps this information in three places (`DEFAULT_SETTINGS`, `TOGGLES`, and the dispatch body
of `onDomChanged`) and its smoke test asserts a hardcoded checkbox count to catch drift.
Here there is one list and the equivalent assertion is `=== FEATURES.length`.

### 4.2 PageContext and disposers

```js
function newPageContext() {
  return {
    url: location.href,
    mainVideo: null,
    seenVideos: new WeakSet(),
    consentDismissed: false,
    ageGateDismissed: false,
    qualityPreferenceWritten: false,
    qualityClickAttempts: 0,
    qualityTarget: null,      // pinned rendition index
    qualityDemotions: 0,
    soundGranted: false,      // unmuted playback succeeded
    awaitingGesture: false,   // fell back to muted; unmute on first real click
    lastSweep: 0,
    disposers: [],
    on(target, type, fn, opts) { /* registers + records teardown */ },
  };
}
```

Every per-page listener registers through `ctx.on(...)`. Navigation runs the disposers and
replaces the context wholesale. This is the entire justification for the rewrite: the iOS
script holds the same state in six module-level variables, which under SPA navigation would
have to be reset in lockstep by hand — the classic "works on the first video, silently dead
on the second" bug.

`onStart` hooks (the media-library patch, the history patch) are global and deliberately
never re-run.

### 4.3 Navigation detection

Three signals, because routers vary:

1. `history.pushState` / `replaceState` patched at document-start to emit an internal event.
2. `popstate`.
3. A backstop in the throttled sweep comparing `location.href` to `ctx.url`, for routers
   holding a reference captured before our patch landed.

On a genuine change: run disposers → new context → run `onNavigate` for enabled features.
`CONFIG.WATCH_PATH` survives from the iOS config but its job **inverts** — there it selected
links to force-reload, here it selects which URL changes deserve a context rebuild, so
browsing categories and search does not churn.

### 4.4 Testability seam

`window.__xhe = { version, features, ctx }` is exposed deliberately. The Playwright suite
has no other way to assert internal state (pinned rendition, demotion count, disposer count)
against a real player. It is read-only from the page's perspective and inert.

## 5. Features

Ten toggles, all defaulting on:

| id | Label | Notes |
|---|---|---|
| `maxQuality` | Force highest quality | Section 6 |
| `fullBuffer` | Buffer as far ahead as possible | Deliberately not "the whole video" |
| `autostart` | Autostart videos | |
| `soundOnStart` | Start with sound | Falls back per Section 7 |
| `hidePromos` | Hide promos & nags | CSS, ported |
| `hideComments` | Hide comments | CSS, ported |
| `performance` | Performance tweaks | `content-visibility`, no hover-preview video, no animation |
| `dismissConsent` | Auto-dismiss cookie banner | Ported, per-context latch |
| `skipAgeGate` | Skip 18+ interstitial | Site flag pre-set; plain click-through only |
| `noAutoplayNext` | Stop at end of video | Capture-phase `ended` + `stopPropagation()` |

Dropped from iOS: `blockAds`, `tapToUnmute` (folded into `soundOnStart`'s fallback),
`forceReload` (replaced by in-place re-enhancement).

`needsReload` is now nearly empty — with no document-start ad guards and per-navigation
re-runs, almost everything applies live.

## 6. Quality forcing & buffering

**Layer 1 — media-library hook** (`onStart`). Property-descriptor wrap of the global, same
technique as the iOS script: `startLevel: -1`, `capLevelToPlayerSize: false`,
`autoStartLoad: true`, buffer targets set to the largest the player accepts.

**Step-down** (per context — the only genuinely new logic):

```
target = topLevel
on MANIFEST_PARSED  → pin to target
on LEVEL_SWITCHED   → re-pin to target            (ABR never wins)
on fatal ERROR, or
watchdog fires      → target -= 1; re-pin; demotions += 1
                      after 3 demotions, hand control back to ABR

watchdog: video.buffered.end has not advanced for ~8s while not paused
```

The watchdog is what separates "gated rendition that will never load" from "slow
connection": both stall, only the former stays stalled after a re-pin. Demotions are
per-context, so a new video starts optimistic again.

**Layer 2 — site preference.** Write the site's own quality key once per context so its
player starts correct rather than being corrected.

**Layer 3 — quality menu.** Capped-attempts fallback on the MSE paths; **primary** on the
progressive-MP4 path, where the only lever is picking the top item and swapping `video.src`
while preserving `currentTime`.

**Buffering.** Chromium enforces a per-`SourceBuffer` quota (order of ~150 MB of video, not
the ~2 GB the iOS config requests) and evicts to stay under it; hls.js catches the resulting
`QuotaExceededError` and shrinks its own target. On MSE you therefore get runway, not the
whole file. On progressive MP4, `preload="auto"` genuinely fetches everything. The feature
asks for the maximum in both cases and the panel label promises only what it can deliver.

## 7. Autoplay & sound

Per navigation: find the largest `<video>`, apply `preload` per the buffering toggle, then
attempt `play()` **unmuted**.

```
play() unmuted ── resolves ──→ ctx.soundGranted = true
       │
       └── NotAllowedError ──→ muted = true; play()
                               ctx.awaitingGesture = true
                               one-shot trusted click → unmute, restore volume
```

The mute re-assertion **inverts** relative to iOS. There, `attachToVideo()` re-asserts
`muted = true` on every mutation because iOS demands muted-first. Here the site's player is
the adversary: if it re-mutes an element we hold sound on, the sweep restores it. Same loop,
opposite polarity; `awaitingGesture` keeps the two from fighting.

The one-shot gesture listener registers through `ctx.on(...)`, so an unconsumed handler from
video #1 is torn down on navigation to video #2. Clicks on `.xhe-fab` / `.xhe-panel` are
excluded, as on iOS. Trusted-event checking is retained: the script's own consent-dismissal
clicks must not consume the gesture.

Secondary videos are force-muted so audio never overlaps. End-of-video keeps the iOS
approach verbatim — capture-phase `ended` on `document`, `stopPropagation()` + `pause()` —
plus writing the site's autoplay-next preference to false.

## 8. Layout, interstitials, panel

CSS is generated by concatenating the `css()` of every enabled feature into one stylesheet,
via constructable stylesheet with a `<style>` fallback re-appended by the sweep if the site
drops it. Ported from iOS unchanged except for the removal of the `hideAds` block.

Interstitials: `skipAgeGate` pre-sets the site's confirmation flag at document-start so the
gate never renders, with a click-through fallback; `dismissConsent` clicks reject-all, then
close. Both latch per context so a toggle-style control is not re-opened by a second click.

Panel: the ≡ FAB moves to 28px, near-invisible until hovered, still fading during playback.
Toggles render from `FEATURES`. Settings persist in `localStorage` under `xhe:desktop:v1` —
a distinct key from the iOS script's, so the two never read each other's state.

## 9. Testing

Playwright only, against the live site, run locally on demand.

**Critical setup detail:** Playwright's bundled Chromium ships **without proprietary codecs**
(no H.264/AAC) and would fail to decode anything. The suite must use
`channel: 'chrome'` (or `'msedge'`) to drive the installed branded browser. The userscript is
injected with `context.addInitScript({ path })`, which runs before page scripts in the page
world — an exact match for `@run-at document-start` + `@grant none`, so the file under test
is byte-identical to the file that gets installed.

A fresh profile has a Media Engagement Index of zero, which reproduces the exact unmuted-
autoplay refusal that Section 7's fallback exists for. `--autoplay-policy=no-user-gesture-required`
must therefore **not** be set — it would make that path untestable. A fresh profile also means
the 18+ gate and cookie banner appear every run, so those features are genuinely exercised.

Coverage:

1. Script runs at document-start with no console errors; `window.__xhe` present.
2. 18+ interstitial and cookie banner gone within a few seconds.
3. Main video is playing.
4. Unmuted attempt refused → falls back to muted and plays → a real Playwright click unmutes.
5. Quality pinned to the highest rendition that plays; `buffered.end` advances.
6. Step-down: after a forced failure on the top level, demotion recorded and playback continues.
7. **SPA navigation**: click a related video → URL changes without a document load → new video
   playing, quality re-pinned, `ctx.disposers` did not accumulate.
8. Panel: FAB present, opens, toggle count `=== FEATURES.length`, a toggle survives reload.
9. Layout: comments, promos and end-card absent; thumbnail preview videos not playing.

Every assertion fails with a message naming the selector or API it depended on — the only
thing that makes a redesign-driven failure cheap to diagnose. Accepted cost: no fast offline
loop, and a site outage or redesign means no test signal at all.

Layout: `tests/desktop.spec.mjs`, config at `config/playwright.config.mjs`, run via
`npm run test:desktop`. The iOS jsdom harness and its `npm test` script are untouched.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Delivery path is progressive MP4, invalidating the MSE hook | Blocking check before quality work starts; Layer 3 becomes primary |
| Selectors drift on redesign | All in `CONFIG`; every feature no-ops silently on a miss |
| SPA hook misses the site's router | `href` backstop in the sweep; failure degrades to "not re-enhanced", not breakage |
| Step-down watchdog misfires on a slow connection | Capped at 3 demotions, then ABR resumes; per-context reset |
| Live-site tests break on redesign | Assertions name their selector; suite is on-demand, not a commit gate |
| uBO disabled or degraded to uBO Lite on Chrome | Out of scope by decision #4 — ads return, script still works |

## 11. Success criteria

Open a watch page in Chrome or Edge with the script installed and uBO active:

- Video starts on its own, with sound where Chromium permits and muted-then-one-click
  otherwise; never silently stalled.
- Playing at the highest rendition that actually plays, holding it without stepping down
  on a healthy connection.
- Buffer runs well ahead of playback.
- No comments, promos, upsells or end-of-video card; thumbnail grids scroll without firing
  preview videos.
- No cookie banner, no 18+ interstitial.
- Video stops at the end.
- Clicking a related video re-enhances **in place** — everything above true again, with no
  full page load.
- All ten toggles work from the ≡ panel and persist across visits.
