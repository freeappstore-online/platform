import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';

const CONFIG_DIR = join(homedir(), '.fas');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface FasConfig {
  apiBase: string;
  github?: {
    accessToken: string;
    login: string;
    obtainedAt: number;
  };
  /**
   * fas session token, minted by /v1/auth/exchange. Used as a Bearer for
   * authenticated calls to the platform API. Lives 30 days; if expired,
   * `fas login` mints a new one.
   */
  session?: {
    token: string;
    obtainedAt: number;
  };
}

const DEFAULT_CONFIG: FasConfig = {
  apiBase: process.env['FAS_API_BASE'] ?? 'https://api.freeappstore.online',
};

export async function readConfig(): Promise<FasConfig> {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<FasConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(config: FasConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
}
