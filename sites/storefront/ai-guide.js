// Shared interaction for /ai/*.html. Kept external so production CSP can
// forbid inline event handlers and scripts while command blocks stay copyable.
(function () {
  function copyCommand(button) {
    const text = button.querySelector('.ai-guide-command-text')?.textContent?.trim();
    if (!text || !navigator.clipboard?.writeText) return;

    navigator.clipboard.writeText(text).then(() => {
      button.classList.add('is-copied');
      window.setTimeout(() => button.classList.remove('is-copied'), 1500);
    }).catch(() => {});
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy-command]');
    if (button) copyCommand(button);
  });
})();
