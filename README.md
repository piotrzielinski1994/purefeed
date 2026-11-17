# PureFeed

Chrome and Firefox Manifest V3 extension that hides feed posts whose image, GIF or video you already saw on Reddit (`www.reddit.com`), Wykop (`wykop.pl`) or X (`x.com`). It compares perceptual fingerprints of the media, so resized, recompressed, cropped and re-uploaded reposts also match.

## Prerequisites

- Node 26 and npm 11 (`mise.toml` pins `node = "26.13.1"`).
- `ffmpeg` 9 (`mise.toml` pins `ffmpeg = "9.0.2"`); only the test asset generator uses it.
- Run `mise install` in the repo root to install both.
- Runtime dependencies: none.

## Build

```sh
npm ci
npm run build
```

| Output                                | Use                       |
| ------------------------------------- | ------------------------- |
| `dist/chrome/`                        | Unpacked Chrome extension |
| `dist/firefox/`                       | Unpacked Firefox add-on   |
| `dist/purefeed-chrome-<version>.zip`  | Zip of `dist/chrome/`     |
| `dist/purefeed-firefox-<version>.zip` | Zip of `dist/firefox/`    |

## Install in Chrome

Needs Chrome >= 120 (`minimum_chrome_version` in the manifest).

1. Open `chrome://extensions`.
2. Turn on "Developer mode".
3. Click "Load unpacked" and select `dist/chrome` (or a folder into which you extracted `dist/purefeed-chrome-<version>.zip`).
4. Pin PureFeed in the toolbar to reach the popup.

## Install in Firefox

Needs Firefox >= 128 (`strict_min_version` in the manifest).

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on" and select `dist/firefox/manifest.json` (or `dist/purefeed-firefox-<version>.zip`).
3. Open the PureFeed popup; if it shows "Permission needed", click "Grant access".

Firefox removes a temporary add-on when it restarts. A permanent install needs an XPI (cross-platform installer package) signed by AMO (addons.mozilla.org); signing is out of scope.

## Usage

### Popup

- "Deduplication" master toggle: off stops all processing and shows every hidden post in open tabs.
- "Duplicates hidden" and "Unique items processed" counters.
- Active threshold (`Exact >= 95%` or `Similar >= 90%`) and retention period.
- One toggle per platform: off shows the hidden posts of that platform in open tabs.
- "Open settings" opens the options page.

### Hide indicator

A hidden post stays in the page; a bar takes its place:

- Text: "Hidden by PureFeed: <exact|similar>, seen on <Platform> <relative time>". "seen on <Platform>" opens the first-seen post in a new tab.
- "Show": shows the post for the rest of the page session.
- "Always show this post": adds the post to the whitelist.
- "Always show <author>": adds the author (`u/<name>` on Reddit, `@<name>` on Wykop and X) to the whitelist.
- A toast "PureFeed hid N duplicate(s)" shows in the bottom-right corner when posts are hidden (toast toggle in the options).

### Whitelist

- A whitelisted post or source is never hidden; its media are still recorded as seen.
- The options page lists all entries, removes an entry and adds a source: `r/<name>` or `u/<name>` for Reddit, `@<name>` for Wykop and X.

### Options

- Detection: mode ("Exact only" or "Exact and similar"), exact threshold (90-100%), similar threshold (75-99%, lower than the exact threshold).
- Content types (images, GIFs, videos) and platforms (Reddit, Wykop, X).
- Retention: 7, 30 or 90 days, or forever.
- Toast on or off.
- History: "Clear history" (after a confirm dialog, deletes all seen records) and "Reset counters".
- Privacy and limitations summary.
- Every change saves at once to `storage.local` and applies in open tabs within 1 s.

## Privacy

- All processing and storage stay in the browser: no data leaves the browser, no account, no cloud storage.
- Seen records live in the extension's own IndexedDB and hold only: fingerprint, content type, platform, first-seen post key, first-seen post permalink, first seen time, last seen time and seen count. No image bytes, no frames, no page titles.
- Settings, whitelist and counters live in `storage.local`; the extension never uses `storage.sync`.
- Author names are stored only when you add them to the whitelist.
- No telemetry, no analytics, no remote code.
- The only network requests the extension starts go to a media URL that the current page already shows, on one of these platform or CDN (content delivery network) hosts: `i.redd.it`, `preview.redd.it`, `external-preview.redd.it`, `wykop.pl`, `pbs.twimg.com`, `video.twimg.com`. The requests carry no cookies (`credentials: 'omit'`) and no request body.
- The extension never downloads video files; video frames come from the page's own `<video>` while it plays.

