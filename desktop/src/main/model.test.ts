import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installModel, MODEL_ROOT, MODEL_SPACE_NEEDED, modelInstalled } from './model.js';

let tmp: string;
let server: Server;
let url: string;
let sha256: string;

beforeAll(async () => {
  // A stand-in package: the model's folder with one file, as a .tar.bz2
  tmp = mkdtempSync(join(tmpdir(), 'fas-model-'));
  mkdirSync(join(tmp, 'src', MODEL_ROOT), { recursive: true });
  writeFileSync(join(tmp, 'src', MODEL_ROOT, 'tokens.txt'), 'a 1\n');
  execFileSync('tar', ['cjf', join(tmp, 'package.tar.bz2'), '-C', join(tmp, 'src'), MODEL_ROOT]);
  const archive = readFileSync(join(tmp, 'package.tar.bz2'));
  sha256 = createHash('sha256').update(archive).digest('hex');
  server = createServer((_req, res) => res.end(archive));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/package.tar.bz2`;
});

afterAll(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('installModel', () => {
  it('downloads, checks and unpacks the package, reporting both stages', async () => {
    const dir = join(tmp, 'ok');
    const stages = new Set<string>();
    await installModel(dir, (stage) => stages.add(stage), url, sha256);
    expect(modelInstalled(dir)).toBe(true);
    expect(readFileSync(join(dir, MODEL_ROOT, 'tokens.txt'), 'utf8')).toBe('a 1\n');
    expect(existsSync(join(dir, 'download.part'))).toBe(false);
    expect([...stages]).toEqual(['download', 'unpack']);
  });

  it('downloads nothing without room for the package and 1 GB to spare (#792)', async () => {
    const dir = join(tmp, 'full');
    await expect(installModel(dir, () => {}, url, sha256, MODEL_SPACE_NEEDED - 1)).rejects.toThrow(
      'It needs 1751 MB free, so 1 GB is left after it installs.',
    );
    expect(existsSync(dir)).toBe(false);
    await installModel(dir, () => {}, url, sha256, MODEL_SPACE_NEEDED);
    expect(modelInstalled(dir)).toBe(true);
  });

  it('unpacks nothing from a download that does not match its checksum', async () => {
    const dir = join(tmp, 'bad');
    await expect(installModel(dir, () => {}, url, '0'.repeat(64))).rejects.toThrow(/checksum/);
    expect(existsSync(dir)).toBe(false);
  });
});
