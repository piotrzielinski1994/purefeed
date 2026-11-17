import { PLATFORM_LABEL } from '../../content/ui/indicator.ts';
import type { CounterValues, Platform, Settings } from '../../shared/types.ts';
import { checkbox, h, replaceKeepingFocus, retentionSelect } from '../shared/dom.ts';
import { formatCount, thresholdLabel } from '../shared/format.ts';

export type PopupState =
  | { kind: 'loading' }
  | { kind: 'permission' }
  | { kind: 'ready'; settings: Settings; counters: CounterValues; historyPersisted: boolean };

export type PopupActions = {
  setSettings(patch: Partial<Settings>): void;
  grantAccess(): void;
  openOptions(): void;
};

const PLATFORMS: readonly Platform[] = ['reddit', 'wykop', 'x'];

const row = (term: Node | string, value: Node | string): HTMLElement => h('div', { className: 'row' }, h('dt', {}, term), h('dd', {}, value));

function header(settings: Settings | null, actions: PopupActions): HTMLElement {
  return h(
    'header',
    { className: 'header row' },
    h('h1', {}, 'PureFeed'),
    checkbox({
      id: 'pf-enabled',
      isSwitch: true,
      checked: settings?.enabled ?? false,
      disabled: settings === null,
      attrs: { 'aria-label': 'Deduplication' },
      onToggle: (enabled) => actions.setSettings({ enabled }),
    }),
  );
}

function stats({ settings, counters, historyPersisted }: Extract<PopupState, { kind: 'ready' }>, actions: PopupActions): HTMLElement {
  const isEmpty = counters.duplicatesHidden === 0 && counters.uniqueItems === 0;
  return h(
    'section',
    { className: 'body', attrs: { 'aria-label': 'Statistics' } },
    !settings.enabled && h('p', { className: 'notice' }, 'Deduplication is off. No post is hidden.'),
    !historyPersisted &&
      h(
        'div',
        { className: 'notice warning' },
        h('p', {}, 'History not saved: local storage failed.'),
        h('p', {}, 'Detection works for this session only.'),
      ),
    h(
      'dl',
      {},
      row('Duplicates hidden', formatCount(counters.duplicatesHidden)),
      row('Unique items processed', formatCount(counters.uniqueItems)),
      settings.enabled && row('Threshold', thresholdLabel(settings)),
      settings.enabled &&
        row(
          h('label', { htmlFor: 'pf-retention' }, 'Retention'),
          retentionSelect('pf-retention', settings.retentionDays, (retentionDays) => actions.setSettings({ retentionDays })),
        ),
    ),
    settings.enabled && isEmpty && h('p', { className: 'hint' }, 'No items yet. Open Reddit, Wykop or X.'),
  );
}

function body(state: PopupState, actions: PopupActions): HTMLElement {
  if (state.kind === 'loading') {
    return h('section', { className: 'body' }, h('p', { className: 'hint' }, 'Loading statistics...'));
  }
  if (state.kind === 'permission') {
    return h(
      'section',
      { className: 'body' },
      h('p', {}, 'PureFeed needs access to Reddit, Wykop and X to detect duplicates.'),
      h('button', { type: 'button', id: 'pf-grant', className: 'primary', onclick: () => actions.grantAccess() }, 'Grant access'),
    );
  }
  return stats(state, actions);
}

function platformList(settings: Settings | null, actions: PopupActions): HTMLElement {
  return h(
    'ul',
    { className: 'platforms', attrs: { 'aria-label': 'Platforms' } },
    ...PLATFORMS.map((platform) =>
      h(
        'li',
        {},
        h(
          'label',
          { className: 'row' },
          h('span', {}, PLATFORM_LABEL[platform]),
          checkbox({
            id: `pf-${platform}`,
            isSwitch: true,
            checked: settings?.platforms[platform] ?? false,
            disabled: !settings?.enabled,
            onToggle: (isOn) => {
              if (settings) {
                actions.setSettings({ platforms: { ...settings.platforms, [platform]: isOn } });
              }
            },
          }),
        ),
      ),
    ),
  );
}

export function renderPopup(root: HTMLElement, state: PopupState, actions: PopupActions): void {
  const settings = state.kind === 'ready' ? state.settings : null;
  replaceKeepingFocus(
    root,
    header(settings, actions),
    body(state, actions),
    ...(state.kind === 'permission' ? [] : [platformList(settings, actions)]),
    h(
      'footer',
      { className: 'footer' },
      h('button', { type: 'button', id: 'pf-open-settings', className: 'link', onclick: () => actions.openOptions() }, 'Open settings'),
    ),
  );
}
