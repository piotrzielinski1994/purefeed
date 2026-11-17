import type { DetectedMedia, DetectedPost, PlatformAdapter } from '../adapters/adapter.ts';
import { isMediaItem, isVideo } from '../adapters/dom-utils.ts';
import { createFallbackAdapter } from '../adapters/generic-fallback.ts';
import type { sendRequest } from '../compat/messaging.ts';
import { decidePost, type ItemEvidence, type PostDecision } from '../engine/post-decision.ts';
import { sampleTimestamps } from '../fingerprint/frame-sequence.ts';
import { DEFAULT_SETTINGS } from '../shared/settings.ts';
import type {
  ContentType,
  DecodeResult,
  Fingerprint,
  GrayFrame,
  RecordId,
  SeenMatch,
  SetTimer,
  Settings,
  Thresholds,
  WhitelistEntry,
} from '../shared/types.ts';
import { decodeDecodeResult, encodeFingerprint, encodeGrayFrame, encodeSighting } from '../shared/wire.ts';
import { compareFingerprints } from '../similarity/compare.ts';
import { hidePost, isHidden, revealPost } from './hider.ts';
import { createLookaheadQueue } from './lookahead-queue.ts';
import { watchUrl } from './navigation.ts';
import { createPageSession } from './page-session.ts';
import { createPostScanner, type PostScanner } from './scanner.ts';
import { createSeenTracker, type ObserverFactory } from './seen-tracker.ts';
import { createIndicator } from './ui/indicator.ts';
import { createToaster } from './ui/toast.ts';
import { createVideoSampler } from './video-sampler.ts';

const LOOKAHEAD_MARGIN = '0px 0px 150% 0px';
const CONCURRENT_JOBS = 4;
const DWELL_MS = 1000;
const FRAME_SIDE = 64;
const FRAME_TIMEOUT_MS = 10_000;
const TOAST_WINDOW_MS = 3000;
const TOAST_VISIBLE_MS = 4000;
const NO_RECORDS: ReadonlySet<RecordId> = new Set();
const UNREADABLE: DecodeResult = { status: 'skipped', reason: 'unreadable' };
const FALLBACK_AFTER_MS = 10_000;
const FALLBACK_MIN_MEDIA = 3;
const LATE_MEDIA_POLL_MS = 500;

type Item = { media: DetectedMedia; contentType: ContentType; fingerprint: Fingerprint; seen: SeenMatch | null; url: string };
type Slot = { status: 'pending'; contentType: ContentType } | { status: 'skipped' } | { status: 'ok'; item: Item };
type PostState = { post: DetectedPost; slots: Map<Element, Slot> };
type Job = { el: Element; run: () => Promise<void> };

export type ContentRuntimeDeps = {
  adapter: PlatformAdapter;
  doc: Document;
  win: Window;
  send: typeof sendRequest;
  createObserver: ObserverFactory;
  now: () => number;
  setTimer: SetTimer;
  clearTimer: (id: unknown) => void;
  isWhitelisted?: (key: string) => boolean;
  isContextValid?: () => boolean;
};

export type ContentRuntime = {
  start(): void;
  stop(): void;
  reevaluateAll(settings: Settings): void;
  revealAll(filter?: (p: DetectedPost) => boolean): void;
};

const follows = (el: Element, other: Element): boolean => Boolean(other.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);

