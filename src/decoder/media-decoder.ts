import { isMediaUrlAllowed } from '../shared/hosts.ts';
import type { ContentType, DecodeRequest, DecodeResult, SetTimer, SkipReason } from '../shared/types.ts';
import type { DecoderHost } from './decoder-host.ts';
import type { WorkerClient } from './worker-client.ts';

export type MediaDecoderDeps = { doc: Document; fetch: typeof fetch; worker: WorkerClient; now: () => number; setTimer: SetTimer };

const skipped = (reason: SkipReason): DecodeResult => ({ status: 'skipped', reason });

export function createMediaDecoder({ fetch, worker }: MediaDecoderDeps): DecoderHost {
  const hashUrl = async (url: string): Promise<DecodeResult> => {
    if (!isMediaUrlAllowed(url)) {
      return skipped('host-not-allowed');
    }
    const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' }).catch(() => null);
    if (!response?.ok) {
      return skipped('fetch-failed');
    }
    return worker.hashImage(await response.arrayBuffer(), response.headers.get('content-type') ?? '');
  };

  const posterResult = async (posterUrl: string | null, contentType: ContentType): Promise<DecodeResult> => {
    if (posterUrl === null) {
      return skipped('no-poster');
    }
    const result = await hashUrl(posterUrl);
    if (result.status === 'skipped') {
      return result;
    }
    return result.fingerprint.kind === 'image'
      ? { status: 'ok', contentType, fingerprint: { kind: 'poster', hash: result.fingerprint.hash } }
      : skipped('unreadable');
  };

  const decodeVideo = async ({ url, contentType, posterUrl }: DecodeRequest): Promise<DecodeResult> =>
    isMediaUrlAllowed(url) ? posterResult(posterUrl, contentType) : skipped('host-not-allowed');

  return {
    decode: (req) => (req.contentType === 'image' ? hashUrl(req.url) : decodeVideo(req)),
    hashFrames: (frames, durationS, posterUrl) =>
      frames.length === 0 ? posterResult(posterUrl, 'video') : worker.hashFrames(frames, durationS),
  };
}
