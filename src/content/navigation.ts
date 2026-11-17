const DEFAULT_POLL_MS = 500;

export function watchUrl(win: Window, onChange: (href: string) => void, pollMs = DEFAULT_POLL_MS): () => void {
  let last = win.location.href;
  const check = () => {
    const { href } = win.location;
    if (href === last) {
      return;
    }
    last = href;
    onChange(href);
  };
  const interval = win.setInterval(check, pollMs);
  win.addEventListener('popstate', check);
  return () => {
    win.clearInterval(interval);
    win.removeEventListener('popstate', check);
  };
}
