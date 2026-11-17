import { fingerprintFrameSource } from '../fingerprint/frame-sequence.ts';
import { isMediaUrlAllowed } from '../shared/hosts.ts';
import type { ContentType, DecodeRequest, DecodeResult, FrameSequenceFingerprint, SetTimer, SkipReason } from '../shared/types.ts';
import type { DecoderHost } from './decoder-host.ts';
import { createElementFrameSource } from './video-frame-source.ts';
import type { WorkerClient } from './worker-client.ts';

export type MediaDecoderDeps = { doc: Document; fetch: typeof fetch; worker: WorkerClient; now: () => number; setTimer: SetTimer };

const FRAME_DEADLINE_MS = 10_000;

const skipped = (reason: SkipReason): DecodeResult => ({ status: 'skipped', reason });

export function createMediaDecoder({ doc, fetch, worker, now, setTimer }: MediaDecoderDeps): DecoderHost {
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

  const readSequence = async (url: string): Promise<FrameSequenceFingerprint | null> => {
    const start = now();
    const source = await createElementFrameSource(doc, url, { timeoutMs: FRAME_DEADLINE_MS, setTimer }).catch(() => null);
    if (!source) {
      return null;
    }
    return fingerprintFrameSource(source, { deadlineMs: FRAME_DEADLINE_MS - (now() - start), now })
      .catch(() => null)
      .finally(() => source.dispose());
  };

  const decodeVideo = async ({ url, contentType, posterUrl }: DecodeRequest): Promise<DecodeResult> => {
    if (!isMediaUrlAllowed(url)) {
      return skipped('host-not-allowed');
    }
    const fingerprint = await readSequence(url);
    return fingerprint ? { status: 'ok', contentType, fingerprint } : posterResult(posterUrl, contentType);
  };

  return {
    decode: (req) => (req.contentType === 'image' ? hashUrl(req.url) : decodeVideo(req)),
    hashFrames: (frames, durationS, posterUrl) =>
      frames.length === 0 ? posterResult(posterUrl, 'video') : worker.hashFrames(frames, durationS),
  };
}
