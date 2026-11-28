# Microsoft Store submission copy

Prepared for [#808](https://github.com/freeappstore-online/platform/issues/808), under [#857](https://github.com/freeappstore-online/platform/issues/857). This is submission material, not a published listing or a certification result. Use the real reserved product identity and the verified production package from `desktop-store.yml`; the smoke package is never a submission candidate. Packaging and release requirements are in [SIGNING.md](SIGNING.md).

## Listing fields — English (United States)

**Product name:** FreeAppStore, subject to the actual name reservation.

**Suggested category:** Productivity.

**Price:** Free. The desktop companion has no purchase or subscription requirement. Separately installed AI clients and their model services may have their own costs and terms.

**Short description:**

Open free web apps in their own windows, keep favourite apps close, and connect an AI client on your PC. Optionally help community apps by generating narration on your computer.

**Description:**

FreeAppStore brings free web apps to your Windows desktop. Browse the catalogue, open apps in their own windows, and return quickly to your favourites and recently used apps.

Connect an AI client you already use, such as Claude Code or Claude Desktop, to work with apps that offer AI tools. Turn on Allow AI access in an app, then ask your AI client to list your open FreeAppStore apps or use the tools that app provides. Pause AI access whenever you want. A separate compatible AI client is required for this feature; FreeAppStore does not include an AI model subscription.

The connection between the desktop app and your AI client stays on your computer. Your AI client receives the data returned by tools and may send it to its model provider. Each app controls which tools it offers, and its own permissions and account requirements still apply.

Favourites, recently used apps and the AI activity list are saved on this computer across restarts and updates. Desktop app windows and your web browser keep separate copies of app data; these copies and your shortcuts do not automatically sync.

Contribute is optional. Connect your FreeAppStore account, choose the apps you want to help, and download the voice model to generate narration on your computer. You can see upcoming work, review completed attempts and turn contribution off. Generated audio is uploaded to FreeAppStore; accepted audio is published for others to use. Nothing is generated until you connect, choose apps and download the model.

Creators can also use Publish to work with local FreeAppStore projects. Choose a project folder, check it, and publish through the bundled FreeAppStore command-line tools using your GitHub sign-in.

FreeAppStore can keep running in the system tray after you close its window. Choose Quit from the tray menu to stop it. Manage startup in Windows Settings and receive this package's updates through Microsoft Store.

Internet access is needed to load the catalogue, open hosted apps and use online services. Basic catalogue browsing and shortcuts do not require a FreeAppStore account. Individual web apps, Contribute and publishing may require sign-in. The optional voice model downloads about 350 MB and occupies about 400 MB after installation; additional free space is required while installing it.

**Feature bullets:**

- Open FreeAppStore web apps in separate desktop windows.
- Keep favourite and recently used apps one click away.
- Connect compatible local AI clients to tools offered by enabled apps.
- Pause AI access and retain a local activity history.
- Optionally generate community narration using an on-device voice model.
- Check and publish projects from folders you choose.
- Control startup in Windows Settings and updates through Microsoft Store.

**Suggested search terms:** web apps; productivity; app launcher; favourites; local AI; MCP; narration.

**Additional requirements:** 64-bit Windows PC and internet access for hosted apps and online services. A separately installed compatible AI client is needed for AI connections. Contribute requires optional account connection and the voice-model download. Creator publishing requires a GitHub account; local repository operations require Git installed on the PC. The package currently declares minimum Windows version 10.0.17763.0; verify actual supported Windows 10/11 builds during certification rather than treating the manifest as compatibility-test evidence.

**What's new for the first Store submission:**

First Microsoft Store submission of the FreeAppStore desktop companion, including app windows, favourite and recent shortcuts, local AI connections, persistent AI activity, optional community narration, and creator publishing tools.

## Public links

| Field | Value |
|---|---|
| Website | https://freeappstore.online/ |
| Privacy policy | https://freeappstore.online/privacy |
| Support website | https://docs.freeappstore.online/devices/ |
| Support email | support@freeappstore.online |
| Account deletion help | https://freeappstore.online/delete-account |
| Terms | https://freeappstore.online/terms |

The support, privacy, deletion and terms URLs returned HTTP 200 when checked on 2026-11-28. The public privacy policy documents Store-managed updates: this package does not use the direct EXE/GitHub updater. Do not copy a test account password or secret into this file or a public issue.

## Restricted capability justification — runFullTrust

FreeAppStore is an Electron desktop application running as the signed-in Windows user. It needs runFullTrust for its desktop processes, tray lifecycle, local AI bridge, integration with installed AI clients, native narration engine, and user-selected creator projects. It does not require administrator elevation.

The AI bridge listens only on 127.0.0.1, using a local bearer credential for MCP requests. The HTTP MCP endpoint rejects browser-origin requests. Its separate web-app bridge checks the requesting FreeAppStore app origin. This is not a remotely accessible server. Users explicitly connect an installed AI client from Home; on Windows, that action adds a FreeAppStore MCP entry to the user's existing client configuration. Disconnect removes the entry. The app does not install an AI client or provide an AI service account.

Web apps run in isolated Electron renderer windows with application permission checks. The optional Publish feature launches bundled CLI code and local git operations for project folders the user chooses. It does not grant hosted web pages unrestricted filesystem or shell access. Contribute uses a bundled native inference engine and a separately downloaded voice/model data package; it does not install other native applications. Users choose whether to connect an account, download the model and enable contribution.

The startup task is disabled by default and controlled by Windows Settings. Microsoft Store manages updates for this package; the app disables its direct-download updater when running as a Store package. These desktop integrations and processes require the full-trust desktop application model rather than an AppContainer-only implementation.

## Notes for certification

**Access:** Catalogue browsing, opening public apps, favourites, recent apps and local AI setup require no FreeAppStore account. AI execution requires an installed compatible client with its own working account/configuration. Contribute requires a free FreeAppStore account and device approval in the browser. Publish has a separate GitHub device-code sign-in. If certification needs a supplied test account, prepare one and provide its access details only in Partner Center's private reviewer notes before submitting; no reviewer credentials have been created or supplied by this document.

1. Install the production Store package and launch FreeAppStore. Open Store, select a public app and confirm it opens in a separate window. Star an app, return Home and check Quick access. Open another app to populate recently used items. Restart the companion and check the shortcuts remain. Clear recently used and verify the favourite remains.
2. With Claude Code or Claude Desktop already installed/configured, open Home and choose Connect beside the detected client. Restart that client as instructed. In a FreeAppStore app that offers AI tools, turn on Allow AI access. Ask the client to list open FreeAppStore apps and perform a small operation supported by that app. The integration does not imply every catalogue app has AI tools. In Activity, confirm the call record appears. Pause AI access and confirm further tool calls return the paused result; resume to restore access.
3. Quit and reopen FreeAppStore. Confirm Activity retains metadata about calls, without storing tool inputs, results or app error text. Clear history removes the local records. Close only the main window and confirm the system-tray app remains available; use Quit in the tray to stop it fully.
4. For optional Contribute, connect a reviewer-owned free account in the browser and approve this computer. Choose an app with published work, download the model after viewing its size, and select Run now. Inspect the upcoming backlog and Activity. If no compatible jobs are currently published, the expected result is the explicit no-work state; do not substitute a simulated success. With work available, confirm a job generates and uploads, then turn Contribute Off. This stops future contribution until re-enabled. Sign out removes this device's local contribution history and opt-ins; accepted public audio is not removed by signing out.
5. For optional Publish, use a reviewer-controlled GitHub account and disposable project folder. Create/add a local project and run Check. Publishing and Push modify the reviewer's selected remote project and require the corresponding confirmation/actions; do not use a real user's project or publish unrelated material merely to verify the interface.
6. Confirm startup is controlled through Windows Settings, with the package task initially disabled. Verify updates come from Microsoft Store, not a downloaded NSIS installer. Install a subsequent Store version and confirm app data, favourites and activity survive. Recheck AI-client connections after the update because package installation paths may change; this update behavior still needs real Store testing.

## Submission completion evidence

Before final submission, record the real reserved identity/product ID, exact production package version and SHA-256, architecture, Windows versions tested, reviewer access, age/content-rating responses and screenshots from the actual Windows package. Capture Home/Quick access, Store, Activity and Contribute without personal account information, tokens or private app content. Do not use macOS screenshots as Windows evidence.

The Store account, identity variables, package submission, runFullTrust approval, certification, listing URL and installed-update verification remain separate milestones. This file does not assert any of them are complete. Publish the website's Store link only after its real destination and installation are verified.

Reference: Microsoft's [MSIX listing fields](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/add-and-edit-store-listing-info), [capability declarations](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations), and [notes for certification](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/manage-submission-options).
