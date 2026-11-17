import type { DecoderHost } from '../decoder/decoder-host.ts';
import type { DecodeRequest, DecodeResult } from '../shared/types.ts';

export type MediaService = {
  fingerprint(req: DecodeRequest): Promise<DecodeResult>;
  frames: DecoderHost['hashFrames'];
};

const DEFAULT_CACHE_SIZE = 500;

const keyOf = ({ contentType, url, posterUrl }: DecodeRequest): string => `${contentType}|${url}|${posterUrl ?? ''}`;

export function createMediaService(host: DecoderHost, cacheSize = DEFAULT_CACHE_SIZE): MediaService {
  const results = new Map<string, Promise<DecodeResult>>();
  const decode = (key: string, req: DecodeRequest): Promise<DecodeResult> =>
    host.decode(req).catch((error: unknown) => {
      results.delete(key);
      throw error;
    });
  return {
    fingerprint: (req) => {
      const key = keyOf(req);
      const result = results.get(key) ?? decode(key, req);
      results.delete(key);
      results.set(key, result);
      const oldest = results.keys().next();
      if (results.size > cacheSize && !oldest.done) {
        results.delete(oldest.value);
      }
      return result;
    },
    frames: (frames, durationS, posterUrl) => host.hashFrames(frames, durationS, posterUrl),
  };
}
