// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createMediaFakes } from '../../test/helpers/fake-media.ts';
import { imageFp, randomHashes, sequenceFp } from '../../test/helpers/fingerprints.ts';
import type { DecodeRequest, DecodeResult, GrayFrame } from '../shared/types.ts';

const loadService = () => import('./media-service.ts');
const loadDecoder = () => import('../decoder/media-decoder.ts');

const [H1, H2] = randomHashes(2, 9090);
const IMAGE_URL = 'https://i.redd.it/abc123.png?width=640&s=f00d';

const imageReq = (url: string, overrides: Partial<DecodeRequest> = {}): DecodeRequest => ({
  url,
  contentType: 'image',
  posterUrl: null,
  ...overrides,
});

function countingHost() {
  const decoded: DecodeRequest[] = [];
  const hashed: Array<{ frames: GrayFrame[]; durationS: number; posterUrl: string | null }> = [];
  const resultFor = (url: string): DecodeResult => ({ status: 'ok', contentType: 'image', fingerprint: imageFp(url.length % 2 ? H1 : H2) });
  return {
    decoded,
    hashed,
    host: {
      decode: async (req: DecodeRequest): Promise<DecodeResult> => {
        decoded.push(req);
        return resultFor(req.url);
      },
      hashFrames: async (frames: GrayFrame[], durationS: number, posterUrl: string | null): Promise<DecodeResult> => {
        hashed.push({ frames, durationS, posterUrl });
        return { status: 'ok', contentType: 'video', fingerprint: sequenceFp([H1, H2], durationS) };
      },
    },
  };
}

describe('media service URL cache (AC-013)', () => {
  it('should fetch a media URL once and give every caller the same result if 3 posts request it at the same time (TC-017)', async () => {
    const [{ createMediaService }, { createMediaDecoder }] = await Promise.all([loadService(), loadDecoder()]);
    const fakes = createMediaFakes({ [IMAGE_URL]: { asset: 'base.png', mime: 'image/png' } });
    const decoder = createMediaDecoder({
      doc: document,
      fetch: fakes.fetch,
      worker: fakes.worker,
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
    });
    const service = createMediaService(decoder);
    const results = await Promise.all([1, 2, 3].map(() => service.fingerprint(imageReq(IMAGE_URL))));
    expect(fakes.calls.map((c) => c.url)).toEqual([IMAGE_URL]);
    expect(fakes.workerCalls.hashImage).toBe(1);
    expect(results[0]).toMatchObject({ status: 'ok', contentType: 'image', fingerprint: { kind: 'image' } });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('should answer a later request for the same URL from the cache without a new decode', async () => {
    const { createMediaService } = await loadService();
    const fake = countingHost();
    const service = createMediaService(fake.host);
    const first = await service.fingerprint(imageReq(IMAGE_URL));
    const second = await service.fingerprint(imageReq(IMAGE_URL));
    expect(fake.decoded).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('should keep separate entries if content type or poster URL differ for the same URL', async () => {
    const { createMediaService } = await loadService();
    const fake = countingHost();
    const service = createMediaService(fake.host);
    const url = 'https://video.twimg.com/ext_tw_video/1/pu/vid/640x360/a.mp4';
    await service.fingerprint({ url, contentType: 'video', posterUrl: null });
    await service.fingerprint({ url, contentType: 'gif', posterUrl: null });
    await service.fingerprint({ url, contentType: 'video', posterUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg' });
    await service.fingerprint({ url, contentType: 'video', posterUrl: null });
    expect(fake.decoded.map((r) => [r.contentType, r.posterUrl])).toEqual([
      ['video', null],
      ['gif', null],
      ['video', 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg'],
    ]);
  });

  it('should evict the least recently used URL if the cache is full', async () => {
    const { createMediaService } = await loadService();
    const fake = countingHost();
    const service = createMediaService(fake.host, 2);
    const [a, b, c] = ['https://i.redd.it/a.png', 'https://i.redd.it/b.png', 'https://i.redd.it/c.png'];
    for (const url of [a, b, a, c, a, b]) {
      await service.fingerprint(imageReq(url));
    }
    expect(fake.decoded.map((r) => r.url)).toEqual([a, b, c, b]);
  });

  it('should hold 500 URLs by default', async () => {
    const { createMediaService } = await loadService();
    const fake = countingHost();
    const service = createMediaService(fake.host);
    const urls = Array.from({ length: 501 }, (_, i) => `https://pbs.twimg.com/media/${i}.jpg`);
    for (const url of urls) {
      await service.fingerprint(imageReq(url));
    }
    await service.fingerprint(imageReq(urls[500]));
    await service.fingerprint(imageReq(urls[1]));
    expect(fake.decoded).toHaveLength(501);
    await service.fingerprint(imageReq(urls[0]));
    expect(fake.decoded).toHaveLength(502);
  });

  it('should pass sampled page video frames to the decoder host and return its result', async () => {
    const { createMediaService } = await loadService();
    const fake = countingHost();
    const service = createMediaService(fake.host);
    const frames: GrayFrame[] = [{ tS: 1.25, image: { width: 2, height: 1, data: Uint8Array.of(10, 200) } }];
    const result = await service.frames(frames, 20, 'https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg');
    expect(fake.hashed).toEqual([{ frames, durationS: 20, posterUrl: 'https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg' }]);
    expect(result).toEqual({ status: 'ok', contentType: 'video', fingerprint: sequenceFp([H1, H2], 20) });
  });
});
