import { describe, expect, it } from 'vitest';
import { imageFp, randomHashes } from '../../test/helpers/fingerprints.ts';
import type { DecodeResult } from '../shared/types.ts';
import { createWorkerClient, type WorkerPort, type WorkerRequest, type WorkerResponse } from './worker-client.ts';

const [H1, H2] = randomHashes(2, 4242);

function fakePort() {
  const posted: Array<{ message: WorkerRequest; transfer: Transferable[] }> = [];
  const listeners: Array<(event: MessageEvent<WorkerResponse>) => void> = [];
  const port: WorkerPort = {
    postMessage: (message, transfer) => void posted.push({ message, transfer }),
    addEventListener: (_type, listener) => void listeners.push(listener),
  };
  const reply = (id: number, result: DecodeResult) =>
    listeners.forEach((l) => {
      l(new MessageEvent('message', { data: { id, result } }));
    });
  return { port, posted, reply };
}

describe('worker client (AC-075)', () => {
  it('should resolve each job with the response of its own id if responses arrive out of order', async () => {
    const { port, posted, reply } = fakePort();
    const client = createWorkerClient(port);
    const first = client.hashImage(new ArrayBuffer(4), 'image/png');
    const second = client.hashFrames([], 20);
    const [a, b] = posted.map((p) => p.message.id);
    const okA: DecodeResult = { status: 'ok', contentType: 'image', fingerprint: imageFp(H1) };
    const okB: DecodeResult = { status: 'ok', contentType: 'video', fingerprint: imageFp(H2) };
    reply(b, okB);
    reply(a, okA);
    expect(await first).toEqual(okA);
    expect(await second).toEqual(okB);
    expect(new Set([a, b]).size).toBe(2);
  });

  it('should transfer the image bytes and send frames with their duration', () => {
    const { port, posted } = fakePort();
    const client = createWorkerClient(port);
    const bytes = new ArrayBuffer(4);
    const frames = [{ tS: 1, image: { width: 1, height: 1, data: Uint8Array.of(7) } }];
    client.hashImage(bytes, 'image/webp');
    client.hashFrames(frames, 8);
    expect(posted[0]).toMatchObject({ message: { job: { op: 'image', bytes, mime: 'image/webp' } }, transfer: [bytes] });
    expect(posted[1]).toMatchObject({ message: { job: { op: 'frames', frames, durationS: 8 } }, transfer: [] });
  });
});
