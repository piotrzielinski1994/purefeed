import { describe, expect, it } from 'vitest';
import { imageFp, randomHashes } from '../../test/helpers/fingerprints.ts';
import type { DecodeRequest, DecodeResult, GrayFrame } from '../shared/types.ts';
import { decodeDecodeResult } from '../shared/wire.ts';
import type { DecoderHost } from './decoder-host.ts';
import { decodeMessage, framesMessage, handleOffscreenMessage, isOffscreenMessage } from './offscreen-protocol.ts';

const [H1] = randomHashes(1, 777);
const OK: DecodeResult = { status: 'ok', contentType: 'image', fingerprint: imageFp(H1) };
const REQ: DecodeRequest = { url: 'https://i.redd.it/a.png', contentType: 'image', posterUrl: null };
const FRAMES: GrayFrame[] = [{ tS: 1.25, image: { width: 2, height: 1, data: Uint8Array.of(10, 200) } }];

function recordingHost(fail = false) {
  const calls: unknown[] = [];
  const host: DecoderHost = {
    decode: async (req) => {
      calls.push({ decode: req });
      return fail ? Promise.reject(new Error('boom')) : OK;
    },
    hashFrames: async (frames, durationS, posterUrl) => {
      calls.push({ frames, durationS, posterUrl });
      return OK;
    },
  };
  return { host, calls };
}

const overJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('offscreen protocol (AC-005)', () => {
  it('should accept only messages that target the offscreen document', () => {
    expect(isOffscreenMessage(decodeMessage(REQ))).toBe(true);
    expect(isOffscreenMessage(framesMessage(FRAMES, 20, null))).toBe(true);
    expect(isOffscreenMessage({ type: 'media/fingerprint', req: REQ })).toBe(false);
    expect(isOffscreenMessage({ target: 'offscreen', op: 'other' })).toBe(false);
    expect(isOffscreenMessage({ target: 'background', op: 'decode' })).toBe(false);
    expect(isOffscreenMessage(null)).toBe(false);
    expect(isOffscreenMessage('decode')).toBe(false);
  });

  it('should pass a decode request to the host and answer with a JSON-safe result', async () => {
    const { host, calls } = recordingHost();
    const wire = overJson(await handleOffscreenMessage(host, overJson(decodeMessage(REQ))));
    expect(calls).toEqual([{ decode: REQ }]);
    expect(decodeDecodeResult(wire)).toEqual(OK);
  });

  it('should restore the frames and poster URL if a frames message crosses JSON messaging', async () => {
    const { host, calls } = recordingHost();
    await handleOffscreenMessage(host, overJson(framesMessage(FRAMES, 20, 'https://pbs.twimg.com/p.jpg')));
    expect(calls).toEqual([{ frames: FRAMES, durationS: 20, posterUrl: 'https://pbs.twimg.com/p.jpg' }]);
  });

  it('should answer skipped unreadable if the host fails', async () => {
    const { host } = recordingHost(true);
    expect(await handleOffscreenMessage(host, decodeMessage(REQ))).toEqual({ status: 'skipped', reason: 'unreadable' });
  });
});
