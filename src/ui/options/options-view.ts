import { PLATFORM_LABEL } from '../../content/ui/indicator.ts';
import type { ContentType, Platform, Settings, WhitelistEntry } from '../../shared/types.ts';
import { checkbox, h, retentionSelect } from '../shared/dom.ts';
import { retentionValue } from '../shared/format.ts';

export type OptionsState = {
  settings: Settings;
  whitelist: WhitelistEntry[];
  rejected: { field: keyof Settings; message: string; patch: Partial<Settings> } | null;
  whitelistError: string | null;
  notice: string | null;
};

export type OptionsActions = {
  setSettings(patch: Partial<Settings>): void;
  addSource(platform: Platform, text: string): boolean;
  removeEntry(entry: WhitelistEntry): void;
  clearHistory(): void;
  resetCounters(): void;
};

const THRESHOLDS = ['exactThreshold', 'nearThreshold'] as const;
type Threshold = (typeof THRESHOLDS)[number];
type ThresholdField = { row: HTMLElement; input: HTMLInputElement; output: HTMLOutputElement; error: HTMLElement };

const PLATFORMS: readonly Platform[] = ['reddit', 'wykop', 'x'];
const CONTENT_TYPES: ReadonlyArray<[ContentType, string]> = [
  ['image', 'Images'],
  ['gif', 'GIFs'],
  ['video', 'Videos'],
];
const MODES: ReadonlyArray<[Settings['mode'], string]> = [
  ['exact', 'Exact only'],
  ['exact-near', 'Exact and similar'],
];
const ENTRY_TYPE: Record<WhitelistEntry['type'], string> = { post: 'Post', source: 'Source' };
const SOURCE_PLACEHOLDER: Record<Platform, string> = { reddit: 'r/name or u/name', wykop: '@name', x: '@name' };

const mounted = new WeakMap<HTMLElement, (state: OptionsState) => void>();

function section(id: string, title: string, ...children: Node[]): HTMLElement {
  return h('section', { className: 'card', attrs: { 'aria-labelledby': id } }, h('h2', { id }, title), ...children);
}

function thresholdField(id: string, label: string, min: number, max: number, onCommit: (value: number) => void): ThresholdField {
  const input = h('input', { type: 'range', id, min: String(min), max: String(max), step: '1', attrs: { 'aria-describedby': `${id}-error` } });
  const output = h('output', { className: 'value', attrs: { for: id } });
  const error = h('p', { id: `${id}-error`, className: 'error', hidden: true, attrs: { role: 'alert' } });
  input.addEventListener('input', () => {
    output.value = `${input.value}%`;
  });
  input.addEventListener('change', () => {
    onCommit(Number(input.value));
  });
  const row = h('div', { className: 'field' }, h('div', { className: 'row' }, h('label', { htmlFor: id }, label), input, output), error);
  return { row, input, output, error };
}

function showError(el: HTMLElement, lines: string[]): void {
  el.replaceChildren(...lines.map((line) => h('span', {}, line)));
  el.hidden = lines.length === 0;
}

function entryRow(entry: WhitelistEntry, actions: OptionsActions): HTMLElement {
  return h(
    'li',
    { className: 'entry' },
    h('span', { className: 'entry-type' }, ENTRY_TYPE[entry.type]),
    h('code', {}, entry.key),
    h(
      'button',
      { type: 'button', className: 'secondary', onclick: () => actions.removeEntry(entry), attrs: { 'aria-label': `Remove ${entry.key}` } },
      'Remove',
    ),
  );
}

