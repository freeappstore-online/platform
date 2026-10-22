/**
 * Pull the JS URLs the browser fetches from the initial HTML parse:
 * `<script src>` and `<link rel="modulepreload">`. Dynamically imported
 * chunks, workers and wasm do not appear here — Vite only modulepreloads
 * the static import graph.
 */

const JS_REF_RE = /\.m?js(?:[?#]|$)/i;

export function collectInitialJsRefs(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (ref: string | undefined) => {
    if (!ref) return;
    const trimmed = ref.trim();
    if (!trimmed || seen.has(trimmed) || !JS_REF_RE.test(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    add(getAttr(m[0]!, 'src'));
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = getAttr(m[0]!, 'rel');
    if (rel?.toLowerCase() === 'modulepreload') add(getAttr(m[0]!, 'href'));
  }
  return out;
}

/**
 * Map a script/modulepreload URL to a file name under `web/dist/assets/`.
 * `null` if the ref is not an `/assets/*.js` (or `.mjs`) path.
 */
export function jsAssetFileName(ref: string): string | null {
  const path = ref.split(/[?#]/, 1)[0]!.replace(/^\.\//, '');
  const m = /(?:^|\/)assets\/(.+\.m?js)$/i.exec(path);
  return m ? m[1]! : null;
}

function getAttr(tag: string, name: string): string | undefined {
  // Require a real attribute boundary. `\b` would also match `data-src`.
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(tag);
  return m?.[1] ?? m?.[2];
}
