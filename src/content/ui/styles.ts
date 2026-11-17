const BASE_CSS = `
:host {
  all: initial !important;
  display: block !important;
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif !important;
  color: #1a1a1b !important;
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
:host {
  container-type: inline-size !important;
}
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
  display: flex;
  flex: none;
  column-gap: 0.25em;
  margin: 0;
  padding: 0 6px;
  border: 1px solid #b8bec5;
  border-radius: 4px;
  background: #ffffff;
  cursor: pointer;
}
.prefix {
  flex: none;
}
.author {
  flex: 0 1 auto;
  min-width: 0;
}
.author .name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
@container (max-width: 480px) {
  .bar {
    padding: 2px 5px;
    font-size: 12px;
    line-height: 1.25;
  }
  .text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    white-space: normal;
  }
  .actions {
    gap: 4px;
    margin-top: 2px;
  }
  button {
    padding: 0 4px;
  }
}
@container (max-width: 420px) {
  .bar {
    font-size: 11px;
    line-height: 1.3;
  }
  .actions {
    gap: 3px;
  }
  button {
    padding: 0 3px;
  }
}
@container (max-width: 380px) {
  .bar {
    padding: 2px 4px;
  }
  .actions {
    gap: 2px;
  }
  button {
    padding: 0 2px;
  }
}
@container (max-width: 355px) {
  .prefix {
    display: none;
  }
}
`;

export const TOAST_CSS = `${BASE_CSS}
:host {
  position: fixed !important;
  bottom: 16px !important;
  right: 16px !important;
  z-index: 2147483647 !important;
}
.toast {
  padding: 8px 12px;
  border-radius: 6px;
  background: #1a1a1b;
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
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
