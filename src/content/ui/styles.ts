const BASE_CSS = `
:host {
  all: initial;
  display: block;
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: #1a1a1b;
}
button,
a {
  font: inherit;
  color: inherit;
}
button:focus-visible,
a:focus-visible {
  outline: 2px solid #0b57d0;
  outline-offset: 2px;
}
`;

export const INDICATOR_CSS = `${BASE_CSS}
.bar {
  box-sizing: border-box;
  max-height: 56px;
  overflow: hidden;
  margin: 4px 0;
  padding: 4px 8px;
  border: 1px solid #d0d4d9;
  border-radius: 6px;
  background: #f6f7f8;
}
.text {
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
a {
  text-decoration: underline;
}
.actions {
  display: flex;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
}
button {
  display: inline-block;
  margin: 0;
  padding: 0 6px;
  border: 1px solid #b8bec5;
  border-radius: 4px;
  background: #ffffff;
  cursor: pointer;
}
`;

export const TOAST_CSS = `${BASE_CSS}
:host {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 2147483647;
}
.toast {
  padding: 8px 12px;
  border-radius: 6px;
  background: #1a1a1b;
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  animation: purefeed-toast-in 150ms ease-out;
}
@keyframes purefeed-toast-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .toast {
    animation: none;
  }
}
`;

export function attachUi(doc: Document, css: string): { host: HTMLElement; root: ShadowRoot } {
  const host = doc.createElement('div');
  host.setAttribute('data-purefeed-ui', '');
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = css;
  root.append(style);
  return { host, root };
}
