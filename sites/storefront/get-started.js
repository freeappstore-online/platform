// /get-started — animated terminal demo + click-to-copy on all terminal blocks.
// Extracted from inline <script> on 2026-05-21 so the site-wide CSP can keep
// script-src 'self' (no 'unsafe-inline').

(function () {
  const lines = [
    { type: 'cmd', prompt: '~ $', text: 'npm install -g @freeappstore/cli', delay: 40 },
    { type: 'output', text: 'added 1 package in 3s', delay: 800 },
    { type: 'pause', delay: 400 },
    { type: 'cmd', prompt: '~ $', text: 'fas login', delay: 50 },
    { type: 'success', text: '✓ Logged in as your-username', delay: 600 },
    { type: 'pause', delay: 400 },
    { type: 'cmd', prompt: '~ $', text: 'fas init my-app', delay: 40 },
    { type: 'output', text: '', delay: 200 },
    { type: 'output', text: '  Creating My App...', delay: 300 },
    { type: 'output', text: '', delay: 100 },
    { type: 'output', text: '  [1/3] Scaffolding from template...', delay: 400 },
    { type: 'output', text: '  [2/3] Installing dependencies...', delay: 800 },
    { type: 'output', text: '  [3/3] Initializing git...', delay: 400 },
    { type: 'success', text: '  Done! Your app is ready.', delay: 300 },
    { type: 'pause', delay: 500 },
    { type: 'cmd', prompt: '~ $', text: 'cd my-app', delay: 50 },
    { type: 'pause', delay: 300 },
    { type: 'cmd', prompt: 'my-app $', text: 'pnpm dev', delay: 40 },
    { type: 'output', text: '', delay: 200 },
    { type: 'highlight', text: '  VITE v8.0.10  ready in 180ms', delay: 400 },
    { type: 'output', text: '', delay: 100 },
    { type: 'url', text: '  ➜  Local:   http://localhost:5173/', delay: 300 },
    { type: 'url', text: '  ➜  Network: http://192.168.1.42:5173/', delay: 200 },
    { type: 'output', text: '', delay: 100 },
    { type: 'success', text: '  ✓ App running — open your browser!', delay: 0 },
  ];

  const term = document.getElementById('term');
  if (!term) return;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function typeLine(el, text, charDelay) {
    const span = el.querySelector('.typed');
    for (let i = 0; i < text.length; i++) {
      span.textContent += text[i];
      await sleep(charDelay);
    }
  }

  async function runDemo() {
    term.innerHTML = '';
    for (const line of lines) {
      if (line.type === 'pause') {
        await sleep(line.delay);
        continue;
      }

      const div = document.createElement('div');
      div.className = 'terminal-line';

      if (line.type === 'cmd') {
        const promptSpan = document.createElement('span');
        promptSpan.className = 'prompt';
        promptSpan.textContent = line.prompt + ' ';
        const typedSpan = document.createElement('span');
        typedSpan.className = 'typed';
        const cursorSpan = document.createElement('span');
        cursorSpan.className = 'cursor';
        div.appendChild(promptSpan);
        div.appendChild(typedSpan);
        div.appendChild(cursorSpan);
        div.classList.add('copyable');
        div.dataset.cmd = line.text;
        term.appendChild(div);
        div.classList.add('visible');
        await typeLine(div, line.text, line.delay);
        cursorSpan.remove();
        await sleep(300);
      } else {
        const cls = line.type === 'success' ? 'success'
          : line.type === 'url' ? 'url'
          : line.type === 'highlight' ? 'highlight'
          : 'output';
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = line.text;
        div.appendChild(span);
        term.appendChild(div);
        await sleep(line.delay);
        div.classList.add('visible');
      }

      term.scrollTop = term.scrollHeight;
    }
  }

  runDemo();

  // Replay button — replaces the old onclick="runDemo()".
  const replayBtn = document.getElementById('gs-replay-btn');
  if (replayBtn) replayBtn.addEventListener('click', () => { runDemo(); });

  // Click-to-copy on animated terminal command lines.
  term.addEventListener('click', (e) => {
    const line = e.target.closest('.copyable');
    if (!line) return;
    const cmd = line.dataset.cmd;
    if (!cmd) return;
    navigator.clipboard.writeText(cmd);
    line.classList.add('copied');
    setTimeout(() => line.classList.remove('copied'), 1500);
  });

  // Click-to-copy on static terminal blocks (the publishing / Claude Code /
  // Cursor / Codex / Copilot / windsurf demos below the animated one).
  document.querySelectorAll('.terminal-body .terminal-line.visible').forEach(el => {
    const prompt = el.querySelector('.prompt');
    const cmd = el.querySelector('.cmd');
    if (!prompt || !cmd) return;
    el.classList.add('copy-line');
    el.dataset.cmd = cmd.textContent;
    el.addEventListener('click', () => {
      navigator.clipboard.writeText(el.dataset.cmd);
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 1500);
    });
  });

  // Static URL lines (e.g. https://my-app.freeappstore.online) are also copyable.
  document.querySelectorAll('.terminal-body .terminal-line.visible').forEach(el => {
    const url = el.querySelector('.url');
    if (!url || el.classList.contains('copy-line')) return;
    const text = url.textContent.trim();
    if (!text.startsWith('http') && !text.startsWith('See ')) return;
    el.classList.add('copy-line');
    el.dataset.cmd = text;
    el.addEventListener('click', () => {
      navigator.clipboard.writeText(text);
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 1500);
    });
  });
})();
