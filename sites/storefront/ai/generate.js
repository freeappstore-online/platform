#!/usr/bin/env node
/**
 * Generate AI guide pages from tool definitions.
 * Run: node ai/generate.js
 * Output: ai/<slug>.html for each tool
 */
const fs = require('fs');
const path = require('path');

const SKILLS_URL = 'https://freeappstore.online/skills.md';
const CLAUDE_GUIDE_URL = 'https://freeappstore.online/claude-code.md';
const SDK_DOCS = 'https://github.com/freeappstore-online/platform/tree/main/packages/sdk#readme';
const PLATFORM_REPO = 'https://github.com/freeappstore-online/platform';

const tools = [
  {
    slug: 'claude-code',
    name: 'Claude Code',
    desc: 'AI agent in your terminal. Reads the platform spec, scaffolds, builds, and publishes — one command.',
    type: 'cli',
    quickstart: `claude "Read ${CLAUDE_GUIDE_URL} and build me a [describe your app]"`,
    setup: [
      { cmd: 'npm i -g @anthropic-ai/claude-code', note: 'Install Claude Code' },
      { cmd: 'npm i -g @freeappstore/cli && fas login', note: 'Install FreeAppStore CLI' },
    ],
    build: `claude "Read ${CLAUDE_GUIDE_URL} and build me a meditation timer app"`,
    context: `Claude reads the guide URL automatically — no manual CLAUDE.md setup needed. For ongoing projects, add to your CLAUDE.md:\n\nRead ${SKILLS_URL} for platform conventions.`,
    tips: [
      'Claude handles scaffold, code, compliance check, and publish autonomously.',
      'Use <code>--continue</code> to resume the last session.',
      'For existing projects: <code>claude "Read ' + CLAUDE_GUIDE_URL + ' and add dark mode to this app"</code>',
    ],
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    desc: 'AI-native code editor. Add the platform guide to Cursor rules, scaffold, and prompt.',
    type: 'ide',
    quickstart: null,
    setup: [
      { cmd: 'npm i -g @freeappstore/cli && fas login', note: 'Install FreeAppStore CLI' },
      { cmd: 'fas init my-app && cd my-app && pnpm install', note: 'Scaffold your app' },
    ],
    build: 'Open the folder in Cursor and prompt: "Build me a tip splitter app using the Shell layout and brand tokens."',
    context: `Add to <code>.cursorrules</code> in your project root:\n\n<div class="cmd">Read ${SKILLS_URL} for platform skills, brand mandates, compliance rules, and the publish flow.</div>`,
    tips: [
      'Cursor reads <code>.cursorrules</code> automatically on every prompt.',
      'Run <code>fas check</code> before publishing to catch compliance issues.',
      'Publish: <code>fas publish</code> — then every <code>git push</code> auto-deploys.',
    ],
  },
  {
    slug: 'codex',
    name: 'Codex',
    desc: 'OpenAI\'s CLI agent. Give it the platform guide and a description — it builds in a sandbox.',
    type: 'cli',
    quickstart: `codex "Read ${SKILLS_URL} then scaffold and build a [describe your app] for FreeAppStore"`,
    setup: [
      { cmd: 'npm i -g @openai/codex', note: 'Install Codex CLI' },
      { cmd: 'npm i -g @freeappstore/cli && fas login', note: 'Install FreeAppStore CLI' },
    ],
    build: `codex "Read ${SKILLS_URL} then scaffold and build a habit tracker for FreeAppStore"`,
    context: `Codex reads the URL inline. For repeat use, add to your <code>codex.md</code>:\n\n<div class="cmd">Read ${SKILLS_URL} for FreeAppStore platform conventions.</div>`,
    tips: [
      'After Codex finishes, run <code>fas check && fas publish</code> from the output directory.',
      'Codex builds in a sandbox — review the output before publishing.',
    ],
  },
  {
    slug: 'windsurf',
    name: 'Windsurf',
    desc: 'AI code editor by Codeium. Scaffold locally, add platform context, prompt the build.',
    type: 'ide',
    quickstart: null,
    setup: [
      { cmd: 'npm i -g @freeappstore/cli && fas login', note: 'Install FreeAppStore CLI' },
      { cmd: 'fas init my-app && cd my-app && pnpm install', note: 'Scaffold your app' },
    ],
    build: 'Open in Windsurf and prompt: "Build me a flashcard app using the Shell layout and brand tokens."',
    context: `Add to your Windsurf global rules or <code>.windsurfrules</code>:\n\n<div class="cmd">Read ${SKILLS_URL} for platform skills, brand mandates, compliance rules, and the publish flow.</div>`,
    tips: [
      'Windsurf picks up rules files automatically.',
      'Run <code>fas check</code> before publishing.',
      'Publish: <code>fas publish</code>',
    ],
  },
  {
    slug: 'cline',
    name: 'Cline',
    desc: 'Autonomous AI agent in VS Code. Paste the platform guide and let it build.',
    type: 'ide',
    quickstart: null,
    setup: [
      { cmd: 'npm i -g @freeappstore/cli && fas login', note: 'Install FreeAppStore CLI' },
      { cmd: 'fas init my-app && cd my-app && pnpm install && code .', note: 'Scaffold and open in VS Code' },
    ],
    build: `Start a Cline chat and paste:\n\n<div class="ai-prompt">Read ${SKILLS_URL} — then build me a weather dashboard app.</div>`,
    context: `Add the skills URL to Cline's custom instructions in settings, or paste it at the start of each chat.`,
    tips: [
      'Cline can run terminal commands — it can handle <code>fas check</code> and <code>fas publish</code> for you.',
      'Use "Plan" mode first to review what it will build, then switch to "Act".',
    ],
  },
  {
    slug: 'github-copilot',
    name: 'GitHub Copilot',
    desc: 'AI pair programmer in VS Code. Load the platform guide as workspace context.',
    type: 'ide',
    quickstart: null,
    setup: [
      { cmd: 'npm i -g @freeappstore/cli && fas login', note: 'Install FreeAppStore CLI' },
      { cmd: 'fas init my-app && cd my-app && pnpm install && code .', note: 'Scaffold and open in VS Code' },
    ],
    build: `In Copilot Chat, type:\n\n<div class="ai-prompt">@workspace Read ${SKILLS_URL} — then build me a pomodoro timer app.</div>`,
    context: `The <code>@workspace</code> prefix gives Copilot access to your project files. Paste the skills URL once per session.`,
    tips: [
      'Copilot Chat is better for full-file generation. Inline Copilot is better for line-by-line edits.',
      'Run <code>fas check && fas publish</code> from the terminal when done.',
    ],
  },
  {
    slug: 'aider',
    name: 'Aider',
    desc: 'Terminal-based AI pair programmer. Load the platform guide with --read.',
    type: 'cli',
    quickstart: `fas init my-app && cd my-app && pnpm install && aider --read ${SKILLS_URL}`,
    setup: [
      { cmd: 'pip install aider-chat', note: 'Install Aider' },
      { cmd: 'npm i -g @freeappstore/cli && fas login', note: 'Install FreeAppStore CLI' },
      { cmd: 'fas init my-app && cd my-app && pnpm install', note: 'Scaffold your app' },
    ],
    build: `aider --read ${SKILLS_URL}`,
    context: `The <code>--read</code> flag loads the URL as read-only context for the entire session.`,
    tips: [
      'Aider edits files in-place — review diffs with <code>/diff</code>.',
      'Run <code>fas check && fas publish</code> when done.',
    ],
  },
  {
    slug: 'continue',
    name: 'Continue',
    desc: 'Open-source AI assistant for VS Code and JetBrains. Add the platform guide as a context doc.',
    type: 'ide',
    quickstart: null,
    setup: [
      { cmd: 'npm i -g @freeappstore/cli && fas login', note: 'Install FreeAppStore CLI' },
      { cmd: 'fas init my-app && cd my-app && pnpm install', note: 'Scaffold your app' },
    ],
    build: 'Open in your IDE with Continue, and prompt: "Build me a unit converter app using the Shell layout."',
    context: `In Continue settings, add <code>${SKILLS_URL}</code> as a context document. It will be loaded for every chat.`,
    tips: [
      'Continue supports both VS Code and JetBrains IDEs.',
      'Run <code>fas check && fas publish</code> from the terminal.',
    ],
  },
  {
    slug: 'zed',
    name: 'Zed',
    desc: 'Fast, multiplayer code editor with built-in AI. Paste the platform guide as context.',
    type: 'ide',
    quickstart: null,
    setup: [
      { cmd: 'npm i -g @freeappstore/cli && fas login', note: 'Install FreeAppStore CLI' },
      { cmd: 'fas init my-app && cd my-app && pnpm install', note: 'Scaffold your app' },
    ],
    build: `Open the AI assistant panel, paste "Read ${SKILLS_URL}" as context, then describe your app.`,
    context: `Zed doesn't have a rules file — paste the URL at the start of each AI session.`,
    tips: [
      'Zed\'s AI assistant supports inline edits and multi-file generation.',
      'Run <code>fas check && fas publish</code> from the terminal.',
    ],
  },
  {
    slug: 'chatgpt-web',
    name: 'ChatGPT',
    desc: 'Use the web UI to generate code. Paste the platform guide, describe your app, copy the output.',
    type: 'web',
    quickstart: null,
    setup: [
      { cmd: 'npm i -g @freeappstore/cli && fas login', note: 'Install FreeAppStore CLI' },
      { cmd: 'fas init my-app && cd my-app && pnpm install', note: 'Scaffold your app' },
    ],
    build: `Go to <a href="https://chatgpt.com">chatgpt.com</a>, paste the contents of <a href="${SKILLS_URL}">${SKILLS_URL}</a>, then describe your app. Copy the generated code into your scaffold.`,
    context: `Paste the full skills.md text at the start of each conversation. ChatGPT can't fetch URLs directly.`,
    tips: [
      'Copy generated files into <code>web/src/App.tsx</code> and <code>web/src/components/</code>.',
      'Run <code>fas check && fas publish</code> locally.',
    ],
  },
];

