# Desktop and phone apps

FreeAppStore apps are web apps. You don't need anything else to use them. The desktop app and the phone apps are
optional extras for things a browser can't do well. This page says what each one does today, how to start, and what
to expect. Checked against the code on 2026-11-27 (#850).

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
| How to get it | [freeappstore.online](https://freeappstore.online) | [Download](https://freeappstore.online/download): Mac, Windows, Linux preview | No public download yet. Built from source; Play testing is being prepared (#658) | No public download. Developers install it from Xcode; no TestFlight |
| Released | Yes | 0.4.1 preview, unsigned | No release yet (#846) | No release yet (#846) |
| Minimum system | A current browser | What Electron 45 supports; 64-bit only | Android 10 | iOS 17 |
| Use apps | Yes | In their own windows | Opens them in the browser | Opens them in Safari |
| App data | In that browser | In the desktop app, separate from every browser | In the browser | In Safari |
| AI access to your apps | No (only through the desktop app) | Yes, on this computer | No | No |
| Background location for Run | No | No | Yes | Yes |
| Contribute (make narration) | The console's Generate page, signed in, in a desktop browser that encodes AAC (Chrome, Edge; not Firefox) | Yes | Yes | Yes |
| Contribute languages | English only | English, Spanish, Mandarin | English, Spanish, Mandarin | English, Spanish, Mandarin |
| Contribute in the background | While the tab stays open and the computer awake | While the app runs in the tray and the computer is awake | Yes, by default when plugged in on Wi-Fi | Only when iOS starts it: on power, with a network |
| Battery, heat and data conditions | No | No (it runs while not paused) | Yes | Yes |
| Overnight summary | No | No | Yes | Yes |
| Pair a phone by QR code | Console: **Settings > Devices > Add a phone** | **Account > Add a phone** | Scanning: in progress (#845) | Scan or type the code |
| Updates | Prompted in each app | Windows and Linux update themselves. Mac: the app tells you and opens the download | n/a | n/a |

"Released" means you can install it without building it. Features in a phone column are in the code; neither phone
app has had a public release.

## Desktop

### Install

Download from [freeappstore.online/download](https://freeappstore.online/download). The builds are not signed yet,
so macOS and Windows warn the first time; the download page has the steps.

### Connect an AI app

1. On **Home**, click **Connect** next to **Claude Code** or **Claude Desktop**.
2. Start a new Claude Code session, or quit and reopen Claude Desktop.
3. Open an app (from **Store**, or in your browser with its **Allow AI access** on) and ask, for example, "list my
   open FreeAppStore apps".

Other AI apps: **Manual setup** on Home has the address and token.

The AI app gets what your apps' tools return. If it uses a cloud model, that data goes to its provider. **Pause AI
access** (Home or the menu-bar menu) stops every AI call until you resume.

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

### Install

There is no public download yet. Android builds come from `android/` (Android 10 and later); Play testing is being
prepared (#658). The iPhone app is installed by a developer from Xcode (`ios/`, iOS 17 and later). First releases:
#846.

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
