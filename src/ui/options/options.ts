import { ext } from '../../compat/browser.ts';
import { sendRequest } from '../../compat/messaging.ts';
import { WHITELIST_KEY } from '../../engine/whitelist-store.ts';
import { parseSourceInput, whitelistEntries } from '../../shared/whitelist.ts';
import { connectSettings } from '../shared/settings-client.ts';
import { type OptionsActions, type OptionsState, renderOptions } from './options-view.ts';

const root = document.getElementById('options');
const settings = connectSettings();
let state: OptionsState | null = null;

function show(patch: Partial<OptionsState>): void {
  if (!state || !root) {
    return;
  }
  state = { ...state, ...patch };
  renderOptions(root, state, actions);
}

const report = (notice: string) => () => show({ notice });
const failed = report('PureFeed could not finish this action. Reload this page and try again.');

const actions: OptionsActions = {
  setSettings(patch) {
    const result = settings.save(patch);
    show(result.ok ? { settings: result.value, rejected: null } : { rejected: { field: result.field, message: result.message, patch } });
  },
  addSource(platform, text) {
    const parsed = parseSourceInput(platform, text);
    show({ whitelistError: parsed.ok ? null : parsed.message });
    if (parsed.ok) {
      sendRequest({ type: 'whitelist/add', entry: parsed.entry }).catch(failed);
    }
    return parsed.ok;
  },
  removeEntry(entry) {
    sendRequest({ type: 'whitelist/remove', entry }).catch(failed);
  },
  clearHistory() {
    if (window.confirm('Delete all seen records? Posts you saw before will no longer be hidden.')) {
      sendRequest({ type: 'history/clear' }).then(report('History cleared.'), failed);
    }
  },
  resetCounters() {
    sendRequest({ type: 'counters/reset' }).then(report('Counters reset.'), failed);
  },
};

settings.onChange((next) => {
  show({ settings: next });
});
ext.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && Object.hasOwn(changes, WHITELIST_KEY)) {
    show({ whitelist: whitelistEntries(changes[WHITELIST_KEY].newValue) });
  }
});
void Promise.all([settings.ready, ext.storage.local.get(WHITELIST_KEY)]).then(([, items]) => {
  state = {
    settings: settings.current(),
    whitelist: whitelistEntries(items[WHITELIST_KEY]),
    rejected: null,
    whitelistError: null,
    notice: null,
  };
  show({});
});
