const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Check built output, not template spelling: every sitemap HTML identity must
// agree with Pages' extensionless destination. Docs and plain text are separate.
function verifySeo(dist) {
  const xml = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8');
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.equal(new Set(urls).size, urls.length, 'Duplicate sitemap destinations');
  for (const url of urls) {
    const u = new URL(url);
    if (u.origin !== 'https://freeappstore.online' || /\.(txt|md)$/.test(u.pathname)) continue;
    assert.ok(!u.pathname.endsWith('.html'), `Redirecting sitemap location: ${url}`);
    const file = u.pathname === '/' ? 'index.html' : `${u.pathname.slice(1)}.html`;
    const html = fs.readFileSync(path.join(dist, file), 'utf8');
    const canonical = [...html.matchAll(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/g)];
    assert.equal(canonical.length, 1, `${url}: expected one canonical`);
    assert.equal(canonical[0][1], url, `${url}: canonical must match deployed destination`);
    for (const og of html.matchAll(/<meta\b[^>]*property="og:url"[^>]*content="([^"]+)"/g)) {
      assert.equal(og[1], url, `${url}: og:url disagreement`);
    }
  }
  assert.ok(!xml.includes('<lastmod>'), 'Do not claim all content changed on every build');
  return urls;
}
if (require.main === module) console.log(`Verified ${verifySeo(process.argv[2] || 'dist').length} sitemap destinations`);
module.exports = { verifySeo };
