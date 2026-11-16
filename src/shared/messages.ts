import type { CounterValues, DecodeRequest, RecordId, SeenMatch, WhitelistEntry } from './types.ts';
import type { WireDecodeResult, WireFingerprint, WireGrayFrame, WireSighting } from './wire.ts';

type Ok = { ok: true };
type NoPayload = Record<never, never>;

type Contract = {
  'media/fingerprint': { payload: { req: DecodeRequest }; response: WireDecodeResult };
  'media/frames': { payload: { frames: WireGrayFrame[]; durationS: number; posterUrl: string | null }; response: WireDecodeResult };
  'seen/lookup': { payload: { fingerprints: WireFingerprint[] }; response: { matches: Array<SeenMatch | null> } };
  'seen/record': { payload: { sighting: WireSighting }; response: { recordId: RecordId; isNew: boolean } };
  'stats/hidden': { payload: NoPayload; response: Ok };
  'whitelist/add': { payload: { entry: WhitelistEntry }; response: Ok };
  'whitelist/remove': { payload: { entry: WhitelistEntry }; response: Ok };
  'history/clear': { payload: NoPayload; response: Ok };
  'counters/reset': { payload: NoPayload; response: Ok };
  'log/warn': { payload: { message: string }; response: Ok };
  'status/get': { payload: NoPayload; response: { historyPersisted: boolean; counters: CounterValues } };
};

export type RequestType = keyof Contract;
export type Request = { [K in RequestType]: { type: K } & Contract[K]['payload'] }[RequestType];
export type ResponseOf<K extends RequestType> = Contract[K]['response'];

const REQUEST_TYPES: Record<RequestType, true> = {
  'media/fingerprint': true,
  'media/frames': true,
  'seen/lookup': true,
  'seen/record': true,
  'stats/hidden': true,
  'whitelist/add': true,
  'whitelist/remove': true,
  'history/clear': true,
  'counters/reset': true,
  'log/warn': true,
  'status/get': true,
};

export const isRequest = (message: unknown): message is Request =>
  typeof message === 'object' &&
  message !== null &&
  'type' in message &&
  typeof message.type === 'string' &&
  Object.hasOwn(REQUEST_TYPES, message.type);
