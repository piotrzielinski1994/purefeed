import { describe, expect, it } from 'vitest';
import { imageFp, randomHashes } from '../../test/helpers/fingerprints.ts';
import type { DecodeResult, GrayFrame } from '../shared/types.ts';
import { decodeDecodeResult, encodeGrayFrame } from '../shared/wire.ts';
import type { MediaService } from './media-service.ts';
import { createRouter, type RouterDeps } from './router.ts';

const [H1] = randomHashes(1, 31337);
const OK: DecodeResult = { status: 'ok', contentType: 'image', fingerprint: imageFp(H1) };
const SENDER = { tabId: 1, url: 'https://x.com/home' };
const FRAMES: GrayFrame[] = [{ tS: 2.5, image: { width: 2, height: 1, data: Uint8Array.of(1, 250) } }];
const unused = {} as Omit<RouterDeps, 'media'>;

function recordingMedia() {
  const calls: unknown[] = [];
  const media: MediaService = {
    fingerprint: async (req) => {
      calls.push(req);
      return OK;
    },
    frames: async (frames, durationS, posterUrl) => {
      calls.push({ frames, durationS, posterUrl });
      return { status: 'skipped', reason: 'no-poster' };
    },
  };
  return { media, calls };
}

describe('router media requests (AC-008, AC-013)', () => {
  it('should answer media/fingerprint with the wire-encoded result of the media service', async () => {
    const { media, calls } = recordingMedia();
    const router = createRouter({ ...unused, media });
    const req = { url: 'https://i.redd.it/a.png', contentType: 'image' as const, posterUrl: null };
    const wire = await router({ type: 'media/fingerprint', req }, SENDER);
    expect(calls).toEqual([req]);
    expect(decodeDecodeResult(JSON.parse(JSON.stringify(wire)))).toEqual(OK);
  });

  it('should decode wire frames before media/frames reaches the media service', async () => {
    const { media, calls } = recordingMedia();
    const router = createRouter({ ...unused, media });
    const result = await router({ type: 'media/frames', frames: FRAMES.map(encodeGrayFrame), durationS: 20, posterUrl: null }, SENDER);
    expect(calls).toEqual([{ frames: FRAMES, durationS: 20, posterUrl: null }]);
    expect(result).toEqual({ status: 'skipped', reason: 'no-poster' });
  });

  it('should reject media requests if no media service is wired', async () => {
    const router = createRouter(unused);
    await expect(
      router({ type: 'media/fingerprint', req: { url: 'https://i.redd.it/a.png', contentType: 'image', posterUrl: null } }, SENDER),
    ).rejects.toThrow('media/fingerprint is not available');
  });
});
