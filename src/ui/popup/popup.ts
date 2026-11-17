import { ext } from '../../compat/browser.ts';
import { sendRequest } from '../../compat/messaging.ts';
import { HOST_PERMISSIONS } from '../../shared/hosts.ts';
import { connectSettings } from '../shared/settings-client.ts';
import { type PopupActions, type PopupState, renderPopup } from './popup-view.ts';

const root = document.getElementById('popup');
const settings = connectSettings();
const hostAccess = { origins: [...HOST_PERMISSIONS] };
let state: PopupState = { kind: 'loading' };

const actions: PopupActions = {
  setSettings(patch) {
    settings.save(patch);
    if (state.kind === 'ready') {
      show({ ...state, settings: settings.current() });
    }
  },
  grantAccess() {
    void ext.permissions.request(hostAccess).then((isGranted) => (isGranted ? load() : undefined));
  },
  openOptions() {
    void ext.runtime.openOptionsPage();
  },
};

function show(next: PopupState): void {
  state = next;
  if (root) {
    renderPopup(root, state, actions);
  }
}

async function load(): Promise<void> {
  if (!(await ext.permissions.contains(hostAccess))) {
    show({ kind: 'permission' });
    return;
  }
  const [status] = await Promise.all([sendRequest({ type: 'status/get' }), settings.ready]);
  show({ kind: 'ready', settings: settings.current(), counters: status.counters, historyPersisted: status.historyPersisted });
}

settings.onChange((next) => {
  if (state.kind === 'ready') {
    show({ ...state, settings: next });
  }
});
show(state);
void load();
