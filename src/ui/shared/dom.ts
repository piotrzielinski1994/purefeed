import type { RetentionDays } from '../../shared/types.ts';
import { parseRetention, RETENTION_PERIODS, retentionLabel, retentionValue } from './format.ts';

type Child = Node | string | false | null | undefined;
type Props<K extends keyof HTMLElementTagNameMap> = Partial<HTMLElementTagNameMap[K]> & { attrs?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const { attrs = {}, ...rest } = props;
  const el = document.createElement(tag);
  el.append(...children.filter((c): c is Node | string => c !== false && c !== null && c !== undefined));
  Object.assign(el, rest);
  Object.entries(attrs).forEach(([name, value]) => {
    el.setAttribute(name, value);
  });
  return el;
}

export function checkbox(opts: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  isSwitch?: boolean;
  attrs?: Record<string, string>;
  onToggle(checked: boolean): void;
}): HTMLInputElement {
  const input = h('input', {
    type: 'checkbox',
    id: opts.id,
    className: opts.isSwitch ? 'switch' : 'check',
    checked: opts.checked,
    disabled: opts.disabled ?? false,
    attrs: { ...(opts.isSwitch ? { role: 'switch' } : {}), ...opts.attrs },
  });
  input.addEventListener('change', () => {
    opts.onToggle(input.checked);
  });
  return input;
}

export function retentionSelect(id: string, current: RetentionDays, onSelect: (days: RetentionDays) => void): HTMLSelectElement {
  const select = h(
    'select',
    { id, value: retentionValue(current) },
    ...RETENTION_PERIODS.map((days) => h('option', { value: retentionValue(days) }, retentionLabel(days))),
  );
  select.addEventListener('change', () => {
    const days = parseRetention(select.value);
    if (days !== undefined) {
      onSelect(days);
    }
  });
  return select;
}

export function replaceKeepingFocus(root: HTMLElement, ...children: Node[]): void {
  const focusedId = root.contains(document.activeElement) ? document.activeElement?.id : undefined;
  root.replaceChildren(...children);
  if (focusedId) {
    document.getElementById(focusedId)?.focus();
  }
}
