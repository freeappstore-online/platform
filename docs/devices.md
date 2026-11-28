# Desktop and phone apps

FreeAppStore apps are web apps. You don't need anything else to use them. The desktop app and the phone apps are
optional extras for things a browser can't do well. This page says what each one does today, how to start, and what
to expect. Checked against the code and release channels on 2026-11-28 (#850, #857).

Where your data goes: [Desktop and phone apps: where data goes](device-data.md) and the
[privacy policy](https://freeappstore.online/privacy).

## Which one do I need?

| You want to | Use |
|---|---|
| Use an app | Your browser. [Install it](https://freeappstore.online/install) to your home screen, Dock or taskbar if you like |
| Let an AI app on your computer (Claude Code, Claude Desktop) work in your FreeAppStore apps | The **desktop app** |
| Keep recording a run with the phone locked (Run) | The **Android or iPhone app** |
| Help make an app's narration with your device | The **desktop app** or a **phone app** (or, on a computer, the console's Generate page) |

## What each one can do

| | Web (browser) | Desktop | Android | iPhone |
|---|---|---|---|---|
| How to get it | [freeappstore.online](https://freeappstore.online) | [Download](https://freeappstore.online/download): verified installers appear when available; Windows Store publication is being prepared | [Google Play internal testing](https://play.google.com/apps/internaltest/4701334236045250583), for invited testers | TestFlight is being prepared (#863); no tester download yet |
| Release status | Public | 1.0.0 for Mac and Linux; Windows Store pending | 0.2.0 (62), internal testing; not a public production release | 0.2.0 (55) signed; App Store Connect app record and upload pending |
| Minimum system | A current browser | What Electron 45 supports; 64-bit only | Android 10 | iOS 17 |
| Use apps | Yes | In their own windows | Opens them in the browser | Opens them in Safari |
| App data | In that browser | In the desktop app, separate from every browser | In the browser | In Safari |
| AI access to your apps | No (only through the desktop app) | Yes, on this computer | No | No |
| Background location for Run | No | No | Yes | Yes |
| Contribute (make narration) | The console's Generate page, signed in, in a desktop browser that encodes AAC (Chrome, Edge; not Firefox) | Yes | Yes | Yes |
| Contribute languages | English only | English, Spanish, Mandarin | English, Spanish, Mandarin | English, Spanish, Mandarin |
| Contribute in the background | While the tab stays open and the computer awake | While the app runs in the tray and the computer is awake | Yes, by default when plugged in on Wi-Fi | Only when iOS starts it: on power, with a network |
| Battery, heat and data conditions | No | Power, battery and heat; no mobile-data setting | Yes | Yes |
| Overnight summary | No | No | Yes | Yes |
| Pair a phone by QR code | Console: **Settings > Devices > Add a phone** | **Account > Add a phone** | Scanning: in progress (#845) | Scan or type the code |
| Updates | Prompted in each app | Mac: notification and download. Linux AppImage: in-app update. Windows Store builds: Store-managed | Google Play | TestFlight, once available |

Internal testing requires an invited account. Android is available to the configured internal testers; neither phone
app has a public production listing yet. The download page is the current source for available desktop installers.

## Desktop

**Quick access** on Home lists your **Favourites** and **Recently used** apps. Star an app in Store or
Quick access to pin it; click its name to open it. **Clear recently used** removes that history and
keeps your favourites. These shortcuts stay on this computer through restarts and updates.

### Install

Use [freeappstore.online/download](https://freeappstore.online/download). It shows only installers whose release
checks passed. Mac downloads require Developer ID signing and Apple notarization. Windows distribution is being
prepared through Microsoft Store. Follow the installation instructions beside the available download.

### Connect an AI app

1. On **Home**, click **Connect** next to **Claude Code** or **Claude Desktop**.
2. Start a new Claude Code session, or quit and reopen Claude Desktop.
3. Open an app (from **Store**, or in your browser with its **Allow AI access** on) and ask, for example, "list my
   open FreeAppStore apps".

Other AI apps: **Manual setup** on Home has the address and token.

The AI app gets what your apps' tools return. If it uses a cloud model, that data goes to its provider. **Pause AI
access** (Home or the menu-bar menu) stops every AI call until you resume.

### AI activity

**Activity** keeps the latest 1,000 AI calls on this computer across app restarts and updates. It records the time,
app, tool name and success or failure, without saving tool inputs, returned data or app error text. **Clear history**
deletes the local record. This history belongs to the computer, independently of your signed-in account.

### Account

**Sign in** (or **Connect this computer** on Contribute) opens your browser to approve this computer. The page still
says "phone"; that's expected. **Account** shows who you are signed in as, this build's version, **Add a phone**,
**Sign out** and **Delete account**. **Sign out** disconnects this computer and deletes its Contribute history,
kept audio and choices. The voice model stays until **Delete model**.

### Contribute

1. Connect this computer (above).
2. Open **Contribute**, turn on the apps you want to help, and **Download** the voice model (350 MB download, about
   400 MB on disk).
3. It runs one job from each app in turn, and looks again every 15 minutes when there is nothing to do.

**Auto** (the default), **Run now** and **Off** sit at the top of Contribute and in the tray. Off stops the job in
hand at once, and nothing starts again until you turn it back on, even after a restart. **History** lists every job this computer tried,
with **In progress** for the current one. Each item has the server's verdict, **Play** for its audio (20 newest),
**Good** / **Not good** with a note, and **Save record…** for bug reports.

**Up next · awaiting generation** shows up to 100 jobs available to your account, with the app,
chapter or job key, model and a short text preview. **Refresh backlog** updates the list without
starting work. Jobs are oldest first; other devices and your enabled apps can change what runs next.

In Auto it runs only while every condition in **When it runs** holds: on AC power (or on battery above a minimum,
40% by default), not hot, the computer not in use (no keyboard or mouse for 2 minutes; or run slower instead), within
the CPU level (Light / Balanced / Full), the optional daily maximum and quiet hours. A job at least 80% done finishes;
any other stops and is given back. The status says why it is paused. There is no mobile-data setting: a computer
can't reliably tell a metered connection. It does not keep the computer awake.

### What keeps running

| You | AI access | Contribute |
|---|---|---|
| Close the window | Keeps working (tray) | Keeps going |
| Choose **Quit** | Stops | Stops; the job in hand is given back later |
| Computer sleeps | Stops until it wakes | Stops; a job whose lease ran out is given back |
| Go offline | Local only, unaffected | Retries; a failed upload is given back |
| Crash or force quit | Stops | The next start marks the job interrupted |

## Phones

The Store opens with **Quick access**: favourites and recently opened apps, with **Open** buttons.
Star apps in the list or on their detail page. **Clear recently used** keeps favourites. Shortcuts are
stored on this phone, independently of pairing, and survive app updates. Opening an app still uses
your browser or Safari; viewing its details alone does not add it to Recently used.

The [website](https://freeappstore.online/) has the same quick access section and star controls. Its
shortcuts stay in that browser. None of these lists sync across devices or require sign-in; favourites
are separate from public votes and app permissions. Only apps opened through these controls enter
Recently used, not apps opened directly from a bookmark or Home Screen icon.

### Install

Android (10 and later): invited testers can opt in through [Google Play internal testing](https://play.google.com/apps/internaltest/4701334236045250583),
then install or update from Google Play using the invited Google account. The current tester list is limited; a public
production listing is still being prepared (#658).

iPhone (iOS 17 and later): TestFlight distribution is being prepared (#863). The signed build is ready, but its App
Store Connect app record, upload and tester availability are not complete. A TestFlight invitation will be provided
when it is available. Phone distribution uses these store channels.

### Connect

**Connect** in the app opens the browser to sign in and approve the phone. Or, on the iPhone, **Scan a code** (or
**Type the code**) shown by the console's **Settings > Devices > Add a phone** or the desktop's **Account > Add a
phone**. A code works once, for 5 minutes. Android scanning is in progress (#845).

A connection lasts 90 days. **Settings** shows the account, this phone's version, **Sign out** / **Disconnect** and
**Delete account**. Disconnecting deletes this phone's location points on the server, its sharing history, its
Contribute record, kept audio and choices.

### Location for Run

On **Sharing**, turn on Run and agree to its disclosure. Allow background location so it keeps going with the phone
locked. **Pause all**, or pause one app, stops sharing without deleting anything. See the
[privacy policy](https://freeappstore.online/privacy#companion).

### Contribute

1. Connect the phone.
2. On **Contribute**, turn on apps (gear icon) and download the voice model.
3. Choose **Auto** (runs by itself when its conditions hold), **Run now** (one run, ignoring most conditions) or
   **Off** (stops and stays off).

Conditions, in the gear's settings: Wi-Fi only or a monthly mobile-data allowance; charging only or a battery
minimum; pause when hot; what to do while you use the phone; CPU Light, Balanced or Full; daily maximums; quiet
hours. The status card always says why it is not running.

**Activity** lists every job the phone tried, with **In progress**, the verdict, **Play**, **Good** / **Not good**
and **Share record**. The **overnight summary** notification ("Generated 42 clips, 38 accepted…") can be turned off
in settings.

**Up next · awaiting generation** shows the next 100 available jobs with short text previews.
Tap **Refresh backlog** to check again. It includes apps you have not enabled; only enabled apps run,
and other devices can claim these jobs before your phone does.

### What keeps running

| | Android | iPhone |
|---|---|---|
| Phone locked | Contribute runs when its conditions hold; location keeps recording | Contribute only when iOS starts it; location keeps recording |
| Overnight | Runs while plugged in on Wi-Fi (defaults) | iOS decides if and when. Nothing is guaranteed overnight |
| **Run now** | Runs in the background with a notification | Needs the app on screen; leaving it hands over to background runs |
| Unplugged (charging only) | Stops, unless the job is 80% done | Stops, unless the job is 80% done |
| Offline | Retries for a short time; the job is given back later | Same |
| The system ends the run | The job in hand stops and is given back | The job in hand stops and is given back |
| Force stop / swipe away | Android runs none of its work until you open it again | iOS starts no background runs until you open it again |

## Contribute controls: what is enforced

Every limit is set and checked on the device; the server sets none per person (#830). **Hard**: our code or the
system applies it every time. **Best-effort**: it depends on a signal the device may not give, or gives late.
**None**: not offered there. No client promises an exact CPU percentage. Checked against the code on 2026-11-28
(#792).

| Control | Android | iPhone | Desktop | Browser (Generate page) |
|---|---|---|---|---|
| Per-app opt-in | Hard | Hard | Hard | Hard, in this browser |
| Off / Stop | Hard: stops the job in hand, cancels every schedule, survives restarts | Hard: same, cancels background requests | Hard: same | Stop is hard while the page is open |
| Wi-Fi only, or a monthly mobile-data allowance (model download and uploads counted on the device) | Hard for its own traffic, checked before each claim and download | Hard: each request refuses expensive and constrained networks unless allowed | None: a computer can't reliably tell a metered connection | None |
| Charging only, or a battery minimum | Hard: checked before each claim and between sentences | Hard for background runs (iOS starts them only on power when charging-only); the level is checked between sentences | AC power: hard. Battery minimum: best-effort (needs the level the system reports) | None |
| Low Power Mode | — | Hard: always pauses | — | None |
| Pause when hot | Best-effort: thermal status moderate or worse | Best-effort: thermal state serious or worse | Best-effort: macOS thermal state serious or worse, or a CPU speed limit under 100% where the system reports one | None |
| While in use: pause or run slower | Hard: screen on and unlocked | iOS runs background work only while the phone is not in use; Run now can run slower | Hard: keyboard or mouse in the last 2 minutes | None |
| CPU level (Light, Balanced, Full: threads and rests) | Hard | Hard | Hard | None (one Web Worker) |
| Daily maximum (jobs, minutes), quiet hours | Hard: checked before each claim and between sentences; the system picks start times | Hard: same; iOS picks start times | Hard | None |
| Jobs at once | One | One | One | One per browser profile |
| Bandwidth limit | None | None | None | None |
| Free storage for the voice model | Hard: the download waits for 1,751 MB free (the download, the unpacked model and 1 GB to spare) | Hard: same | Hard: same | Best-effort: the browser's storage estimate must hold the model; the browser may still evict it |
| Audio kept for playback | The 20 latest attempts | Same | Same | Same |
| Runs after you leave | When Android schedules it | Only when iOS starts it | While the app runs (tray) and the computer is awake | Only while the tab stays open and the computer is awake |

A failed condition stops the job in hand unless it is at least 80% done, and the server gives a stopped job back
(#841), so stopping never spends an allowance twice. The voice model downloads only after you ask for it or turn on
an app, whose confirmation names its size.

## When something looks wrong

| You see | Do this |
|---|---|
| "Choose the apps to generate for." | Turn on at least one app in Contribute |
| "No work for the apps you chose right now." | Nothing to do. It looks again every 15 minutes (desktop) or on its next run (phones) |
| An app is listed with a reason and can't be turned on | That app's voice or language isn't supported on this device. In the browser, only English works |
| "Download the voice model to start." | Download it on Contribute (desktop) or in the gear's settings (phones) |
| Phone says "Paused: …" or "Waiting: …" | That condition is holding it. Change it in settings, or use **Run now** |
| A job shows stopped, interrupted or lease expired | It was cut off. The server gives it back to you, or someone else takes it |
| A job failed with `network` | The upload kept failing until its time ran out. It is given back later |
| Asked to connect again | The connection expired, was revoked or the account was deleted. Connect again |
| "FreeAppStore isn't running." in your AI app | Open the desktop app |
| "FreeAppStore AI access is paused." | **Resume** on Home or in the menu-bar menu |
| AI app can't see an app | Open the app, turn on its **Allow AI access**, and ask again |

## Versions and support

- **Version**: desktop **Account > About**; phones **Settings > About**. A build shows `0.4.1 (57, abc1234)`
  (version, build, commit) or `(dev, …)` for a local build. The console's **Settings > Devices** lists each device
  with the version it last reported (Android does not report one yet).
- **Report a problem**: open an issue on [GitHub](https://github.com/freeappstore-online/platform/issues) or email
  support@freeappstore.online. Say which app and version. For a Contribute problem, attach the item's **Save record**
  (desktop), **Share record** (phones) or **Download record** (console) file. Check it first: it contains the job's
  text, your device details and, if kept, the audio. For a problem with Contribute as a whole, paste **Copy
  diagnostics** (Contribute settings on the phones and in the console, Contribute on the desktop): what the device can
  run and the 50 latest jobs' reasons and records, with no text, audio or sign-in details.

## Moving data between browser and desktop

The desktop app and each browser keep separate copies of app data. Nothing syncs them. Where an app offers backup
export and import (`@freeappstore/sdk/backup`), export a file in one and import it in the other.

## Related

- [Native companion protocol](native-companion.md), [Community generation](community-generation.md),
  [Versioning](versioning.md), [MCP: local AI access](mcp.md#local-ai-access-to-app-data-freeappstore-desktop)
- [Desktop and phone roadmap](roadmap.md)
- Open work: web and native identity on iPhone (#724), language parity (#837), first native releases (#846)