## Limitations

- No OCR (optical character recognition): the caption guard compares image regions, so a caption text change that covers less than 1% of the image area can still match.
- Video frames are best-effort: a DRM (digital rights management) video, a cross-origin video without pixel access and a decode error fall back to the poster image, or skip the item when it has no poster.
- Video frames come only from the page's own playback: the extension never downloads video bytes. A video gets a frame sequence fingerprint only after the page plays it (Reddit and X autoplay muted videos in the feed). Before playback, and for a cross-origin video without pixel access (for example an X GIF video on `video.twimg.com`), the video has a poster-only fingerprint, which matches only another poster-only fingerprint and only at `exact`.
- A video that reports no duration or gives no frame within 10 s after it enters the lookahead keeps its poster-only result (or stays skipped without a poster) for the page session; a page reload processes it again.
- Firefox removes a temporary add-on when Firefox restarts; a permanent install needs a signed XPI, which is out of scope.
- Platform DOM (document object model) changes can break an adapter selector; the generic fallback (nearest `article` or `[role="article"]` ancestor of large media) covers part of this.
- The X selectors are not confirmed on the live site (login needed); they follow the local X fixtures.
- The Reddit search feed is not confirmed on the live site: `www.reddit.com/search/` gave an empty page to a logged-out headless browser on 2026-11-17; its fixture mirrors the confirmed feed markup.
- `old.reddit.com`, the `new.reddit.com` legacy layout and `twitter.com` are not supported.
- Comments and replies are not processed (Reddit comments, Wykop entry comments, X replies on a status page).
- Link previews are not fingerprinted (Wykop link thumbnails, X link cards, Reddit link thumbnails).
- Text-only posts are ignored; there is no text deduplication.
- A caption change only inside an image corner (outer 25% on both axes) is not detected: the caption guard skips the 4 corner zones, where logos and watermarks usually sit.
- A logo or watermark added in the image centre is checked like a caption change, so such a copy can count as different.
- Third-party embeds (for example YouTube iframes on Wykop and Reddit) are not fingerprinted.
- Animated WebP and AVIF images use the first frame only, as an image.
- Retention purge runs at each background start and on a 24 h alarm; each background restart creates the alarm again, so its 24 h period starts over.
- Firefox has no automated end-to-end tests (Playwright cannot load Firefox extensions); Firefox is covered by unit tests, `npm run lint:firefox` and the manual smoke steps M2, M3 and M5.
- Automated E2E (end-to-end) tests run in Playwright Chromium 151; the minimum versions Chrome 120 and Firefox 128 are not tested.
- No store publication: the extension is not on the Chrome Web Store or AMO.

## Development

| Command                | Purpose                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `npm run assets`       | Generate synthetic test assets into `test/assets/generated/`               |
| `npm run lint`         | Biome lint and format check                                                |
| `npm run typecheck`    | TypeScript check of page code and worker code                              |
| `npm test`             | Unit, DOM, architecture, build, bundle scan and README tests with coverage |
| `npm run build`        | Build `dist/`                                                              |
| `npm run lint:firefox` | `web-ext lint` of `dist/firefox`                                           |
| `npm run test:e2e`     | Build, then Chromium E2E tests on local fixture feeds                      |
| `npm run verify`       | Lint, typecheck, test, build and Firefox lint                              |

- One unit test file: `npx vitest run <path>`.
- One E2E spec: `npx playwright test <path>`.

## Test map

### Ticket test categories

| Category                 | Test files                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fingerprint algorithms   | `src/fingerprint/phash.test.ts`, `src/fingerprint/crops.test.ts`, `src/fingerprint/edges.test.ts`, `src/fingerprint/image-fingerprint.test.ts`, `src/fingerprint/frame-sequence.test.ts`, `src/fingerprint/gif-decoder.test.ts` |
| Similarity thresholds    | `src/similarity/compare.test.ts`, `src/similarity/image-similarity.test.ts`, `src/similarity/hamming.test.ts`, `src/similarity/sequence.test.ts`                                                                                |
| Cross-platform detection | `src/engine/post-decision.test.ts`, `test/adapters/adapters-runtime.test.ts`, `test/e2e/flows.spec.ts`                                                                                                                          |
| Resize and compression   | `src/fingerprint/image-fingerprint.test.ts`, `src/similarity/image-similarity.test.ts`, `test/e2e/media-pipeline.spec.ts`                                                                                                       |
| Video frame matching     | `src/fingerprint/frame-sequence.test.ts`, `src/similarity/sequence.test.ts`, `src/content/video-sampler.test.ts`, `test/e2e/flows.spec.ts`                                                                                      |
| Dynamic DOM changes      | `src/content/scanner.test.ts`, `src/content/runtime.test.ts`, `src/content/navigation.test.ts`, `test/adapters/reddit-late-player.test.ts`                                                                                      |
| False positives          | `test/similarity/false-positives.test.ts`, `src/similarity/caption-guard.test.ts`                                                                                                                                               |
| IndexedDB persistence    | `src/repository/idb-seen-store.test.ts`, `src/repository/seen-repository.test.ts`, `test/e2e/flows.spec.ts`                                                                                                                     |

