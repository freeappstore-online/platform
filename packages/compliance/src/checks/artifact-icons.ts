import type { FileSource } from '../lib/file-source.js';
import { stripHtmlComments } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

/** Static inspection only: browser decoding and installation still need runtime QA. */
export async function checkArtifactIcons(
  source: FileSource,
  outputPath: string,
): Promise<CheckResult> {
  const name = 'Artifact icon assets';
  let checked = 0;
  let external = 0;
  try {
    const html = stripHtmlComments((await source.read(`${outputPath}/index.html`)) ?? '');
    const base = new URL('https://artifact.invalid/index.html');
    // Respect an application's deployment base when resolving declarations.
    const baseHref = /<base\b[^>]*href=["']([^"']+)["']/i.exec(html)?.[1];
    const pageBase = baseHref ? new URL(baseHref, base) : base;
    const assetPath = (ref: string, from: URL): { path: string; url: URL } | null => {
      const url = new URL(ref, from);
      if (url.origin !== base.origin) {
        external++;
        return null;
      }
      const mount = new URL('.', pageBase).pathname;
      const relative =
        mount !== '/' && url.pathname.startsWith(mount)
          ? url.pathname.slice(mount.length)
          : url.pathname;
      const path = decodeURIComponent(relative).replace(/^\/+/, '');
      if (path.split(/[\\/]/).some((part) => part === '..' || part === '.'))
        throw new Error('Unsafe icon asset path');
      return { path: `${outputPath}/${path}`, url };
    };
    const inspect = async (ref: string, from: URL, sizes?: string) => {
      const asset = assetPath(ref, from);
      if (!asset) return;
      if (!source.readBytes)
        throw new Error('Binary asset inspection unavailable for this file source');
      const bytes = await source.readBytes(asset.path);
      if (!bytes?.length) throw new Error(`Missing or empty icon: ${asset.path}`);
      const text = new TextDecoder().decode(bytes.slice(0, 1024));
      let width: number | undefined;
      let height: number | undefined;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (/\.png$/i.test(asset.path)) {
        if (
          bytes.length < 24 ||
          bytes.slice(0, 8).join(',') !== '137,80,78,71,13,10,26,10' ||
          new TextDecoder().decode(bytes.slice(12, 16)) !== 'IHDR'
        )
          throw new Error(`Invalid PNG header: ${asset.path}`);
        width = view.getUint32(16);
        height = view.getUint32(20);
        if (!width || !height) throw new Error(`Invalid PNG dimensions: ${asset.path}`);
      } else if (/\.ico$/i.test(asset.path)) {
        if (
          bytes.length < 22 ||
          view.getUint32(0, true) !== 0x00010000 ||
          view.getUint16(4, true) < 1
        )
          throw new Error(`Invalid ICO header: ${asset.path}`);
      } else if (/\.svg$/i.test(asset.path)) {
        if (!/<svg\b/i.test(new TextDecoder().decode(bytes)))
          throw new Error(`Invalid SVG icon: ${asset.path}`);
      } else if (/^\s*<!doctype html|^\s*<html\b/i.test(text))
        throw new Error(`HTML returned as icon: ${asset.path}`);
      if (
        width &&
        height &&
        sizes &&
        sizes !== 'any' &&
        !sizes.split(/\s+/).includes(`${width}x${height}`)
      )
        throw new Error(`Declared icon dimensions differ from PNG: ${asset.path}`);
      checked++;
    };
    for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
      const attrs = Object.fromEntries(
        [...tag[0].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [
          match[1]!.toLowerCase(),
          match[2]!,
        ]),
      );
      const rel = attrs.rel?.toLowerCase().split(/\s+/) ?? [];
      if (!attrs.href) continue;
      if (rel.includes('icon') || rel.includes('apple-touch-icon'))
        await inspect(attrs.href, pageBase, attrs.sizes);
      if (rel.includes('manifest')) {
        const manifest = assetPath(attrs.href, pageBase);
        if (!manifest) continue;
        const raw = await source.read(manifest.path);
        if (raw === null) throw new Error(`Missing manifest: ${manifest.path}`);
        let parsed: { icons?: { src?: unknown; sizes?: unknown }[] };
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error('Artifact manifest is not valid JSON');
        }
        if (parsed.icons !== undefined && !Array.isArray(parsed.icons))
          throw new Error('Artifact manifest icons must be an array');
        for (const icon of parsed.icons ?? []) {
          if (!icon || typeof icon.src !== 'string')
            throw new Error('Artifact manifest icon is missing src');
          await inspect(
            icon.src,
            manifest.url,
            typeof icon.sizes === 'string' ? icon.sizes : undefined,
          );
        }
      }
    }
    return {
      name,
      status: external || !checked ? 'warn' : 'pass',
      detail: `${checked} local icon declarations inspected; ${external} external declarations not fetched. Browser decoding/installation not run.`,
    };
  } catch (error) {
    return {
      name,
      status: 'fail',
      detail: error instanceof Error ? error.message : 'Could not inspect artifact icons',
    };
  }
}
