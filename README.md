# xh Mobile Enhancer

A userscript for Safari on iPhone that forces maximum video quality, starts and buffers playback on its own, strips ads and trackers, and speeds up the page.

Settings live in your browser's `localStorage`. The script makes no outbound requests of its own.

## Features

| Feature | Default | What it does |
|---|---|---|
| **Force highest quality** | on | Always selects the top rendition, and re-pins it if anything tries to drop back. On Safari's native HLS path it points the player at the top rendition's own playlist (1080p where available). No cap, and no step-down when the connection is weak — you wait on the buffer instead. |
| **Autostart videos** | on | Every player starts on its own, muted and inline. iOS refuses unmuted autoplay outright, so muted-first is the only hands-free start available. |
| **Buffer the whole video** | on | The main player downloads all the way ahead so it never stalls mid-watch. Other players on the page buffer normally. |
| **Tap: sound + fullscreen** | on | Your first real tap unmutes the main player and hands off to the iOS native player — and still does whatever you tapped. Every other player stays muted, so audio never overlaps. |
| **Block ads & trackers** | on | Blocks every request to a host the site doesn't need (an allowlist — the ad networks here rotate through throwaway domains no blocklist keeps up with), skips the pre-roll ad, hides ad slots and native ads in the grids, neutralizes popunders and `window.open` hijacking, and strips "are you sure you want to leave?" traps. |
| **Hide promos & nags** | on | Premium upsells, newsletter prompts, app-install banners, push-notification nags. |
| **Hide comments** | on | The whole comments block — list, compose box, heading and count. |
| **Performance tweaks** | on | Offscreen thumbnails skip layout and paint, images lazy-load, animations are cut, and hover-preview videos are disabled (each one is a live decode). |
| **Auto-dismiss cookie banner** | on | Clicks reject-all, falling back to closing it. |
| **Skip 18+ interstitial** | on | Sets the site's own confirmation cookie so the gate stops rendering; on your very first visit that takes one automatic reload. Handles the site's plain "I am 18+" click-through only — a real age-verification wall (ID upload, face scan) is left completely alone. |
| **Stop at end of video** | on | A video ends and stops. No next-video card, no chaining through your battery unattended. |
| **Full reload on video links** | on | Tapping a video link loads it as a real page, so every watch page arrives fully enhanced. Category, search and pagination links keep the site's own faster routing. |

All features toggle from a floating **≡** button in the lower-left, which fades out while a video is playing. Settings persist across visits.

## Install (iPhone + Safari)

1. Install **[Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887)** (free, open source) from the App Store.
2. Enable it: **Settings → Apps → Safari → Extensions → Userscripts → Allow Extension**, and allow it for `xhamster.com`.
3. Open the Userscripts app once and confirm its scripts folder (it creates one in iCloud Drive or On My iPhone → Userscripts).
4. Open [the raw script](https://raw.githubusercontent.com/maxleesau/xh-mobile-enhancer/main/xh-mobile-enhancer.user.js) in Safari, tap the *Userscripts* puzzle-piece icon in the address bar, and tap **Tap to install**.
5. **Set this script's *Inject Into* option to `page`** in the Userscripts extension. Quality forcing and request blocking need page-world globals and silently do nothing in an isolated world.
6. Visit `https://xhamster.com` and check the **≡** button appears bottom-left.

There is no auto-update. To update, reopen the raw link and install again.

## Checking it works

Open any video in a fresh session. You should see: no cookie banner and no 18+ gate; the video starts by itself, inline and silent, with the buffer bar filling to the end; your first tap turns sound on and drops into the fullscreen player at the top rendition; no ad slots, comments or promo banners; related videos still listed below; thumbnail grids that scroll without preview videos firing; and the video stopping at the end rather than rolling into the next one.

## Known trade-offs

- **Only video links force a reload.** Other in-page navigation (categories, search, pagination) is left on the site's own routing and isn't re-enhanced — those pages have no player, so there's nothing to enhance.
- **Full buffering uses real data**, on cellular as on Wi-Fi, whether or not you finish the video. On Safari's native HLS path the browser decides how far ahead to buffer, so "whole video" only fully applies when the site plays through hls.js.
- **Ad blocking is an allowlist.** Every host not listed in `CONFIG.ALLOW_HOSTS` is blocked (Google sign-in is on the list). If the site moves something it needs onto a new domain, that part breaks until the domain is added — or switch off *Block ads & trackers* in the ≡ panel.
- **The pre-roll ad still starts downloading.** It's skipped, not blocked, because the player only loads the real video once the ad reports that it has ended.
- **Native fullscreen hides the site's quality menu.** Quality is forced before the handoff, so the top rendition carries in.
- **The script is silent** — no console output. If something breaks, switch features off one at a time in the ≡ panel to find it.

## When the site updates and something breaks

Every selector lives in the `CONFIG` object at the top of the script, with comments. Update the selector there — no need to touch anything else. Each feature no-ops silently when its selectors match nothing, so a stale selector can't break the site.

## Tests

`npm install && npm test` runs a jsdom harness that loads the script into a page shaped like the target site and checks the host allowlist (including that media and thumbnail CDN requests survive), the player setup, pre-roll handling, the end-of-video guard, the 18+ cookie and one-time reload, hide rules that must never match the player, watch-page URL classification and the settings panel. Two paths need a trusted event, which jsdom can't forge, and are marked as device-only checks.

## Disclaimer

Unofficial, client-side, for personal use. Blocking ads removes the site's ad revenue from your visits, and any client-side modification is outside a site's intended use.
