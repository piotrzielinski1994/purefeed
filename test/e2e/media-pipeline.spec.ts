import type { BrowserContext } from '@playwright/test';
import type { DecodeRequest, DecodeResult, Fingerprint } from '../../src/shared/types.ts';
import { decodeDecodeResult, encodeSighting, type WireDecodeResult } from '../../src/shared/wire.ts';
import { compareFingerprints } from '../../src/similarity/compare.ts';
import { DEFAULT_THRESHOLDS } from '../helpers/fingerprints.ts';
import { expect, type SendRequest, stopServiceWorkers, extensionTest as test } from './extension.ts';
import type { RequestLogEntry } from './server.ts';

const VIDEO_TIMEOUT_MS = 45_000;

const image = (url: string): DecodeRequest => ({ url, contentType: 'image', posterUrl: null });

async function fingerprint(send: SendRequest, req: DecodeRequest, timeoutMs?: number): Promise<DecodeResult> {
  const wire: WireDecodeResult = await send({ type: 'media/fingerprint', req }, timeoutMs);
  return decodeDecodeResult(wire);
}

function okFingerprint(result: DecodeResult): Fingerprint {
  if (result.status !== 'ok') throw new Error(`expected an ok decode result, got ${JSON.stringify(result)}`);
  return result.fingerprint;
}

const extensionRequests = (log: RequestLogEntry[], path?: string) =>
  log.filter((entry) => entry.fromExtension && (path === undefined || entry.path.split('?')[0] === path));

async function extensionErrors(context: BrowserContext, extensionId: string): Promise<unknown[]> {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions/');
    return await page.evaluate(async (id) => {
      type Info = { runtimeErrors?: unknown[]; manifestErrors?: unknown[] };
      const api = (globalThis as unknown as { chrome: { developerPrivate: { getExtensionInfo(id: string): Promise<Info> } } }).chrome;
      const info = await api.developerPrivate.getExtensionInfo(id);
      return [...(info.runtimeErrors ?? []), ...(info.manifestErrors ?? [])];
    }, extensionId);
  } finally {
    await page.close();
  }
}