### Acceptance criteria

| AC     | Topic                                                | Tests                                                                                                    |
| ------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| AC-001 | One build, 2 artifacts                               | `test/build/build.test.ts`                                                                               |
| AC-002 | Chrome load without error                            | `test/e2e/media-pipeline.spec.ts`, M1                                                                    |
| AC-003 | Firefox load without error                           | `test/build/build.test.ts` (manifest), M2                                                                |
| AC-004 | Only compat module reads `chrome` / `browser`        | `test/architecture/browser-globals.test.ts`                                                              |
| AC-005 | Engine independent of adapters, one message contract | `test/architecture/engine-deps.test.ts`, `src/shared/messages.test.ts`                                   |
| AC-006 | lint, typecheck, test, build exit 0                  | `test/build/build.test.ts`                                                                               |
| AC-007 | Background restart keeps matching                    | `src/background/router.test.ts`, `test/e2e/media-pipeline.spec.ts`, M1                                   |
| AC-008 | Image formats fingerprinted from pixels              | `src/decoder/media-decoder.test.ts`, `test/e2e/media-pipeline.spec.ts`                                   |
| AC-009 | Small and flat images ignored                        | `src/adapters/dom-utils.test.ts`, `src/fingerprint/image-fingerprint.test.ts`                            |
| AC-010 | Resize, recompression, conversion                    | `src/fingerprint/image-fingerprint.test.ts`, `src/similarity/image-similarity.test.ts`                   |
| AC-011 | Crop and corner logo                                 | `src/fingerprint/crops.test.ts`, `src/similarity/image-similarity.test.ts`                               |
| AC-012 | Cross-origin image without taint                     | `src/decoder/media-decoder.test.ts`, `test/e2e/media-pipeline.spec.ts`                                   |
| AC-013 | One fetch per URL per page session                   | `src/background/media-service.test.ts`, `test/e2e/media-pipeline.spec.ts`                                |
| AC-014 | `gif` and `video` content types                      | `src/adapters/reddit.test.ts`, `src/adapters/x.test.ts`, `src/decoder/hash-jobs.test.ts`                 |
| AC-015 | 8-frame sequence                                     | `src/fingerprint/frame-sequence.test.ts`, `src/content/video-sampler.test.ts`                            |
| AC-016 | GIF vs MP4 or WebM                                   | `src/fingerprint/frame-sequence.test.ts`, `src/fingerprint/gif-decoder.test.ts`                          |
| AC-017 | MP4 vs WebM is `exact`                               | `src/fingerprint/frame-sequence.test.ts`, `test/e2e/flows.spec.ts`                                       |
| AC-018 | Intro or outro is `near`                             | `src/fingerprint/frame-sequence.test.ts`, `test/e2e/flows.spec.ts`                                       |
| AC-019 | Unrelated videos `different`                         | `src/fingerprint/frame-sequence.test.ts`, `test/e2e/flows.spec.ts`                                       |
| AC-020 | Page video state unchanged                           | `src/content/video-sampler.test.ts`, `test/e2e/flows.spec.ts`                                            |
| AC-021 | No video download                                    | `src/decoder/media-decoder.test.ts`, `test/e2e/flows.spec.ts`, `test/e2e/media-pipeline.spec.ts`         |
| AC-022 | Poster-only fallback or skip                         | `src/content/runtime.test.ts`, `src/decoder/media-decoder.test.ts`, `test/e2e/media-pipeline.spec.ts`    |
| AC-023 | Image match classes                                  | `src/similarity/compare.test.ts`                                                                         |
| AC-024 | Frame sequence match classes                         | `src/similarity/compare.test.ts`, `src/similarity/sequence.test.ts`                                      |
| AC-025 | Compare within one kind                              | `src/similarity/compare.test.ts`, `src/repository/seen-index.test.ts`                                    |
| AC-026 | Mode exact only vs exact and near                    | `src/engine/post-decision.test.ts`                                                                       |
| AC-027 | Caption change is `different`                        | `src/similarity/caption-guard.test.ts`, `test/similarity/false-positives.test.ts`                        |
| AC-028 | Text screenshots are `different`                     | `src/similarity/caption-guard.test.ts`, `test/similarity/false-positives.test.ts`                        |
| AC-029 | Cross-platform hide names the platform               | `test/adapters/adapters-runtime.test.ts`, `test/e2e/flows.spec.ts`, M7                                   |
| AC-030 | No hide by own sighting                              | `src/engine/post-decision.test.ts`, `src/content/page-session.test.ts`                                   |
| AC-031 | Focal post never hidden                              | `src/engine/post-decision.test.ts`, `src/adapters/reddit.test.ts`                                        |
| AC-032 | Seen after 50% for 1 s                               | `src/content/seen-tracker.test.ts`, `src/content/runtime.test.ts`, `test/e2e/flows.spec.ts`              |
| AC-033 | Later post hidden before record                      | `src/content/runtime.test.ts`, `src/engine/post-decision.test.ts`                                        |
| AC-034 | Every media item must match                          | `src/engine/post-decision.test.ts`, `src/content/runtime.test.ts`                                        |
| AC-035 | IndexedDB record fields                              | `src/repository/idb-seen-store.test.ts`, `test/e2e/privacy.spec.ts`                                      |
| AC-036 | Data survives a browser restart                      | `src/repository/idb-seen-store.test.ts`, `test/e2e/flows.spec.ts`                                        |
| AC-037 | Sighting updates the existing record                 | `src/repository/seen-repository.test.ts`                                                                 |
| AC-038 | Retention purge                                      | `src/engine/retention.test.ts`, `src/repository/seen-repository.test.ts`                                 |
| AC-039 | Write throttle                                       | `src/repository/seen-repository.test.ts`                                                                 |
| AC-040 | In-memory fallback and Error state                   | `src/repository/seen-repository.test.ts`, `test/ui/extension-pages.test.ts`                              |
| AC-041 | Clear history and Reset counters                     | `src/background/router.test.ts`, `src/engine/counters.test.ts`                                           |
| AC-042 | Reddit adapter                                       | `src/adapters/reddit.test.ts`, `test/adapters/reddit-late-player.test.ts`, M4                            |
| AC-043 | Wykop adapter                                        | `src/adapters/wykop.test.ts`, M5                                                                         |
| AC-044 | X adapter                                            | `src/adapters/x.test.ts`, M6                                                                             |
| AC-045 | Posts added after load                               | `src/content/scanner.test.ts`, `src/content/runtime.test.ts`, `test/adapters/reddit-late-player.test.ts` |
| AC-046 | Reused post elements                                 | `src/content/scanner.test.ts`, `src/content/runtime.test.ts`                                             |
| AC-047 | In-app navigation                                    | `src/content/navigation.test.ts`, `src/content/runtime.test.ts`, `src/content/teardown.test.ts`          |
| AC-048 | Generic fallback                                     | `src/adapters/generic-fallback.test.ts`                                                                  |
| AC-049 | Platform gating                                      | `src/adapters/registry.test.ts`, `src/content/main.test.ts`                                              |
| AC-050 | Hidden post stays in the DOM                         | `src/content/hider.test.ts`, `test/e2e/flows.spec.ts`                                                    |
| AC-051 | Hide indicator text and size                         | `src/content/ui/indicator.test.ts`, `src/content/ui/relative-time.test.ts`                               |
| AC-052 | "seen on" link                                       | `src/content/ui/indicator.test.ts`, M4                                                                   |
| AC-053 | Show for the page session                            | `src/content/runtime.test.ts`, `test/e2e/flows.spec.ts`                                                  |
| AC-054 | Always show this post                                | `src/content/runtime.test.ts`, `src/engine/post-decision.test.ts`                                        |
| AC-055 | Always show author                                   | `src/content/runtime.test.ts`, `src/engine/post-decision.test.ts`                                        |
| AC-056 | Whitelist manager                                    | `src/shared/whitelist.test.ts`, `test/ui/extension-pages.test.ts`                                        |
| AC-057 | Toast                                                | `src/content/ui/toast.test.ts`, `src/content/runtime.test.ts`                                            |
| AC-058 | Toast off                                            | `src/content/ui/toast.test.ts`, `src/content/runtime.test.ts`                                            |
| AC-059 | Keyboard, focus ring, reduced motion                 | `src/content/ui/indicator.test.ts`, `src/content/ui/toast.test.ts`, `test/e2e/flows.spec.ts`             |
| AC-060 | Page CSS isolation                                   | `src/content/ui/indicator.test.ts`, `src/content/ui/toast.test.ts`, `test/e2e/flows.spec.ts`             |
| AC-061 | Counters                                             | `src/content/runtime.test.ts`, `src/engine/counters.test.ts`, `test/e2e/flows.spec.ts`                   |
| AC-062 | Popup content                                        | `test/ui/extension-pages.test.ts`, `src/ui/shared/format.test.ts`                                        |
| AC-063 | Master toggle in open tabs                           | `src/content/main.test.ts`, `test/e2e/flows.spec.ts`                                                     |
| AC-064 | Settings saved at once in `storage.local`            | `src/shared/settings.test.ts`, `test/ui/extension-pages.test.ts`                                         |
| AC-065 | Platform toggle reveals                              | `src/content/main.test.ts`, `test/e2e/flows.spec.ts`                                                     |
| AC-066 | Content type toggle                                  | `src/content/runtime.test.ts`, `test/ui/extension-pages.test.ts`                                         |
| AC-067 | Options page content                                 | `test/ui/extension-pages.test.ts`                                                                        |
| AC-068 | Threshold validation                                 | `src/shared/settings.test.ts`, `test/ui/extension-pages.test.ts`                                         |
| AC-069 | Permission needed state                              | `test/ui/extension-pages.test.ts`, M3                                                                    |
| AC-070 | Requests only to page media URLs                     | `src/shared/hosts.test.ts`, `src/decoder/media-decoder.test.ts`, `test/e2e/privacy.spec.ts`              |
| AC-071 | Manifest permissions                                 | `test/build/build.test.ts`                                                                               |
| AC-072 | No remote code, telemetry or foreign URL             | `test/build/bundle-scan.test.ts`, `test/e2e/privacy.spec.ts`                                             |
| AC-073 | Stored data minimum                                  | `test/e2e/privacy.spec.ts`                                                                               |
| AC-074 | Start-up time and lookahead                          | `src/content/runtime.test.ts`, `test/e2e/performance.spec.ts`                                            |
| AC-075 | No long task, hashing off the main thread            | `src/decoder/worker-client.test.ts`, `test/e2e/performance.spec.ts`                                      |
| AC-076 | 4 jobs, nearest first                                | `src/content/lookahead-queue.test.ts`, `src/content/runtime.test.ts`                                     |
| AC-077 | Duplicates hidden before half visible                | `test/e2e/performance.spec.ts`                                                                           |
| AC-078 | Lookup p95 with 50,000 records                       | `src/repository/seen-repository.test.ts`                                                                 |
| AC-079 | README content                                       | `test/build/readme.test.ts`                                                                              |
| AC-080 | Synthetic test assets                                | `test/assets/generate-assets.test.ts`                                                                    |
| AC-081 | Test categories mapped                               | `test/build/readme.test.ts`                                                                              |

