#!/usr/bin/env node
// A stand-in for the `claude` CLI in tests: it appends its arguments and CLAUDE_CONFIG_DIR to
// $FAS_FAKE_CLAUDE_LOG and does what `claude mcp add-json/remove --scope user` would to the
// profile's .claude.json. The default profile lives in $FAS_DESKTOP_CLAUDE_HOME, never the real home.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR;
if (process.env.FAS_FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAS_FAKE_CLAUDE_LOG,
    `${JSON.stringify({ args, configDir: dir ?? null })}\n`,
  );
}
const home = process.env.FAS_DESKTOP_CLAUDE_HOME;
if (!dir && !home) {
  console.error('fake claude: set FAS_DESKTOP_CLAUDE_HOME or CLAUDE_CONFIG_DIR');
  process.exit(2);
}
const file = join(dir ?? home, '.claude.json');
const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
config.mcpServers ??= {};
const [, verb] = args;
const positional = args.slice(2).filter((a, i, all) => a !== '--scope' && all[i - 1] !== '--scope');
if (verb === 'add-json') {
  const [name, json] = positional;
  if (config.mcpServers[name]) {
    console.error(`MCP server ${name} already exists in user config`);
    process.exit(1);
  }
  config.mcpServers[name] = JSON.parse(json);
} else if (verb === 'remove') {
  delete config.mcpServers[positional[0]];
}
writeFileSync(file, JSON.stringify(config, null, 2));