export function createContentRuntime(deps: ContentRuntimeDeps): ContentRuntime {
  const { doc, send } = deps;
  let adapter = deps.adapter;
  const session = createPageSession(deps.now);
  const states = new Map<Element, PostState>();
  const elementOfKey = new Map<string, Element>();
  const inLookahead = new WeakSet<Element>();
  const observed = new WeakSet<Element>();
  const tracked = new Map<Element, { state: PostState; item: Item }>();
  const recorded = new Set<string>();
  const disposers = new Set<() => void>();
  const whitelisted = new Set<string>();
  const toaster = createToaster(doc, {
    windowMs: TOAST_WINDOW_MS,
    visibleMs: TOAST_VISIBLE_MS,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
  });
  let settings = DEFAULT_SETTINGS;
  let isRunning = false;
  let scanner: PostScanner | null = null;
  let stopWatchingUrl: (() => void) | null = null;
  let fallbackTimer: unknown = null;
  let lateMediaTimer: unknown = null;
  const awaitingMedia = new Set<PostState>();

  const thresholds = (): Thresholds => ({ exact: settings.exactThreshold, near: settings.nearThreshold });
  const isActive = () => isRunning && settings.enabled && settings.platforms[adapter.platform];
  const isCurrent = (state: PostState) => isRunning && states.get(state.post.el) === state;
  const isTypeOn = (media: DetectedMedia) => settings.contentTypes[media.contentType];

  const queue = createLookaheadQueue<Job>({
    concurrency: CONCURRENT_JOBS,
    priority: (job) => Math.abs(job.el.getBoundingClientRect().top),
    run: (job) => job.run(),
  });

  const okItems = (state: PostState): Item[] => [...state.slots.values()].flatMap((slot) => (slot.status === 'ok' ? [slot.item] : []));

  function decide(state: PostState): PostDecision {
    const { post } = state;
    const precedes = (otherKey: string) => {
      const other = elementOfKey.get(otherKey);
      return !other?.isConnected || follows(post.el, other);
    };
    const items = [...state.slots.values()].flatMap((slot): ItemEvidence[] => {
      if (slot.status === 'skipped') {
        return [];
      }
      if (slot.status === 'pending') {
        return [{ contentType: slot.contentType, seen: null, session: null }];
      }
      const { item } = slot;
      return [
        {
          contentType: item.contentType,
          seen: item.seen,
          session: session.findSessionMatch(item.fingerprint, post.postKey, precedes, thresholds()),
        },
      ];
    });
    return decidePost({
      postKey: post.postKey,
      platform: adapter.platform,
      sourceKeys: post.sourceKeys,
      isFocal: adapter.focalPostKey(new URL(deps.win.location.href)) === post.postKey,
      revealed: session.revealed.has(post.postKey),
      items,
      settings,
      isWhitelisted: (key) => whitelisted.has(key) || (deps.isWhitelisted?.(key) ?? false),
      ownRecordIds: session.ownRecordIds.get(post.postKey) ?? NO_RECORDS,
    });
  }

  function alwaysShow(entry: WhitelistEntry): void {
    whitelisted.add(entry.key);
    send({ type: 'whitelist/add', entry }).catch(() => undefined);
    states.forEach(apply);
  }

  function indicatorFor(state: PostState, decision: Extract<PostDecision, { hide: true }>): HTMLElement {
    const { postKey, authorKey } = state.post;
    const authorLabel = authorKey === null ? null : authorKey.slice(authorKey.indexOf(':') + 1);
    return createIndicator(
      doc,
      { ...decision, authorLabel, nowMs: deps.now() },
      {
        onShow: () => {
          session.revealed.add(postKey);
          apply(state);
        },
        onAlwaysShowPost: () => alwaysShow({ type: 'post', key: postKey }),
        onAlwaysShowAuthor: () => {
          if (authorKey !== null) {
            alwaysShow({ type: 'source', key: authorKey });
          }
        },
      },
    );
  }

  function countHidden(postKey: string): void {
    if (session.hiddenCounted.has(postKey)) {
      return;
    }
    session.hiddenCounted.add(postKey);
    send({ type: 'stats/hidden' }).catch(() => undefined);
    if (settings.toast) {
      toaster.notifyHidden();
    }
  }

  function apply(state: PostState): void {
    const decision = decide(state);
    const { el, postKey } = state.post;
    session.decisions.set(postKey, decision);
    if (!decision.hide) {
      revealPost(el);
      return;
    }
    if (!isHidden(el)) {
      hidePost(el, indicatorFor(state, decision));
      countHidden(postKey);
    }
  }

  function applyLaterMatches(source: PostState, fp: Fingerprint): void {
    states.forEach((other) => {
      const isLater = other.post.postKey !== source.post.postKey && follows(other.post.el, source.post.el);
      if (isLater && okItems(other).some((item) => compareFingerprints(fp, item.fingerprint, thresholds()).matchClass !== 'different')) {
        apply(other);
      }
    });
  }

  async function resolveItem(state: PostState, media: DetectedMedia, url: string, result: Promise<DecodeResult>): Promise<void> {
    const decoded = await result.catch(() => UNREADABLE);
    if (!isCurrent(state)) {
      return;
    }
    if (decoded.status !== 'ok') {
      state.slots.set(media.el, { status: 'skipped' });
      apply(state);
      return;
    }
    const { fingerprint } = decoded;
    const lookup = await send({ type: 'seen/lookup', fingerprints: [encodeFingerprint(fingerprint)] }).catch(() => ({ matches: [null] }));
    if (!isCurrent(state)) {
      return;
    }
    const contentType = isVideo(media.el) ? media.contentType : decoded.contentType;
    const item: Item = { media, contentType, fingerprint, seen: lookup.matches[0] ?? null, url };
    const { post } = state;
    state.slots.set(media.el, { status: 'ok', item });
    session.addItem({ postKey: post.postKey, platform: adapter.platform, permalink: post.permalink, fingerprint });
    tracked.set(media.el, { state, item });
    tracker.track(media.el);
    apply(state);
    applyLaterMatches(state, fingerprint);
  }

  function urlResult(url: string, media: DetectedMedia): Promise<DecodeResult> {
    const cached = session.urlResults.get(url);
    if (cached) {
      return cached;
    }
    const result = send({ type: 'media/fingerprint', req: { url, contentType: media.contentType, posterUrl: media.posterUrl } }).then(
      decodeDecodeResult,
    );
    session.urlResults.set(url, result);
    return result;
  }

  function whenDuration(video: HTMLVideoElement, onDuration: (durationS: number) => void, onTimeout: () => void): void {
    const hasDuration = () => Number.isFinite(video.duration) && video.duration > 0;
    if (hasDuration()) {
      onDuration(video.duration);
      return;
    }
    const cancel = () => {
      deps.clearTimer(timer);
      video.removeEventListener('durationchange', onChange);
      disposers.delete(cancel);
    };
    const onChange = () => {
      if (hasDuration()) {
        cancel();
        onDuration(video.duration);
      }
    };
    const timer = deps.setTimer(() => {
      cancel();
      onTimeout();
    }, FRAME_TIMEOUT_MS);
    video.addEventListener('durationchange', onChange);
    disposers.add(cancel);
  }

  function sampleVideo(state: PostState, media: DetectedMedia, video: HTMLVideoElement): void {
    const url = video.currentSrc || video.src;
    const sendFrames = (frames: GrayFrame[] | null) => {
      const durationS = Number.isFinite(video.duration) ? video.duration : 0;
      const request = { type: 'media/frames', frames: (frames ?? []).map(encodeGrayFrame), durationS, posterUrl: media.posterUrl } as const;
      queue.push({ el: video, run: () => resolveItem(state, media, url, send(request).then(decodeDecodeResult)) });
    };
    whenDuration(
      video,
      (durationS) => {
        const dispose = createVideoSampler(video, {
          targets: sampleTimestamps(durationS),
          size: FRAME_SIDE,
          timeoutMs: FRAME_TIMEOUT_MS,
          onDone: (frames) => {
            disposers.delete(dispose);
            sendFrames(frames);
          },
        });
        disposers.add(dispose);
      },
      () => sendFrames(null),
    );
  }

  const hasEmptyMediaHost = (el: Element): boolean =>
    adapter.lateMediaHostSelector !== undefined &&
    [...el.querySelectorAll(adapter.lateMediaHostSelector)].some((host) => !host.shadowRoot?.querySelector('img, video'));

  function checkLateMedia(): void {
    lateMediaTimer = null;
    const waiting = [...awaitingMedia];
    awaitingMedia.clear();
    waiting.forEach((state) => {
      const post = adapter.readPost(state.post.el);
      if (isCurrent(state) && post?.postKey === state.post.postKey) {
        state.post = post;
        processPost(state);
      }
    });
  }

  function awaitLateMedia(state: PostState): void {
    awaitingMedia.add(state);
    lateMediaTimer ??= deps.setTimer(checkLateMedia, LATE_MEDIA_POLL_MS);
  }

  function processPost(state: PostState): void {
    if (!isActive() || !inLookahead.has(state.post.el)) {
      return;
    }
    if (hasEmptyMediaHost(state.post.el)) {
      awaitLateMedia(state);
    }
    state.post.media.forEach((media) => {
      if (state.slots.has(media.el) || !isTypeOn(media) || !isMediaItem(media.el)) {
        return;
      }
      if (isVideo(media.el)) {
        state.slots.set(media.el, { status: 'pending', contentType: media.contentType });
        sampleVideo(state, media, media.el);
        return;
      }
      const url = media.el.currentSrc || media.el.src;
      if (!url) {
        return;
      }
      state.slots.set(media.el, { status: 'pending', contentType: media.contentType });
      queue.push({ el: media.el, run: () => resolveItem(state, media, url, urlResult(url, media)) });
    });
  }

  function record(state: PostState, item: Item): void {
    const { postKey, permalink } = state.post;
    const key = `${postKey}\n${item.url}`;
    if (!isActive() || recorded.has(key)) {
      return;
    }
    recorded.add(key);
    const sighting = encodeSighting({
      fingerprint: item.fingerprint,
      contentType: item.contentType,
      platform: adapter.platform,
      postKey,
      permalink,
    });
    send({ type: 'seen/record', sighting })
      .then(({ recordId }) => {
        session.ownRecordIds.set(postKey, new Set([...(session.ownRecordIds.get(postKey) ?? []), recordId]));
      })
      .catch(() => undefined);
  }

  const tracker = createSeenTracker({
    createObserver: deps.createObserver,
    dwellMs: DWELL_MS,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    onSeen: (el) => {
      const entry = tracked.get(el);
      if (entry && isCurrent(entry.state)) {
        record(entry.state, entry.item);
      }
    },
  });

  const lookahead = deps.createObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          inLookahead.delete(entry.target);
          return;
        }
        inLookahead.add(entry.target);
        const state = states.get(entry.target);
        if (state) {
          processPost(state);
        }
      });
    },
    { rootMargin: LOOKAHEAD_MARGIN },
  );

  function untrackAll(state: PostState): void {
    state.slots.forEach((_slot, el) => {
      tracker.untrack(el);
      tracked.delete(el);
    });
  }

  function onPost(post: DetectedPost): void {
    const existing = states.get(post.el);
    if (existing?.post.postKey === post.postKey) {
      existing.post = post;
      processPost(existing);
      return;
    }
    const state: PostState = { post, slots: new Map() };
    states.set(post.el, state);
    elementOfKey.set(post.postKey, post.el);
    if (!observed.has(post.el)) {
      observed.add(post.el);
      lookahead.observe(post.el);
    }
    processPost(state);
  }

  function onKeyChanged(el: Element): void {
    const old = states.get(el);
    if (old) {
      untrackAll(old);
    }
    states.delete(el);
    revealPost(el);
  }

  function checkFallback(): void {
    fallbackTimer = null;
    if (states.size > 0) {
      return;
    }
    const mediaItems = [...doc.querySelectorAll('img, video')].filter(isMediaItem).length;
    if (!isActive() || doc.querySelector(adapter.postSelector) !== null || mediaItems < FALLBACK_MIN_MEDIA) {
      fallbackTimer = deps.setTimer(checkFallback, FALLBACK_AFTER_MS);
      return;
    }
    adapter = createFallbackAdapter(deps.adapter.platform, deps.win.location.host);
    scanner?.disconnect();
    scanner = createPostScanner({ root: doc, adapter, onPost, onKeyChanged });
    scanner.scanNow();
    send({
      type: 'log/warn',
      message: `PureFeed: the ${adapter.platform} adapter found no posts for ${FALLBACK_AFTER_MS / 1000} s; generic fallback active`,
    }).catch(() => undefined);
  }

  const reapplyAll = () => {
    states.forEach((state) => {
      processPost(state);
      apply(state);
    });
  };

  function stop(): void {
    isRunning = false;
    deps.clearTimer(fallbackTimer);
    deps.clearTimer(lateMediaTimer);
    awaitingMedia.clear();
    scanner?.disconnect();
    stopWatchingUrl?.();
    lookahead.disconnect();
    disposers.forEach((dispose) => {
      dispose();
    });
    disposers.clear();
    tracker.dispose();
    toaster.dispose();
  }

  const isAlive = (): boolean => {
    if (deps.isContextValid?.() ?? true) {
      return true;
    }
    stop();
    return false;
  };

  return {
    start() {
      isRunning = true;
      scanner = createPostScanner({ root: doc, adapter, onPost, onKeyChanged });
      stopWatchingUrl = watchUrl(
        deps.win,
        () => {
          scanner?.scanNow();
          reapplyAll();
        },
        undefined,
        isAlive,
      );
      scanner.scanNow();
      fallbackTimer = deps.setTimer(checkFallback, FALLBACK_AFTER_MS);
    },
    stop,
    reevaluateAll(next) {
      settings = next;
      reapplyAll();
    },
    revealAll(filter) {
      states.forEach((state) => {
        if (!filter || filter(state.post)) {
          revealPost(state.post.el);
        }
      });
    },
  };
}