## Manual smoke

Run on the built `dist/` before a release; the automated tests cannot cover these.

- M1 (TC-002): Chrome `chrome://extensions` -> Developer mode -> Load unpacked `dist/chrome` -> no "Errors" button; stop the worker in `chrome://serviceworker-internals`, scroll a feed -> hiding still works.
- M2 (TC-003): Firefox `about:debugging#/runtime/this-firefox` -> Load Temporary Add-on `dist/firefox/manifest.json` -> Inspect -> console has 0 errors.
- M3 (TC-089): Firefox `about:addons` -> PureFeed -> Permissions -> turn off the 3 sites -> popup shows "Permission needed" -> "Grant access" -> normal popup.
- M4 (TC-090): logged-in Reddit home in Chrome, scroll 100 posts -> reposts hidden; "Show", "Always show this post", "Always show u/<author>" and the "seen on" link work.
- M5 (TC-091): Wykop microblog in Firefox, scroll 100 posts -> reposts hidden.
- M6 (TC-092): logged-in X home in Chrome, scroll 100 posts -> reposts hidden; DevTools Network of the service worker and offscreen document shows only `pbs.twimg.com` and `video.twimg.com` requests.
- M7 (AC-029 live): open a meme on Wykop, find the same meme on Reddit or X -> indicator says "seen on Wykop".
- M8: update the table below after each live check.

| Platform | Selectors last confirmed on the live site                |
| -------- | -------------------------------------------------------- |
| Reddit   | 2026-11-17 (feed post markup; search feed not confirmed) |
| Wykop    | 2026-11-17                                               |
| X        | Not confirmed (login needed)                             |
