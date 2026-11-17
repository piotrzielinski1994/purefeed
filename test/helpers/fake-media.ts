import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FRAME_FPS, type VideoMeta } from '../../scripts/generate-assets.ts';
import { fingerprintSequence } from '../../src/fingerprint/frame-sequence.ts';
import { decodeGif, fingerprintGif } from '../../src/fingerprint/gif-decoder.ts';
import { resizeArea } from '../../src/fingerprint/gray.ts';
import { fingerprintImage } from '../../src/fingerprint/image-fingerprint.ts';
import type { DecodeResult, GrayFrame, GrayImage } from '../../src/shared/types.ts';
import { assetPath, loadGray } from './assets.ts';

export type FakeVideoSpec =
  | { mode: 'ok'; durationS: number; frame: (tS: number) => GrayImage }
  | { mode: 'tainted'; durationS: number }
  | { mode: 'stalls-on-seek'; durationS: number }
  | { mode: 'never-loads' }
  | { mode: 'error' };

export type FakeVideoRecord = {
  element: HTMLVideoElement;
  srcs: string[];
  seeks: number[];
  loadCalls: number;
  disposed: boolean;
  seeksAfterDispose: number;
};

export type FakeMedia = {
  addVideo(url: string, spec: FakeVideoSpec): void;
  readonly videos: FakeVideoRecord[];
  recordOf(element: HTMLVideoElement): FakeVideoRecord;
  restore(): void;
};

type VideoState = {
  record: FakeVideoRecord;
  startedSrc: string | null;
  spec: FakeVideoSpec | null;
  durationS: number;
  readyState: number;
  currentTime: number;
  seeking: boolean;
  error: { code: number; message: string } | null;
};

type Drawn = { state: VideoState; tS: number } | null;

const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

export function installFakeMedia(): FakeMedia {
  const specs = new Map<string, FakeVideoSpec>();
  const states = new WeakMap<object, VideoState>();
  const videos: FakeVideoRecord[] = [];
  const restorers: Array<() => void> = [];

  const patch = (target: object, key: string, descriptor: PropertyDescriptor) => {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    restorers.push(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else delete (target as Record<string, unknown>)[key];
    });
  };

  const stateOf = (el: HTMLMediaElement): VideoState => {
    let state = states.get(el);
    if (!state) {
      const record: FakeVideoRecord = {
        element: el as HTMLVideoElement,
        srcs: [],
        seeks: [],
        loadCalls: 0,
        disposed: false,
        seeksAfterDispose: 0,
      };
      state = { record, startedSrc: null, spec: null, durationS: Number.NaN, readyState: 0, currentTime: 0, seeking: false, error: null };
      states.set(el, state);
      videos.push(record);
    }
    return state;
  };

  const fire = (el: HTMLMediaElement, ...types: string[]) => {
    for (const type of types) el.dispatchEvent(new Event(type));
  };

  const startLoad = (el: HTMLMediaElement, src: string) => {
    const state = stateOf(el);
    if (state.startedSrc === src) return;
    state.startedSrc = src;
    state.record.srcs.push(src);
    const spec = specs.get(src) ?? { mode: 'error' };
    state.spec = spec;
    queueMicrotask(() => {
      if (state.startedSrc !== src) return;
      fire(el, 'loadstart');
      if (spec.mode === 'never-loads') return;
      if (spec.mode === 'error') {
        state.error = { code: MEDIA_ERR_SRC_NOT_SUPPORTED, message: 'MEDIA_ELEMENT_ERROR: Format error' };
        fire(el, 'error');
        return;
      }
      state.durationS = spec.durationS;
      state.readyState = 1;
      fire(el, 'durationchange', 'loadedmetadata');
      if (spec.mode === 'stalls-on-seek') return;
      state.readyState = 4;
      fire(el, 'loadeddata', 'canplay', 'canplaythrough');
    });
  };

  const unload = (el: HTMLMediaElement) => {
    const state = stateOf(el);
    state.startedSrc = null;
    state.spec = null;
    state.durationS = Number.NaN;
    state.readyState = 0;
  };

  const media = HTMLMediaElement.prototype;
  const originalSetAttribute = Element.prototype.setAttribute;
  const originalRemoveAttribute = Element.prototype.removeAttribute;

  patch(media, 'setAttribute', {
    value(this: HTMLMediaElement, name: string, value: string) {
      originalSetAttribute.call(this, name, value);
      if (name.toLowerCase() === 'src') {
        if (value) startLoad(this, value);
        else unload(this);
      }
    },
    writable: true,
  });
  patch(media, 'removeAttribute', {
    value(this: HTMLMediaElement, name: string) {
      originalRemoveAttribute.call(this, name);
      if (name.toLowerCase() === 'src') unload(this);
    },
    writable: true,
  });
  patch(media, 'load', {
    value(this: HTMLMediaElement) {
      const state = stateOf(this);
      state.record.loadCalls++;
      const src = this.getAttribute('src');
      if (src) {
        startLoad(this, src);
      } else {
        unload(this);
        state.record.disposed = true;
        fire(this, 'emptied');
      }
    },
    writable: true,
  });
  patch(media, 'currentTime', {
    get(this: HTMLMediaElement) {
      return stateOf(this).currentTime;
    },
    set(this: HTMLMediaElement, value: number) {
      const state = stateOf(this);
      state.currentTime = Number(value);
      state.record.seeks.push(Number(value));
      if (state.record.disposed) state.record.seeksAfterDispose++;
      if (state.readyState === 0 || state.spec?.mode === 'stalls-on-seek') return;
      state.seeking = true;
      fire(this, 'seeking');
      queueMicrotask(() => {
        state.seeking = false;
        fire(this, 'timeupdate', 'seeked');
      });
    },
  });
  const getter = (target: object, key: string, read: (state: VideoState) => unknown) =>
    patch(target, key, {
      get(this: HTMLMediaElement) {
        return read(stateOf(this));
      },
    });
  getter(media, 'duration', (state) => state.durationS);
  getter(media, 'readyState', (state) => state.readyState);
  getter(media, 'seeking', (state) => state.seeking);
  getter(media, 'error', (state) => state.error);
  getter(HTMLVideoElement.prototype, 'videoWidth', (state) => (state.readyState > 0 ? 640 : 0));
  getter(HTMLVideoElement.prototype, 'videoHeight', (state) => (state.readyState > 0 ? 360 : 0));

  const makeContext = () => {
    let drawn: Drawn = null;
    return {
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
      drawImage(source: unknown) {
        const state = source instanceof HTMLMediaElement ? states.get(source) : undefined;
        drawn = state ? { state, tS: state.currentTime } : null;
      },
      clearRect() {},
      fillRect() {},
      getImageData(_sx: number, _sy: number, sw: number, sh: number) {
        const spec = drawn?.state.spec;
        if (spec?.mode === 'tainted') {
          throw new DOMException("Failed to execute 'getImageData': The canvas has been tainted by cross-origin data.", 'SecurityError');
        }
        const data = new Uint8ClampedArray(sw * sh * 4);
        if (drawn && spec?.mode === 'ok') {
          const gray = resizeArea(spec.frame(drawn.tS), sw, sh);
          for (let i = 0; i < gray.data.length; i++) {
            data.set([gray.data[i], gray.data[i], gray.data[i], 255], i * 4);
          }
        }
        return { width: sw, height: sh, data, colorSpace: 'srgb' };
      },
    };
  };

  patch(HTMLCanvasElement.prototype, 'getContext', {
    value(this: HTMLCanvasElement, type: string) {
      return type === '2d' ? makeContext() : null;
    },
    writable: true,
  });
  if (typeof OffscreenCanvas !== 'undefined') {
    patch(OffscreenCanvas.prototype, 'getContext', {
      value(type: string) {
        return type === '2d' ? makeContext() : null;
      },
      writable: true,
    });
  }

  return {
    addVideo: (url, spec) => void specs.set(url, spec),
    videos,
    recordOf: (element) => stateOf(element).record,
    restore: () => {
      for (const restore of restorers.reverse()) restore();
      restorers.length = 0;
    },
  };
}

