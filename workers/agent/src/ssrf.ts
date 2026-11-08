/**
 * Target check for the model's fetch_url tool (#474). The URL is parsed rather
 * than pattern-matched, so decimal/hex/octal IPv4 forms (normalised by the URL
 * parser), IPv4-mapped IPv6 and bracketed literals are judged on the address
 * they mean. A hostname is then resolved over DNS-over-HTTPS (a Worker cannot
 * resolve names itself) and refused unless every address is public.
 */

const DOH = "https://cloudflare-dns.com/dns-query";

/** Dotted IPv4 that is not a public unicast address. */
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** IPv6 is allowed only in the global unicast block 2000::/3 and never as a literal in the URL. */
function isPublicIPv6(addr: string): boolean {
  return /^[23][0-9a-f]{3}:/i.test(addr) && !/^2001:0?db8:/i.test(addr);
}

function isIPv4(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

/** The error to return for a URL the tool must not fetch, or null when it may go ahead. */
export async function fetchUrlDenied(raw: string): Promise<string | null> {
  const denied = "Error: cannot fetch private/internal URLs.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Error: invalid URL.";
  }
  if (url.protocol !== "https:") return "Error: can only fetch public HTTPS URLs.";
  if (url.username || url.password || (url.port && url.port !== "443")) return denied;

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // Any IPv6 literal (including ::ffff:127.0.0.1) is refused outright.
  if (host.startsWith("[")) return denied;
  if (isIPv4(host)) return isPrivateIPv4(host) ? denied : null;
  if (!host.includes(".") || host === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) {
    return denied;
  }

  // A name: every A/AAAA record must be public.
  const addrs: string[] = [];
  for (const type of ["A", "AAAA"]) {
    let body: { Status?: number; Answer?: { type: number; data: string }[] };
    try {
      const res = await fetch(`${DOH}?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { Accept: "application/dns-json" },
      });
      if (!res.ok) return "Error: could not resolve the host.";
      body = (await res.json()) as typeof body;
    } catch {
      return "Error: could not resolve the host.";
    }
    for (const a of body.Answer ?? []) {
      if (a.type === 1 || a.type === 28) addrs.push(a.data);
    }
  }
  if (addrs.length === 0) return "Error: could not resolve the host.";
  for (const addr of addrs) {
    if (isIPv4(addr) ? isPrivateIPv4(addr) : !isPublicIPv6(addr)) return denied;
  }
  return null;
}
