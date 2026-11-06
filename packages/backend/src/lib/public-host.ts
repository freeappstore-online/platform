/**
 * "Is this URL somewhere a server-side fetch may go?" for webhook targets
 * (#465). The URL is parsed, not pattern-matched, so decimal/hex/octal IPv4
 * forms (normalised by the URL parser), IPv4-mapped IPv6 and bracketed literals
 * are judged on the address they mean. `resolvesPublicly` additionally looks the
 * name up over DNS-over-HTTPS and requires every address to be public.
 */

const DOH = 'https://cloudflare-dns.com/dns-query';
const PRIVATE_SUFFIX = /\.(localhost|local|internal|lan|home|corp)$/;

function isIPv4(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

function isPrivateIPv4(host: string): boolean {
  const [a = 0, b = 0] = host.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** IPv6 is public only inside the global unicast block 2000::/3 (minus documentation 2001:db8::/32). */
function isPublicIPv6(addr: string): boolean {
  return /^[23][0-9a-f]{3}:/i.test(addr) && !/^2001:0?db8:/i.test(addr);
}

/** Synchronous checks on the URL text alone. Returns a reason, or null when nothing in the URL itself is wrong. */
export function privateUrlReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'invalid URL';
  }
  if (url.protocol !== 'https:') return 'must use HTTPS';
  if (url.username || url.password) return 'must not carry credentials';
  if (url.port && url.port !== '443') return 'must use the default HTTPS port';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) return 'must not be an IP literal';
  if (isIPv4(host)) return isPrivateIPv4(host) ? 'private address' : null;
  if (!host.includes('.') || host === 'localhost' || PRIVATE_SUFFIX.test(host)) {
    return 'private address';
  }
  return null;
}

/** Resolve the host (A and AAAA) and require every address to be public. Returns a reason or null. */
export async function nonPublicResolution(raw: string): Promise<string | null> {
  const literal = privateUrlReason(raw);
  if (literal) return literal;
  const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
  if (isIPv4(host)) return null;
  const addrs: string[] = [];
  for (const type of ['A', 'AAAA']) {
    try {
      const res = await fetch(`${DOH}?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return 'could not resolve host';
      const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
      for (const a of body.Answer ?? []) if (a.type === 1 || a.type === 28) addrs.push(a.data);
    } catch {
      return 'could not resolve host';
    }
  }
  if (addrs.length === 0) return 'could not resolve host';
  for (const a of addrs) {
    if (isIPv4(a) ? isPrivateIPv4(a) : !isPublicIPv6(a)) return 'resolves to a private address';
  }
  return null;
}
