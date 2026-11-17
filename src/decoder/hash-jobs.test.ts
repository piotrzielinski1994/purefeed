import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assetPath, loadGray } from '../../test/helpers/assets.ts';
import type { GrayFrame } from '../shared/types.ts';
import { runJob, type ToGray } from './hash-jobs.ts';

const bytesOf = (name: string): ArrayBuffer => new Uint8Array(readFileSync(assetPath(name))).buffer;
const grayOf =
  (name: string): ToGray =>
  async () =>
    loadGray(name);
const FLAT: ToGray = async () => ({ width: 8, height: 8, data: new Uint8Array(64).fill(128) });
const BROKEN: ToGray = () => Promise.reject(new Error('decode error'));

describe('hash worker jobs (AC-008, AC-014)', () => {
  it('should give an image fingerprint from the decoded pixels if the bytes are not a GIF', async () => {
    const result = await runJob({ op: 'image', bytes: bytesOf('base.png'), mime: 'image/png' }, grayOf('base.png'));
    expect(result).toMatchObject({ status: 'ok', contentType: 'image', fingerprint: { kind: 'image' } });
  });

  it('should give content type gif and 3 frames if the bytes hold an animated GIF', async () => {
    const result = await runJob({ op: 'image', bytes: bytesOf('loop.gif'), mime: 'image/gif' }, BROKEN);
    expect(result).toMatchObject({ status: 'ok', contentType: 'gif', fingerprint: { kind: 'sequence' } });
    expect(result.status === 'ok' && result.fingerprint.kind === 'sequence' && result.fingerprint.timestamps).toHaveLength(3);
  });

  it('should keep content type image if a GIF has 1 frame', async () => {
    const result = await runJob({ op: 'image', bytes: bytesOf('base-static.gif'), mime: 'image/gif' }, BROKEN);
    expect(result).toMatchObject({ status: 'ok', contentType: 'image', fingerprint: { kind: 'image' } });
  });

  it('should skip with flat if the image has no detail', async () => {
    expect(await runJob({ op: 'image', bytes: new ArrayBuffer(8), mime: 'image/png' }, FLAT)).toEqual({ status: 'skipped', reason: 'flat' });
  });

  it('should skip with unreadable if the browser cannot decode the bytes or the GIF is broken', async () => {
    const brokenGif = Uint8Array.from('GIF89a', (c) => c.charCodeAt(0)).buffer;
    expect(await runJob({ op: 'image', bytes: new ArrayBuffer(0), mime: 'image/png' }, BROKEN)).toEqual({
      status: 'skipped',
      reason: 'unreadable',
    });
    expect(await runJob({ op: 'image', bytes: brokenGif, mime: 'image/gif' }, BROKEN)).toEqual({ status: 'skipped', reason: 'unreadable' });
  });

  it('should hash sampled frames into a video frame sequence if a frames job arrives', async () => {
    const frames: GrayFrame[] = [1.25, 3.75].map((tS) => ({ tS, image: loadGray(tS === 1.25 ? 'base.png' : 'other-1.png') }));
    const result = await runJob({ op: 'frames', frames, durationS: 20 }, BROKEN);
    expect(result).toMatchObject({ status: 'ok', contentType: 'video', fingerprint: { kind: 'sequence', durationS: 20 } });
    expect(result.status === 'ok' && result.fingerprint.kind === 'sequence' && Array.from(result.fingerprint.timestamps)).toEqual([1.25, 3.75]);
  });
});
