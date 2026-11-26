// Applies the saved theme before first paint (DESIGN-SYSTEM.md §3). A file, not
// an inline script, so the page's CSP can forbid inline scripts.
(() => {
  try {
    const p = localStorage.getItem('stores-theme');
    const dark =
      p === 'dark' ||
      ((!p || p === 'system') && matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.dataset.theme = 'dark';
  } catch {}
})();
