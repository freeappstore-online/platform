// Only published, complete installer sets can become the download page's version.
// Never read desktop/package.json: main can be ahead of the available downloads.
const RELEASES = 'https://github.com/freeappstore-online/platform/releases';
const ASSETS = [
  'FreeAppStore-mac-arm64.dmg', 'FreeAppStore-mac-x64.dmg',
  'FreeAppStore-mac-arm64.zip', 'FreeAppStore-mac-x64.zip',
  'FreeAppStore-win-x64.exe', 'FreeAppStore-linux-x86_64.AppImage',
];

function publishedDesktopRelease(releases) {
  if (!Array.isArray(releases)) return null;
  const complete = releases.flatMap((release) => {
    const match = /^desktop-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release?.tag_name);
    if (!match || release.draft !== false || !Array.isArray(release.assets)) return [];
    const parts = match[1].split('.').map(Number);
    if (!parts.every(Number.isSafeInteger)) return [];
    if (typeof release.published_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(release.published_at)) return [];
    const date = new Date(release.published_at);
    if (!Number.isFinite(date.getTime())) return [];
    if (!ASSETS.every((name) => release.assets.some((asset) =>
      asset.name === name && asset.state === 'uploaded' && asset.size > 0 &&
      asset.browser_download_url === `${RELEASES}/download/${release.tag_name}/${name}`))) return [];
    return [{ version: match[1], tag: release.tag_name, publishedAt: date.toISOString(), parts }];
  });
  complete.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  return complete[0] || null;
}

async function fetchDesktopRelease({ token = '', offline = false, fetchImpl = fetch, warn = console.warn } = {}) {
  if (offline) return null;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'freeappstore-build' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const signal = AbortSignal.timeout(10_000);
  try {
    // Other platform releases share this repository; look past them, bounded by one timeout.
    for (let page = 1; page <= 5; page++) {
      const response = await fetchImpl(`https://api.github.com/repos/freeappstore-online/platform/releases?per_page=100&page=${page}`, { headers, signal });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const releases = await response.json();
      if (!Array.isArray(releases)) throw new Error('GitHub returned an invalid release list');
      const release = publishedDesktopRelease(releases);
      if (release) return release;
      if (releases.length < 100) break;
    }
    warn('No complete published desktop release found; keeping the latest-release download links.');
  } catch {
    warn('Desktop release details unavailable; keeping the latest-release download links.');
  }
  return null;
}

function renderDesktopRelease(html, release) {
  let details = `Version details are temporarily unavailable. <a href="${RELEASES}/tag/desktop-latest">View latest release</a>.`;
  if (release) {
    const date = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(release.publishedAt));
    details = `<strong>Version ${release.version}</strong> · Released <time datetime="${release.publishedAt}">${date}</time> · <a href="${RELEASES}/tag/${release.tag}">What’s new</a>`;
    // Includes the no-JavaScript installer list and zip link. download.js takes its URLs from that list.
    html = html.replaceAll(`${RELEASES}/download/desktop-latest/`, `${RELEASES}/download/${release.tag}/`)
      .replaceAll(`${RELEASES}/tag/desktop-latest`, `${RELEASES}/tag/${release.tag}`);
  }
  return html.replace('{{DESKTOP_RELEASE}}', () => details);
}

module.exports = { ASSETS, RELEASES, publishedDesktopRelease, fetchDesktopRelease, renderDesktopRelease };