test.describe('media pipeline in Chromium (AC-002, AC-007, AC-008, AC-012, AC-013, AC-021, AC-022, AC-070)', () => {
  test('should start the service worker and show no extension error after a media request (TC-002)', async ({
    context,
    serviceWorker,
    extensionId,
    send,
  }) => {
    const errors: string[] = [];
    serviceWorker.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    context.on('weberror', (error) => errors.push(error.error().message));
    expect(serviceWorker.url()).toBe(`chrome-extension://${extensionId}/background.js`);
    const result = await fingerprint(send, image('https://i.redd.it/base.png?tc=002'));
    expect(result).toMatchObject({ status: 'ok', contentType: 'image', fingerprint: { kind: 'image' } });
    expect(errors).toEqual([]);
    expect(await extensionErrors(context, extensionId)).toEqual([]);
  });

  test('should fingerprint a 600 x 600 image in JPEG, PNG, WebP, AVIF, BMP and static GIF as the same picture (TC-008)', async ({ send }) => {
    const base = okFingerprint(await fingerprint(send, image('https://i.redd.it/base.png?tc=008')));
    const formats = ['base-q60.jpg', 'base.webp', 'base.avif', 'base.bmp', 'base-static.gif'];
    const results = await Promise.all(formats.map((name) => fingerprint(send, image(`https://i.redd.it/${name}?tc=008`))));
    const summary = results.map((result, i) => ({
      name: formats[i],
      status: result.status,
      contentType: result.status === 'ok' ? result.contentType : null,
      matchClass: result.status === 'ok' ? compareFingerprints(result.fingerprint, base, DEFAULT_THRESHOLDS).matchClass : null,
    }));
    expect(summary).toEqual(formats.map((name) => ({ name, status: 'ok', contentType: 'image', matchClass: 'exact' })));
  });

  test('should give equal fingerprints for the same image under 2 URLs (TC-009)', async ({ send }) => {
    const a = okFingerprint(await fingerprint(send, image('https://i.redd.it/base.png?width=600&s=aaa')));
    const b = okFingerprint(await fingerprint(send, image('https://preview.redd.it/base.png?width=600&format=png&s=bbb')));
    expect(b).toEqual(a);
  });

  test('should give an animated GIF content type gif and 3 frames if requested as an image (TC-018, TC-020)', async ({ send }) => {
    const result = await fingerprint(send, image('https://i.redd.it/loop.gif?tc=020'));
    expect(result).toMatchObject({ status: 'ok', contentType: 'gif', fingerprint: { kind: 'sequence' } });
    expect(Array.from((okFingerprint(result) as Extract<Fingerprint, { kind: 'sequence' }>).timestamps)).toHaveLength(3);
  });

  test('should fingerprint a cross-origin image without CORS headers and request only its currentSrc URL (TC-016)', async ({
    context,
    send,
    server,
  }) => {
    const page = await context.newPage();
    await page.goto('https://x.com/fixture/media/x-photo.html');
    const currentSrc = await page.locator('#photo').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0 && img.currentSrc);
    expect(currentSrc).toMatch(/^https:\/\/pbs\.twimg\.com\/media\/base\.png\?/);
    const result = await fingerprint(send, image(currentSrc as string));
    expect(result).toMatchObject({ status: 'ok', contentType: 'image', fingerprint: { kind: 'image' } });
    const url = new URL(currentSrc as string);
    expect(extensionRequests(server.log).map((e) => ({ host: e.host, path: e.path, hasBody: e.hasBody }))).toEqual([
      { host: url.host, path: `${url.pathname}${url.search}`, hasBody: false },
    ]);
  });

  test('should send 1 request for a media URL that 3 posts carry (TC-017)', async ({ send, server }) => {
    const req = image('https://pbs.twimg.com/media/other-1.png?format=png&name=small&tc=017');
    const results = await Promise.all([fingerprint(send, req), fingerprint(send, req), fingerprint(send, req)]);
    expect(results[0]).toMatchObject({ status: 'ok', contentType: 'image' });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    const later = await fingerprint(send, req);
    expect(later).toEqual(results[0]);
    expect(extensionRequests(server.log, '/media/other-1.png')).toHaveLength(1);
  });

  test('should skip a media URL outside the allowed hosts without any request to it (AC-070)', async ({ send, server }) => {
    const result = await fingerprint(send, image('https://media2.test/base.png?tc=070'));
    expect(result).toEqual({ status: 'skipped', reason: 'host-not-allowed' });
    expect(server.log.filter((e) => e.host === 'media2.test')).toEqual([]);
  });

  test('should give a 10 MB video a poster-only fingerprint with 0 bytes of the video file sent to the extension (TC-027)', async ({
    send,
    server,
  }) => {
    const result = await fingerprint(send, {
      url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/big.mp4?tag=12',
      contentType: 'video',
      posterUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/base.png?tc=027',
    });
    expect(result).toMatchObject({ status: 'ok', contentType: 'video', fingerprint: { kind: 'poster' } });
    const videoRequests = server.log.filter((e) => e.path.split('?')[0].endsWith('/big.mp4'));
    expect(videoRequests.reduce((sum, e) => sum + e.bytesSent, 0)).toBe(0);
    expect(extensionRequests(server.log).map((e) => e.path)).toEqual(['/ext_tw_video_thumb/1/pu/img/base.png?tc=027']);
  });

  test('should give a poster-only fingerprint if a cross-origin video has no pixel access and has a poster (TC-028)', async ({ send }) => {
    test.setTimeout(VIDEO_TIMEOUT_MS * 2);
    const result = await fingerprint(
      send,
      {
        url: 'https://video.twimg.com/redirect-nocors/clip.mp4?tc=028',
        contentType: 'video',
        posterUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/base.png?tc=028',
      },
      VIDEO_TIMEOUT_MS,
    );
    expect(result).toMatchObject({ status: 'ok', contentType: 'video', fingerprint: { kind: 'poster' } });
    const poster = okFingerprint(await fingerprint(send, image('https://pbs.twimg.com/media/base.png?tc=028-image')));
    expect(
      compareFingerprints(
        okFingerprint(result),
        { kind: 'poster', hash: (poster as Extract<Fingerprint, { kind: 'image' }>).hash },
        DEFAULT_THRESHOLDS,
      ).matchClass,
    ).toBe('exact');
  });

  test('should skip a video without a poster at once and send no request for it (TC-029)', async ({ send, server }) => {
    const result = await fingerprint(send, { url: 'https://video.twimg.com/stall/clip.mp4?tc=029', contentType: 'video', posterUrl: null });
    expect(result).toEqual({ status: 'skipped', reason: 'no-poster' });
    expect(server.log.filter((e) => e.path.startsWith('/stall/'))).toEqual([]);
  });

  test('should still match a stored record if the service worker is stopped and restarted (TC-007)', async ({
    context,
    extensionPage,
    send,
  }) => {
    const fp = okFingerprint(await fingerprint(send, image('https://i.redd.it/base.png?tc=007')));
    const sighting = {
      fingerprint: fp,
      contentType: 'image' as const,
      platform: 'reddit' as const,
      postKey: 'reddit:t3_tc007',
      permalink: 'https://www.reddit.com/r/test/comments/tc007/x/',
    };
    const { recordId } = await send({ type: 'seen/record', sighting: encodeSighting(sighting) });
    await extensionPage.waitForTimeout(2_500);
    await stopServiceWorkers(context, extensionPage);
    const resized = okFingerprint(await fingerprint(send, image('https://i.redd.it/base-50.png?tc=007')));
    const { matches } = await send({ type: 'seen/lookup', fingerprints: [encodeSighting({ ...sighting, fingerprint: resized }).fingerprint] });
    expect(matches[0]).toMatchObject({ recordId, matchClass: 'exact', platform: 'reddit', firstSeenPostKey: 'reddit:t3_tc007' });
  });
});
