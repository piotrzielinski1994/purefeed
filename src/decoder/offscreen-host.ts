import { ext } from '../compat/browser.ts';
import type { DecodeResult } from '../shared/types.ts';
import { decodeDecodeResult, type WireDecodeResult } from '../shared/wire.ts';
import type { DecoderHost } from './decoder-host.ts';
import { decodeMessage, framesMessage, type OffscreenMessage } from './offscreen-protocol.ts';

const OFFSCREEN_URL = 'offscreen.html';
const JUSTIFICATION = 'Decode page media and hash pixels in a worker to detect duplicate posts.';

export function createOffscreenHost(): DecoderHost {
  const { offscreen } = ext;
  if (!offscreen) {
    throw new Error('PureFeed: the offscreen API is missing');
  }
  let documentReady: Promise<void> | undefined;
  const ensureDocument = (): Promise<void> => {
    documentReady ??= offscreen
      .hasDocument()
      .then((hasDocument) =>
        hasDocument ? undefined : offscreen.createDocument({ url: OFFSCREEN_URL, reasons: ['WORKERS'], justification: JUSTIFICATION }),
      )
      .catch((error: unknown) => {
        documentReady = undefined;
        throw error;
      });
    return documentReady;
  };
  const send = async (message: OffscreenMessage): Promise<DecodeResult> => {
    await ensureDocument();
    const wire: WireDecodeResult = await ext.runtime.sendMessage(message);
    return decodeDecodeResult(wire);
  };
  return {
    decode: (req) => send(decodeMessage(req)),
    hashFrames: (frames, durationS, posterUrl) => send(framesMessage(frames, durationS, posterUrl)),
  };
}
