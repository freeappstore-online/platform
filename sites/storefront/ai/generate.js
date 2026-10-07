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
    context: `Add to <code>.cursorrules</code> in your project root:\n\n${copyCommand(`Read ${SKILLS_URL} for platform skills, brand mandates, compliance rules, and the publish flow.`)}`,
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
    context: `Codex reads the URL inline. For repeat use, add to your <code>codex.md</code>:\n\n${copyCommand(`Read ${SKILLS_URL} for FreeAppStore platform conventions.`)}`,
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
    context: `Add to your Windsurf global rules or <code>.windsurfrules</code>:\n\n${copyCommand(`Read ${SKILLS_URL} for platform skills, brand mandates, compliance rules, and the publish flow.`)}`,
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
    build: `Start a Cline chat and paste:\n\n<span class="ai-guide-prompt">Read ${SKILLS_URL} — then build me a weather dashboard app.</span>`,
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
    build: `In Copilot Chat, type:\n\n<span class="ai-guide-prompt">@workspace Read ${SKILLS_URL} — then build me a pomodoro timer app.</span>`,
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

function copyCommand(command) {
  return `<button type="button" class="ai-guide-command" data-copy-command title="Copy command">
  <span class="ai-guide-command-text">${esc(command)}</span>
  <span class="ai-guide-command-status" aria-hidden="true">Copy</span>
</button>`;
}

function html(tool) {
  const quickstartBlock = tool.quickstart
    ? `\n    <div class="ai-guide-callout">
      <strong>One command:</strong>
      ${copyCommand(tool.quickstart)}
      <p class="ai-guide-copy-hint">Select a command to copy it.</p>
    </div>\n`
    : '';

  const setupSteps = tool.setup.map(s =>
      `      <li>
        <strong>${s.note}</strong>
        ${copyCommand(s.cmd)}
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
  __CF_BEACON__
</head>
<body>
  {{HEADER}}

  <main class="container ai-guide-main">

    <div class="ai-guide-tool-nav" aria-label="AI tool guides">
${tools.map(t => `      <a href="/ai/${t.slug}.html"${t.slug === tool.slug ? ' class="active"' : ''}>${t.name}</a>`).join('\n')}
    </div>

    <h1>${tool.name} on FreeAppStore</h1>
    <p class="ai-guide-lead">${tool.desc}</p>
${quickstartBlock}
    <h2 class="ai-guide-heading">Setup</h2>
    <ol class="ai-guide-steps">
${setupSteps}
    </ol>

    <h2 class="ai-guide-heading">Build</h2>
    <p>${tool.build}</p>

    <h2 class="ai-guide-heading">Give it context</h2>
    <div class="ai-guide-context">${tool.context}</div>

    <h2 class="ai-guide-heading">Publish</h2>
    <ol class="ai-guide-steps">
      <li>
        <strong>Check compliance</strong>
        ${copyCommand('fas check')}
      </li>
      <li>
        <strong>Publish to the store</strong>
        ${copyCommand('fas publish')}
        <p>Creates repo, hosting route, custom subdomain, and store listing — all at once.</p>
      </li>
      <li>
        <strong>Future updates</strong>
        ${copyCommand('git push origin main')}
        <p>Auto-deploys in ~30 seconds.</p>
      </li>
    </ol>

    <h2 class="ai-guide-heading">Add user accounts &amp; cloud storage</h2>
    <p>Standalone apps use localStorage. If you need GitHub sign-in, per-user cloud storage, realtime rooms, or a secret-injecting API proxy:</p>
    ${copyCommand('cd web && pnpm add @freeappstore/sdk')}
    <ul>
      <li><strong>Auth</strong> — GitHub OAuth. <code>fas.auth.signIn()</code></li>
      <li><strong>KV</strong> — Per-user storage. <code>fas.kv.set('key', value)</code></li>
      <li><strong>Rooms</strong> — Realtime WebSocket. <code>fas.rooms.join('lobby')</code></li>
      <li><strong>Proxy</strong> — Server-side API keys. <code>fas.proxy.fetch('api.example.com/data')</code></li>
    </ul>
    <p><a href="${SDK_DOCS}">SDK docs</a></p>

    <h2 class="ai-guide-heading">MCP Server (optional)</h2>
    <p>For deeper AI integration, connect the FreeAppStore MCP server. Your agent gets tools to check deploys, look up SDK docs, and list apps.</p>
    ${copyCommand('npx mcp-remote https://mcp.freeappstore.online/mcp')}
    <p><a href="https://docs.freeappstore.online/mcp/">MCP setup guide &rarr;</a></p>

    <h2 class="ai-guide-heading">Tips</h2>
    <ul>
${tipsList}
    </ul>

    <p class="ai-guide-links"><a href="${PLATFORM_REPO}">Platform source</a> · <a href="${SKILLS_URL}">Full platform guide</a></p>

  </main>

  {{FOOTER}}
  <script src="/ai-guide.js?v={{VER_AI_GUIDE_JS}}" integrity="{{SRI_AI_GUIDE_JS}}" defer></script>
  <script src="/auth.js?v={{VER_AUTH_JS}}" integrity="{{SRI_AUTH_JS}}"></script>
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
