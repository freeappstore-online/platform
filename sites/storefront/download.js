// /download — picks the desktop installer for this visitor (#805). The full list is static HTML; this only fills
// the primary buttons. Asset URLs come from the list's links, so they live in one place.

(function () {
  const buttons = document.getElementById('dl-buttons');
  const detected = document.getElementById('dl-detected');
  if (!buttons || !detected) return;

  const href = (asset) => document.querySelector(`[data-asset="${asset}"]`)?.getAttribute('href');
  const LABELS = {
    'mac-arm64': 'Download for Mac (Apple Silicon)',
    'mac-x64': 'Download for Mac (Intel)',
    'win-x64': 'Download for Windows',
    'linux-x64': 'Download for Linux (AppImage)',
  };

  function show(text, assets) {
    detected.textContent = text;
    const available = assets.filter(asset => href(asset));
    if (!available.length) detected.textContent = 'A verified installer for this computer is being prepared. Available platforms are listed below.';
    buttons.replaceChildren(...available.map((asset, i) => {
      const a = document.createElement('a');
      a.href = href(asset);
      a.className = i === 0 ? 'btn-primary' : 'app-btn-secondary';
      a.textContent = LABELS[asset];
      return a;
    }));
  }

  function os() {
    const p = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
    const ua = navigator.userAgent.toLowerCase();
    if (/iphone|ipad|ipod|android/.test(ua) || navigator.userAgentData?.mobile) return 'mobile';
    // iPadOS reports a Mac user agent; touch support gives it away.
    if (p.includes('mac') && navigator.maxTouchPoints > 1) return 'mobile';
    if (p.includes('mac')) return 'mac';
    if (p.includes('win')) return 'win';
    if (p.includes('linux') || p.includes('x11') || ua.includes('linux')) return 'linux';
    return 'unknown';
  }

  // Only Chromium browsers can tell Apple Silicon from Intel; elsewhere both buttons are shown.
  async function macArch() {
    try {
      const v = await navigator.userAgentData?.getHighEntropyValues?.(['architecture']);
      if (v?.architecture === 'arm') return 'arm64';
      if (v?.architecture === 'x86') return 'x64';
    } catch {}
    return null;
  }

  async function run() {
    switch (os()) {
      case 'mac': {
        const arch = await macArch();
        if (arch === 'arm64') show('Your Mac has Apple Silicon.', ['mac-arm64', 'mac-x64']);
        else if (arch === 'x64') show('Your Mac has an Intel processor.', ['mac-x64', 'mac-arm64']);
        else show('For Mac: pick Apple Silicon (M1–M4) or Intel.', ['mac-arm64', 'mac-x64']);
        break;
      }
      case 'win':
        show('For Windows 10 and 11 (64-bit).', ['win-x64']);
        break;
      case 'linux':
        show('For Linux on x86-64.', ['linux-x64']);
        break;
      case 'mobile':
        detected.textContent = 'The desktop app runs on Mac, Windows and Linux. Open this page on your computer to download it.';
        break;
      default:
        detected.textContent = 'Choose the installer for your computer below.';
    }
  }

  run();
})();