function mount(root: HTMLElement, actions: OptionsActions): (state: OptionsState) => void {
  const modes = MODES.map(([mode, label]) => {
    const input = h('input', { type: 'radio', name: 'mode', id: `pf-mode-${mode}`, value: mode });
    input.addEventListener('change', () => {
      if (input.checked) {
        actions.setSettings({ mode });
      }
    });
    return { mode, input, label: h('label', { className: 'choice' }, input, label) };
  });
  const thresholds: Record<Threshold, ThresholdField> = {
    exactThreshold: thresholdField('pf-exact', 'Exact threshold', 90, 100, (exactThreshold) => actions.setSettings({ exactThreshold })),
    nearThreshold: thresholdField('pf-near', 'Similar threshold', 75, 99, (nearThreshold) => actions.setSettings({ nearThreshold })),
  };
  let settings: Settings;
  const contentTypes = CONTENT_TYPES.map(([type, label]) => {
    const input = checkbox({
      id: `pf-type-${type}`,
      checked: false,
      onToggle: (isOn) => actions.setSettings({ contentTypes: { ...settings.contentTypes, [type]: isOn } }),
    });
    return { type, input, label: h('label', { className: 'choice' }, input, label) };
  });
  const platforms = PLATFORMS.map((platform) => {
    const input = checkbox({
      id: `pf-platform-${platform}`,
      checked: false,
      onToggle: (isOn) => actions.setSettings({ platforms: { ...settings.platforms, [platform]: isOn } }),
    });
    return { platform, input, label: h('label', { className: 'choice' }, input, PLATFORM_LABEL[platform]) };
  });
  const retention = retentionSelect('pf-retention', null, (retentionDays) => actions.setSettings({ retentionDays }));
  const toast = checkbox({ id: 'pf-toast', checked: false, onToggle: (isOn) => actions.setSettings({ toast: isOn }) });
  const notice = h('p', { className: 'notice', hidden: true, attrs: { role: 'status' } });
  const list = h('ul', { className: 'entries', attrs: { 'aria-label': 'Whitelist entries' } });
  const empty = h('p', { className: 'hint' }, 'No entries yet.');
  const sourcePlatform = h(
    'select',
    { id: 'pf-wl-platform', attrs: { 'aria-label': 'Platform' } },
    ...PLATFORMS.map((platform) => h('option', { value: platform }, PLATFORM_LABEL[platform])),
  );
  const sourceText = h('input', {
    type: 'text',
    id: 'pf-wl-source',
    placeholder: SOURCE_PLACEHOLDER.reddit,
    autocomplete: 'off',
    spellcheck: false,
    attrs: { 'aria-label': 'Source to always show', 'aria-describedby': 'pf-wl-error' },
  });
  const sourceError = h('p', { id: 'pf-wl-error', className: 'error', hidden: true, attrs: { role: 'alert' } });
  const selectedPlatform = (): Platform => PLATFORMS.find((p) => p === sourcePlatform.value) ?? 'reddit';
  sourcePlatform.addEventListener('change', () => {
    sourceText.placeholder = SOURCE_PLACEHOLDER[selectedPlatform()];
  });
  const addForm = h(
    'form',
    { className: 'add-source', noValidate: true },
    sourcePlatform,
    sourceText,
    h('button', { type: 'submit', className: 'primary' }, 'Add'),
  );
  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (actions.addSource(selectedPlatform(), sourceText.value)) {
      sourceText.value = '';
    }
  });

  root.replaceChildren(
    h('h1', {}, 'PureFeed settings'),
    section(
      'pf-sec-detection',
      'Detection',
      h('fieldset', { className: 'row' }, h('legend', {}, 'Mode'), h('div', { className: 'choices' }, ...modes.map((m) => m.label))),
      thresholds.exactThreshold.row,
      thresholds.nearThreshold.row,
      h(
        'fieldset',
        { className: 'row' },
        h('legend', {}, 'Content types'),
        h('div', { className: 'choices' }, ...contentTypes.map((c) => c.label)),
      ),
    ),
    section('pf-sec-platforms', 'Platforms', h('div', { className: 'choices' }, ...platforms.map((p) => p.label))),
    section(
      'pf-sec-history',
      'History',
      h('div', { className: 'row' }, h('label', { htmlFor: 'pf-retention' }, 'Retention'), retention),
      h('div', { className: 'row' }, h('label', { htmlFor: 'pf-toast' }, 'Toast when a post is hidden'), toast),
      h(
        'div',
        { className: 'actions' },
        h('button', { type: 'button', className: 'secondary danger', onclick: () => actions.clearHistory() }, 'Clear history'),
        h('button', { type: 'button', className: 'secondary', onclick: () => actions.resetCounters() }, 'Reset counters'),
      ),
      notice,
    ),
    section('pf-sec-whitelist', 'Whitelist', list, empty, addForm, sourceError),
    section(
      'pf-sec-privacy',
      'Privacy and limitations',
      h('p', {}, 'All processing is local. Nothing leaves this browser.'),
      h('p', {}, 'Known limitations: see README.'),
    ),
  );

  return (state) => {
    settings = state.settings;
    const shown: Settings = { ...state.settings, ...state.rejected?.patch };
    modes.forEach((m) => {
      m.input.checked = m.mode === shown.mode;
    });
    THRESHOLDS.forEach((field) => {
      const t = thresholds[field];
      const value = shown[field];
      const isRejected = state.rejected?.field === field;
      t.input.value = String(value);
      t.output.value = `${value}%`;
      t.input.setAttribute('aria-invalid', String(isRejected));
      showError(t.error, isRejected && state.rejected ? [state.rejected.message, 'Change not saved.'] : []);
    });
    contentTypes.forEach((c) => {
      c.input.checked = shown.contentTypes[c.type];
    });
    platforms.forEach((p) => {
      p.input.checked = shown.platforms[p.platform];
    });
    toast.checked = shown.toast;
    retention.value = retentionValue(shown.retentionDays);
    list.replaceChildren(...state.whitelist.map((entry) => entryRow(entry, actions)));
    list.hidden = state.whitelist.length === 0;
    empty.hidden = state.whitelist.length > 0;
    sourceText.setAttribute('aria-invalid', String(state.whitelistError !== null));
    showError(sourceError, state.whitelistError ? [state.whitelistError] : []);
    notice.textContent = state.notice ?? '';
    notice.hidden = state.notice === null;
  };
}

export function renderOptions(root: HTMLElement, state: OptionsState, actions: OptionsActions): void {
  const update = mounted.get(root) ?? mount(root, actions);
  mounted.set(root, update);
  update(state);
}
