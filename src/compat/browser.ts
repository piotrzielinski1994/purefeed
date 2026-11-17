declare const __TARGET__: 'chrome' | 'firefox';

type Api = typeof chrome;
export type Ext = {
  runtime: Pick<Api['runtime'], 'sendMessage' | 'onMessage' | 'getURL' | 'openOptionsPage' | 'id'>;
  storage: { local: Pick<Api['storage']['local'], 'get' | 'set'>; onChanged: Api['storage']['onChanged'] };
  permissions: Pick<Api['permissions'], 'contains' | 'request'>;
  alarms: Pick<Api['alarms'], 'create' | 'onAlarm'>;
  offscreen: Api['offscreen'] | undefined;
};

export const TARGET: 'chrome' | 'firefox' = __TARGET__;

const host = globalThis as typeof globalThis & { browser?: Api; chrome?: Api };
const api = host.browser ?? host.chrome;

export const ext: Ext = {
  get runtime() {
    return api.runtime;
  },
  get storage() {
    return { local: api.storage.local, onChanged: api.storage.onChanged };
  },
  get permissions() {
    return api.permissions;
  },
  get alarms() {
    return api.alarms;
  },
  get offscreen() {
    return TARGET === 'chrome' ? api.offscreen : undefined;
  },
};