function html(tool) {
  const quickstartBlock = tool.quickstart
    ? `\n    <div class="callout">
      <strong>One command:</strong>
      <div class="cmd" onclick="navigator.clipboard.writeText(this.textContent.trim())" style="cursor:pointer;" title="Click to copy">${esc(tool.quickstart)}</div>
      <p style="margin-top:0.5rem;font-size:0.85rem;color:var(--muted);">Click the command to copy.</p>
    </div>\n`
    : '';

  const setupSteps = tool.setup.map(s =>
    `      <li>
        <strong>${s.note}</strong>
        <div class="cmd" onclick="navigator.clipboard.writeText(this.textContent.trim())" style="cursor:pointer;" title="Click to copy">${esc(s.cmd)}</div>
      </li>`
  ).join('\n');

  const tipsList = tool.tips.map(t => `      <li>${t}</li>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>${tool.name} — FreeAppStore</title>
  <meta name="description" content="Build a free app on FreeAppStore with ${tool.name}." />
  <meta property="og:title" content="${tool.name} — FreeAppStore" />
  <meta property="og:description" content="Build a free app on FreeAppStore with ${tool.name}." />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://freeappstore.online/ai/${tool.slug}.html" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="stylesheet" href="/style.css" />
  <style>
    .ai-lead { font-size: 1.15rem; color: var(--muted); line-height: 1.6; max-width: 720px; margin-bottom: 2rem; }
    .steps { counter-reset: step; list-style: none; padding: 0; }
    .steps li { counter-increment: step; margin-bottom: 1.5rem; padding-left: 2.5rem; position: relative; }
    .steps li::before { content: counter(step); position: absolute; left: 0; top: 0; width: 1.8rem; height: 1.8rem; border-radius: 50%; background: var(--accent); color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.85rem; }
    .cmd { background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; padding: 0.85rem 1.1rem; margin: 0.5rem 0; font-family: ui-monospace, SF Mono, Menlo, monospace; font-size: 0.88rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
    .cmd:hover { border-color: var(--accent); }
    .callout { padding: 1.25rem 1.5rem; border-left: 4px solid var(--accent); background: var(--accent-soft, var(--panel)); border-radius: 0 0.75rem 0.75rem 0; margin: 1.5rem 0; }
    .callout strong { color: var(--ink); }
    h2 { font-size: 1.4rem; font-weight: 800; margin: 2.5rem 0 1rem; }
    .ai-prompt { background: var(--surface); border: 1px dashed var(--border); border-radius: 0.75rem; padding: 1rem 1.25rem; margin: 1rem 0; font-size: 0.92rem; line-height: 1.55; color: var(--ink); }
    .ai-prompt::before { content: 'Prompt'; display: block; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 0.5rem; }
    .tool-nav { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1.5rem 0; }
    .tool-nav a { padding: 0.4rem 0.8rem; border: 1px solid var(--border); border-radius: 0.5rem; font-size: 0.82rem; font-weight: 600; color: var(--muted); text-decoration: none; }
    .tool-nav a:hover, .tool-nav a.active { border-color: var(--accent); color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <a href="/" class="logo">Free <span>Apps</span></a>
      <nav>
        <a href="/">Apps</a>
        <a href="https://freegamestore.online">Games</a>
        <a href="/about.html">About</a>
        <a href="/build-with-ai.html">Build</a>
        <a href="https://console.freeappstore.online/create">VibeCode</a>
        <a href="/guidelines.html">Guidelines</a>
        <a href="https://proappstore.online" class="pro-link">Pro</a>
        <span id="navAuth"></span>
      </nav>
    </div>
  </header>

  <main class="container" style="max-width:720px;">

    <div class="tool-nav">
${tools.map(t => `      <a href="/ai/${t.slug}.html"${t.slug === tool.slug ? ' class="active"' : ''}>${t.name}</a>`).join('\n')}
    </div>

    <h1>${tool.name} on FreeAppStore</h1>
    <p class="ai-lead">${tool.desc}</p>
${quickstartBlock}
    <h2>Setup</h2>
    <ol class="steps">
${setupSteps}
    </ol>

    <h2>Build</h2>
    <p>${tool.build}</p>

    <h2>Give it context</h2>
    <p>${tool.context}</p>

    <h2>Publish</h2>
    <ol class="steps">
      <li>
        <strong>Check compliance</strong>
        <div class="cmd" onclick="navigator.clipboard.writeText(this.textContent.trim())" style="cursor:pointer;" title="Click to copy">fas check</div>
      </li>
      <li>
        <strong>Publish to the store</strong>
        <div class="cmd" onclick="navigator.clipboard.writeText(this.textContent.trim())" style="cursor:pointer;" title="Click to copy">fas publish</div>
        <p>Creates repo, hosting route, custom subdomain, and store listing — all at once.</p>
      </li>
      <li>
        <strong>Future updates</strong>
        <div class="cmd" onclick="navigator.clipboard.writeText(this.textContent.trim())" style="cursor:pointer;" title="Click to copy">git push origin main</div>
        <p>Auto-deploys in ~30 seconds.</p>
      </li>
    </ol>

    <h2>Add user accounts &amp; cloud storage</h2>
    <p>Standalone apps use localStorage. If you need GitHub sign-in, per-user cloud storage, realtime rooms, or a secret-injecting API proxy:</p>
    <div class="cmd" onclick="navigator.clipboard.writeText(this.textContent.trim())" style="cursor:pointer;" title="Click to copy">cd web && pnpm add @freeappstore/sdk</div>
    <ul>
      <li><strong>Auth</strong> — GitHub OAuth. <code>fas.auth.signIn()</code></li>
      <li><strong>KV</strong> — Per-user storage. <code>fas.kv.set('key', value)</code></li>
      <li><strong>Rooms</strong> — Realtime WebSocket. <code>fas.rooms.join('lobby')</code></li>
      <li><strong>Proxy</strong> — Server-side API keys. <code>fas.proxy.fetch('api.example.com/data')</code></li>
    </ul>
    <p><a href="${SDK_DOCS}">SDK docs</a></p>

    <h2>MCP Server (optional)</h2>
    <p>For deeper AI integration, connect the FreeAppStore MCP server. Your agent gets tools to check deploys, look up SDK docs, and list apps.</p>
    <div class="cmd" onclick="navigator.clipboard.writeText(this.textContent.trim())" style="cursor:pointer;" title="Click to copy">npx mcp-remote https://mcp.freeappstore.online/mcp</div>
    <p><a href="https://docs.freeappstore.online/mcp/">MCP setup guide &rarr;</a></p>

    <h2>Tips</h2>
    <ul>
${tipsList}
    </ul>

    <p style="margin-top:2rem;"><a href="${PLATFORM_REPO}">Platform source</a> · <a href="${SKILLS_URL}">Full platform guide</a></p>

  </main>

  <footer>
    <div class="container">
      <div class="footer-left">
        <a href="/" class="logo">Free <span>Apps</span></a>
        <p>Free forever, open source, privacy-first.</p>
      </div>
      <div class="footer-links">
        <a href="/about.html">About</a>
        <a href="/build-with-ai.html">Build</a>
        <a href="https://console.freeappstore.online/create">VibeCode</a>
        <a href="/guidelines.html">Guidelines</a>
        <a href="/quality.html">Quality</a>
        <a href="/pricing.html">Pricing</a>
        <a href="/privacy.html">Privacy</a>
        <a href="/terms.html">Terms</a>
        <a href="https://github.com/freeappstore-online">GitHub</a>
        <a href="https://proappstore.online" style="color:var(--pro);">Pro</a>
      </div>
    </div>
  </footer>
  <script src="/auth.js"></script>
</body>
</html>`;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const outDir = path.join(__dirname);
for (const tool of tools) {
  const file = path.join(outDir, `${tool.slug}.html`);
  fs.writeFileSync(file, html(tool));
  console.log(`  ${tool.slug}.html`);
}
console.log(`Generated ${tools.length} AI guide pages`);
