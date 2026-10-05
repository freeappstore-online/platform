# How to Build a Free App

Build and publish a free app on [freeappstore.online](https://freeappstore.online) using your favorite AI tool. Every app gets a subdomain, auto-deploy, and a listing on the store. No cost, no tracking, MIT licensed.

**Prerequisites:** Node 22+, then `npm i -g @freeappstore/cli && fas login`

---

## Claude Code (CLI)
```
claude "Read https://freeappstore.online/claude-code.md and build me a [describe your app]"
```
Claude reads the full platform spec and handles setup, code, compliance, and publish autonomously. Guide: <https://freeappstore.online/ai/claude-code>

## Cursor
Open Cursor, create a new project, and add this to your `.cursorrules`:
```
Read https://freeappstore.online/skills.md for platform rules before writing any code.
```
Then scaffold: `fas init my-app && cd my-app && pnpm install`, open the folder in Cursor, and prompt away. Guide: <https://freeappstore.online/ai/cursor>

## Codex (OpenAI CLI)
```
codex "Read https://freeappstore.online/skills.md then scaffold and build a [describe your app] for FreeAppStore"
```
Codex reads the platform guide and builds in its sandbox. After it's done, run `fas check && fas publish`. Guide: <https://freeappstore.online/ai/codex>

## Windsurf
Open Windsurf, scaffold with `fas init my-app && cd my-app && pnpm install`, open the folder, and add `Read https://freeappstore.online/skills.md` to your Windsurf rules. Prompt the build, then `fas check && fas publish`. Guide: <https://freeappstore.online/ai/windsurf>

## Cline (VS Code)
Install the Cline extension. Scaffold: `fas init my-app && cd my-app && pnpm install`. Open in VS Code, start a Cline chat and paste: "Read https://freeappstore.online/skills.md — then build me a [describe your app]". Guide: <https://freeappstore.online/ai/cline>

## GitHub Copilot
Scaffold: `fas init my-app && cd my-app && pnpm install`. Open in VS Code with Copilot Chat. Paste `@workspace Read https://freeappstore.online/skills.md` for context, then prompt your app. Run `fas check && fas publish` when done. Guide: <https://freeappstore.online/ai/github-copilot>

## Aider
```
fas init my-app && cd my-app && pnpm install
aider --read https://freeappstore.online/skills.md
```
Aider loads the platform guide as context. Describe your app and it edits the files. Run `fas check && fas publish` when done. Guide: <https://freeappstore.online/ai/aider>

## Continue (VS Code / JetBrains)
Scaffold: `fas init my-app && cd my-app && pnpm install`. Open in your IDE with Continue. Add `https://freeappstore.online/skills.md` as a context doc in Continue's settings. Prompt the build, then `fas check && fas publish`. Guide: <https://freeappstore.online/ai/continue>

## Zed
Scaffold: `fas init my-app && cd my-app && pnpm install`. Open in Zed, start the AI assistant, paste "Read https://freeappstore.online/skills.md" as context, then describe your app. Run `fas check && fas publish`. Guide: <https://freeappstore.online/ai/zed>

## ChatGPT (web)
Go to [chatgpt.com](https://chatgpt.com), paste the contents of `https://freeappstore.online/skills.md` into the chat, then describe your app. Copy the generated code into your scaffold (`fas init my-app`), run `fas check && fas publish`. Guide: <https://freeappstore.online/ai/chatgpt-web>

## VibeCode (no-install, browser)
No CLI needed. Go to [console.freeappstore.online/create](https://console.freeappstore.online/create), sign in with GitHub, describe your app, and the AI agent builds and deploys it for you.

---

**After publishing:** every `git push` to main auto-deploys. Your app is live at `my-app.freeappstore.online`.

**Need accounts or cloud storage?** Add `@freeappstore/sdk` — gives you GitHub auth, per-user KV, realtime rooms, and a secret-injecting API proxy. [SDK docs](https://github.com/freeappstore-online/platform/tree/main/packages/sdk#readme)

**Questions?** Ask in this channel or open an issue at [github.com/freeappstore-online/submissions](https://github.com/freeappstore-online/submissions/issues).
