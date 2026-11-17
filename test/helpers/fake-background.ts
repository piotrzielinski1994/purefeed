import type { sendRequest } from '../../src/compat/messaging.ts';
import type { Request } from '../../src/shared/messages.ts';
import type { ContentType, DecodeResult, Fingerprint, Platform, SeenMatch } from '../../src/shared/types.ts';
import { decodeFingerprint, encodeDecodeResult } from '../../src/shared/wire.ts';
import { compareFingerprints } from '../../src/similarity/compare.ts';
import { DEFAULT_THRESHOLDS } from './fingerprints.ts';

export type SeedRecord = {
  fingerprint: Fingerprint;
  contentType: ContentType;
  platform: Platform;
  postKey: string;
  permalink: string;
  firstSeenAt: number;
};

export type BackgroundRow = SeedRecord & { recordId: string; count: number; lastSeenAt: number };

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export const okImage = (fingerprint: Fingerprint): DecodeResult => ({ status: 'ok', contentType: 'image', fingerprint });

export type FakeBackground = ReturnType<typeof createFakeBackground>;

export function createFakeBackground(opts: { media: Record<string, DecodeResult>; seed?: SeedRecord[]; now: () => number }) {
  const requests: Request[] = [];
  const rows: BackgroundRow[] = (opts.seed ?? []).map((r, i) => ({ ...r, recordId: `seed-${i}`, count: 1, lastSeenAt: r.firstSeenAt }));

  const bestMatch = (fp: Fingerprint): SeenMatch | null => {
    let best: SeenMatch | null = null;
    for (const row of rows) {
      const { matchClass } = compareFingerprints(fp, row.fingerprint, DEFAULT_THRESHOLDS);
      if (matchClass === 'different' || (best && (best.matchClass === 'exact' || matchClass === 'near'))) continue;
      best = {
        recordId: row.recordId,
        matchClass,
        platform: row.platform,
        firstSeenPostKey: row.postKey,
        firstSeenPermalink: row.permalink,
        firstSeenAt: row.firstSeenAt,
      };
    }
    return best;
  };

  const handle = async (req: Request): Promise<unknown> => {
    switch (req.type) {
      case 'media/fingerprint':
        return encodeDecodeResult(opts.media[req.req.url] ?? { status: 'skipped', reason: 'fetch-failed' });
      case 'media/frames':
        return encodeDecodeResult({ status: 'skipped', reason: 'no-poster' });
      case 'seen/lookup':
        return { matches: req.fingerprints.map((w) => bestMatch(decodeFingerprint(w))) };
      case 'seen/record': {
        const fp = decodeFingerprint(req.sighting.fingerprint);
        const match = bestMatch(fp);
        const row = match ? rows.find((r) => r.recordId === match.recordId) : undefined;
        if (row) {
          row.count++;
          row.lastSeenAt = opts.now();
          return { recordId: row.recordId, isNew: false };
        }
        const { contentType, platform, postKey, permalink } = req.sighting;
        const recordId = `rec-${rows.length}`;
        rows.push({
          fingerprint: fp,
          contentType,
          platform,
          postKey,
          permalink,
          firstSeenAt: opts.now(),
          recordId,
          count: 1,
          lastSeenAt: opts.now(),
        });
        return { recordId, isNew: true };
      }
      case 'stats/hidden':
      case 'whitelist/add':
      case 'whitelist/remove':
      case 'log/warn':
        return { ok: true };
      case 'status/get':
        return { historyPersisted: true, counters: { duplicatesHidden: 0, uniqueItems: rows.length } };
      default:
        throw new Error(`unexpected request ${req.type}`);
    }
  };

  const send = (async (req: Request) => {
    requests.push(json(req));
    return json(await handle(json(req)));
  }) as unknown as typeof sendRequest;

  const of = <K extends Request['type']>(type: K) => requests.filter((r): r is Extract<Request, { type: K }> => r.type === type);
  const fingerprintUrls = () => of('media/fingerprint').map((r) => r.req.url);
  return { send, requests, rows, of, fingerprintUrls };
}
