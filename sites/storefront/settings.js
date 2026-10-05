(function () {
  var themePicker = document.getElementById('themePicker');
  var textSizePicker = document.getElementById('textSizePicker');

  function getStored(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }

  function setActive(container, selector, value) {
    container.querySelectorAll('.setting-option').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute(selector) === value);
    });
  }

  // --- Theme ---
  if (themePicker) {
    var currentTheme = getStored('stores-theme', 'system');
    setActive(themePicker, 'data-theme', currentTheme);

    themePicker.addEventListener('click', function (e) {
      var btn = e.target.closest('.setting-option');
      if (!btn) return;
      var theme = btn.dataset.theme;
      setActive(themePicker, 'data-theme', theme);
      try { localStorage.setItem('stores-theme', theme); } catch (e) {}
      if (theme === 'system') {
        var preferDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (preferDark) document.documentElement.dataset.theme = 'dark';
        else delete document.documentElement.dataset.theme;
      } else if (theme === 'dark') {
        document.documentElement.dataset.theme = 'dark';
      } else {
        delete document.documentElement.dataset.theme;
      }
    });
  }

  // --- Text size ---
  if (textSizePicker) {
    var currentSize = getStored('stores-text-size', '') || '';
    setActive(textSizePicker, 'data-size', currentSize);

    textSizePicker.addEventListener('click', function (e) {
      var btn = e.target.closest('.setting-option');
      if (!btn) return;
      var size = btn.dataset.size;
      setActive(textSizePicker, 'data-size', size);
      if (size) {
        document.documentElement.dataset.text = size;
        try { localStorage.setItem('stores-text-size', size); } catch (e) {}
      } else {
        delete document.documentElement.dataset.text;
        try { localStorage.removeItem('stores-text-size'); } catch (e) {}
      }
    });
  }
})();
