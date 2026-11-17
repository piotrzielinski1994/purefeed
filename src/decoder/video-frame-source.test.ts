// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeMedia, installFakeMedia, videoFromAsset } from '../../test/helpers/fake-media.ts';
import { resizeArea } from '../fingerprint/gray.ts';
import { pHash64 } from '../fingerprint/phash.ts';
import { hamming64 } from '../similarity/hamming.ts';

const loadSource = () => import('./video-frame-source.ts');

const VIDEO_URL = 'https://video.twimg.com/ext_tw_video/1/pu/vid/640x360/clip.mp4';

let media: FakeMedia;

beforeEach(() => {
  media = installFakeMedia();
});

afterEach(() => {
  media.restore();
});

describe('element frame source (AC-015, AC-020, AC-021, AC-022)', () => {
  it('should report the video duration and return the gray frame at the requested time', async () => {
    const { createElementFrameSource } = await loadSource();
    const spec = videoFromAsset('clip.mp4');
    if (spec.mode !== 'ok') throw new Error('asset spec');
    media.addVideo(VIDEO_URL, spec);
    const src = await createElementFrameSource(document, VIDEO_URL, { timeoutMs: 10_000 });
    expect(src.durationS).toBe(20);
    for (const tS of [1.25, 8.75, 18.75]) {
      const frame = await src.frameAt(tS);
      if (!frame) throw new Error(`no frame at ${tS}`);
      expect(frame.data).toHaveLength(frame.width * frame.height);
      const expected = resizeArea(spec.frame(tS), frame.width, frame.height);
      expect(hamming64(pHash64(frame), 0, pHash64(expected), 0)).toBeLessThanOrEqual(3);
    }
    src.dispose();
  });

  it('should use its own muted video with preload metadata and anonymous CORS mode', async () => {
    const { createElementFrameSource } = await loadSource();
    media.addVideo(VIDEO_URL, videoFromAsset('clip.mp4'));
    const src = await createElementFrameSource(document, VIDEO_URL, { timeoutMs: 10_000 });
    expect(media.videos).toHaveLength(1);
    const { element } = media.videos[0];
    expect(element.muted).toBe(true);
    expect(element.preload).toBe('metadata');
    expect(element.crossOrigin).toBe('anonymous');
    expect(element.paused).toBe(true);
    src.dispose();
  });

  it('should remove the video source and call load() if disposed', async () => {
    const { createElementFrameSource } = await loadSource();
    media.addVideo(VIDEO_URL, videoFromAsset('clip.mp4'));
    const src = await createElementFrameSource(document, VIDEO_URL, { timeoutMs: 10_000 });
    await src.frameAt(2.5);
    const [video] = media.videos;
    expect(video.disposed).toBe(false);
    src.dispose();
    expect(video.element.getAttribute('src') ?? '').toBe('');
    expect(video.disposed).toBe(true);
  });

  it('should reject and release the video if metadata does not load within the timeout', async () => {
    const { createElementFrameSource } = await loadSource();
    media.addVideo(VIDEO_URL, { mode: 'never-loads' });
    await expect(createElementFrameSource(document, VIDEO_URL, { timeoutMs: 50 })).rejects.toThrow();
    expect(media.videos).toHaveLength(1);
    expect(media.videos[0].element.getAttribute('src') ?? '').toBe('');
  });

  it('should reject if the video fails to decode', async () => {
    const { createElementFrameSource } = await loadSource();
    media.addVideo(VIDEO_URL, { mode: 'error' });
    await expect(createElementFrameSource(document, VIDEO_URL, { timeoutMs: 10_000 })).rejects.toThrow();
  });
});
