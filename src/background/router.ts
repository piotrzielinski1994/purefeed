import type { RequestSender } from '../compat/messaging.ts';
import type { Counters } from '../engine/counters.ts';
import type { SeenService } from '../engine/seen-service.ts';
import type { WhitelistStore } from '../engine/whitelist-store.ts';
import type { SeenRepository } from '../repository/seen-repository.ts';
import type { Request, RequestType, ResponseOf } from '../shared/messages.ts';
import { decodeFingerprint, decodeGrayFrame, decodeSighting, encodeDecodeResult } from '../shared/wire.ts';
import type { MediaService } from './media-service.ts';

export type RouterDeps = {
  seen: SeenService;
  counters: Pick<Counters, 'get' | 'addHidden' | 'reset'>;
  whitelist: Pick<WhitelistStore, 'add' | 'remove'>;
  repository: Pick<SeenRepository, 'ready' | 'persisted' | 'clear'>;
  log: (m: string) => void;
  media?: MediaService;
};

export type Router = (req: Request, sender: RequestSender) => Promise<unknown>;

type Handlers = { [K in RequestType]: (req: Extract<Request, { type: K }>, sender: RequestSender) => Promise<ResponseOf<K>> };

const OK = { ok: true } as const;

const notAvailable = (type: RequestType) => (): Promise<never> => Promise.reject(new Error(`PureFeed: ${type} is not available`));

export function createRouter({ seen, counters, whitelist, repository, log, media }: RouterDeps): Router {
  const handlers: Handlers = {
    'media/fingerprint': media ? async (req) => encodeDecodeResult(await media.fingerprint(req.req)) : notAvailable('media/fingerprint'),
    'media/frames': media
      ? async (req) => encodeDecodeResult(await media.frames(req.frames.map(decodeGrayFrame), req.durationS, req.posterUrl))
      : notAvailable('media/frames'),
    'seen/lookup': async (req) => ({ matches: await seen.lookup(req.fingerprints.map(decodeFingerprint)) }),
    'seen/record': (req) => seen.record(decodeSighting(req.sighting)),
    'stats/hidden': async () => {
      counters.addHidden();
      return OK;
    },
    'whitelist/add': async (req) => {
      await whitelist.add(req.entry);
      return OK;
    },
    'whitelist/remove': async (req) => {
      await whitelist.remove(req.entry);
      return OK;
    },
    'history/clear': async () => {
      await repository.clear();
      return OK;
    },
    'counters/reset': async () => {
      await counters.reset();
      return OK;
    },
    'log/warn': async (req) => {
      log(req.message);
      return OK;
    },
    'status/get': async () => {
      await repository.ready;
      return { historyPersisted: repository.persisted(), counters: counters.get() };
    },
  };
  return (req, sender) => (handlers[req.type] as (req: Request, sender: RequestSender) => Promise<unknown>)(req, sender);
}