export function videoFromAsset(name: string): FakeVideoSpec {
  const { durationS, width, height } = JSON.parse(readFileSync(assetPath(`${name}.json`), 'utf8')) as VideoMeta;
  const frames = new Uint8Array(readFileSync(assetPath(`${name}.frames.gray`)));
  const frameBytes = width * height;
  const last = Math.floor(frames.length / frameBytes) - 1;
  return {
    mode: 'ok',
    durationS,
    frame: (tS) => {
      const index = Math.max(0, Math.min(Math.round(tS * FRAME_FPS), last));
      return { width, height, data: frames.slice(index * frameBytes, (index + 1) * frameBytes) };
    },
  };
}

export type FetchCall = { url: string; init: RequestInit | undefined };
export type FakeRoute = { asset: string; mime: string } | { status: number };

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export type FakeWorkerClient = {
  hashImage(bytes: ArrayBuffer, mime: string): Promise<DecodeResult>;
  hashFrames(frames: GrayFrame[], durationS: number): Promise<DecodeResult>;
};

export function createMediaFakes(routes: Record<string, FakeRoute>): {
  fetch: typeof fetch;
  calls: FetchCall[];
  worker: FakeWorkerClient;
  workerCalls: { hashImage: number; hashFrames: number };
} {
  const calls: FetchCall[] = [];
  const assetsByHash = new Map<string, string>();
  const workerCalls = { hashImage: 0, hashFrames: 0 };

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const route = routes[url];
    if (!route || 'status' in route) {
      return new Response('not found', { status: route && 'status' in route ? route.status : 404 });
    }
    const bytes = new Uint8Array(readFileSync(assetPath(route.asset)));
    assetsByHash.set(sha256(bytes), route.asset);
    return new Response(bytes, { status: 200, headers: { 'content-type': route.mime } });
  }) as typeof fetch;

  const worker: FakeWorkerClient = {
    async hashImage(buffer) {
      workerCalls.hashImage++;
      const bytes = new Uint8Array(buffer);
      if (String.fromCharCode(...bytes.subarray(0, 4)) === 'GIF8') {
        const fp = fingerprintGif(decodeGif(bytes));
        if (!fp) return { status: 'skipped', reason: 'flat' };
        return { status: 'ok', contentType: fp.kind === 'sequence' ? 'gif' : 'image', fingerprint: fp };
      }
      const name = assetsByHash.get(sha256(bytes));
      if (!name) return { status: 'skipped', reason: 'unreadable' };
      const fp = fingerprintImage(loadGray(name));
      return fp ? { status: 'ok', contentType: 'image', fingerprint: fp } : { status: 'skipped', reason: 'flat' };
    },
    async hashFrames(frames, durationS) {
      workerCalls.hashFrames++;
      return { status: 'ok', contentType: 'video', fingerprint: fingerprintSequence(frames, durationS) };
    },
  };

  return { fetch: fakeFetch, calls, worker, workerCalls };
}
