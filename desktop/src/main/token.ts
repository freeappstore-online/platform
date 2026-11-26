import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'mcp-token';

function write(path: string): string {
  const token = randomBytes(32).toString('base64url');
  writeFileSync(path, token, { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file.
  chmodSync(path, 0o600);
  return token;
}

/** The per-install MCP bearer token, created on first run in `dir` (the app's userData). */
export function loadToken(dir: string): string {
  const path = join(dir, FILE);
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token) {
      chmodSync(path, 0o600);
      return token;
    }
  }
  return write(path);
}

/** Replaces the token; clients set up with the old one stop working. */
export function regenerateToken(dir: string): string {
  return write(join(dir, FILE));
}
