# Google Play: top simple apps FAS can build

**Date:** 2026-10-15 · **Scope:** Google Play, all non-game categories · **Audience:** FAS catalogue planning

> Revised 2026-10-15: corrected notification/push capability (PWAs support Web Push incl. iOS 16.4+ home-screen apps).

## Summary

The top of Google Play is dominated by apps FAS can't touch: preinstalled Google/OEM system apps, banking and payments, streaming, social networks, and a big group of OS-hook utilities (cleaners, VPNs, antivirus, app lockers, launchers, keyboards). Below that layer sits a large group of **single-purpose utilities with 10M to 1B+ installs and very high ratings**. These include calculators, notes, QR scanners, weather, timers, document scanners, PDF tools, photo collage, period trackers, home workouts, tuners, virtual instruments, voice changers and converters. Most of them are client-side apps wrapped in ads, upsells or tracking SDKs. That is exactly the gap FAS targets: the same app, free, open source, with no tracking. Of the ~40 archetypes ranked below, about two thirds are "Easy" (a solo dev can ship a solid version in days). The rest are "Medium" because of bundle size (pdf.js, OCR), content (exercise media, food database) or sync/sharing logic. **Reminders are buildable**: an installed FAS PWA can receive Web Push notifications (Android Chrome/Firefox, desktop, and iOS/iPadOS 16.4+ Home Screen apps), so water, medication, prayer-time, habit, fasting and due-date reminders all fit. What does not fit is **alarm-clock behaviour**: ringing loudly through a locked phone or silent mode, or a guaranteed exact-second wake.

## Methodology

- **Install tiers, ratings and review counts** were pulled on 2026-10-15 from each app's public Google Play listing (`play.google.com/store/apps/details?id=…&hl=en_US&gl=US`). Play shows install *tiers* (e.g. 100,000,000+), not exact counts. Review counts are Play's rounded figures.
- **Category "most installed" rankings** came from AndroidRank (Tools, Productivity, Health & Fitness, Music & Audio, Finance, sorted by installs), plus AppBrain's current Top Free Tools chart (US) for what is trending now.
- **Context:** the Wikipedia list of most-downloaded Google Play apps (snapshot as of 10 Aug 2024) for the 1B+/500M+ utility tier. Many entries there are preinstalled on Samsung, Xiaomi, Transsion and Motorola phones, which inflates their numbers. FoxData estimates the **Tools category at ~12.46B Google Play downloads in 2025**, the largest category. This is a third-party estimate, and AppTweak's figure using a different method is much lower.
- **Ranking order** combines the highest install tier reached by an *independent* (non-preinstalled) app in the archetype, how many apps in the archetype reach 10M+/100M+, and review volume. Preinstalled OEM apps (e.g. Samsung Calculator, Google Clock, Xiaomi Weather) count as weaker evidence of demand. **The ordering is a judgement call, not a measured metric.**
- **Buildability** is assessed against FAS constraints: client-side PWA, ≤300 KB gzip largest JS bundle, offline, no tracking, SDK primitives only, no uploads/server compute/payments/native hooks.
- **Capabilities counted as available:** every FAS app is an installable PWA with a service worker, so **Push notifications (Web Push)** (`PushManager.subscribe()`, delivered even when the app is closed; iOS/iPadOS 16.4+ for Home Screen apps), local notifications (`ServiceWorkerRegistration.showNotification`) and **Badging** (`navigator.setAppBadge`) are in scope. The platform already sends VAPID web push in production. `@freeappstore/sdk` has no documented `fas.push` helper yet, so an app uses the standard Web Push API with its own VAPID key, and a timed reminder needs something to send the push at the right time. **Recommendation:** a first-class `fas.push` / scheduled-send primitive (the platform already has `sendWebPush`) would make reminder apps trivial.

## Ranked archetypes

Legend: **KV** = per-user KV; **Coll** = shared collections; **RT** = realtime rooms; **Ctr** = shared counters; **Vault** = user-owned API key vault; **Proxy** = secret-injecting proxy.

| Rank | App archetype | Example top apps (Play, 2026-10-15) | Why it's popular | FAS buildability | FAS features used | Caveats |
|---|---|---|---|---|---|---|
| 1 | **Basic calculator (with history)** | Google Calculator 1B+ (4.3★, 795K reviews); Samsung Calculator 1B+ (AndroidRank); ClevCalc 100M+ (4.6★, 1.23M); Calculator Plus 50M+ (4.9★, 920K) | Used daily by everyone. OEM calculators are bare-bones, third-party ones add history, unit and percent tools | Easy | KV (history sync), offline | Very crowded. Win on "no ads + history + dark mode". Big install numbers are inflated by preinstalls |
| 2 | **Notes / notepad / checklists** | Google Keep 1B+ (4.7★, 2.62M); Samsung Notes 1B+ (AndroidRank); "Notepad – Notes, Todo, Memo" 500M+ (AndroidRank); ColorNote 100M+ (4.9★, 3.97M) | Universal need. ColorNote shows a simple colored-note app can get to 100M+ | Easy | Auth, KV (sync), Tiptap, offline | KV cap 1 MB/user, 100 keys: shard notes into ≤100 keys or keep the full archive in IndexedDB and sync a subset. No image attachments (no file storage) |
| 3 | **QR & barcode scanner / generator** | QR & Barcode Scanner (Gamma Play) 500M+ (4.8★, 4.75M), and #20 on AppBrain's current US Tools chart; "QR code reader & QR code Scanner" 100M+ and "QR Code Scanner & Scanner App" 100M+ (AndroidRank) | Payments, menus, Wi-Fi, tickets. Many scanner apps are ad-heavy or malware-adjacent | Easy | Camera, qrcode lib (generate), KV (history) | Native `BarcodeDetector` only on Android Chrome. iOS Safari needs a JS/WASM decoder (jsQR, zxing-wasm), so watch bundle size and lazy-load it. "Open URL" safety warnings are a selling point |
| 4 | **Weather** | Weather by Xiaomi 1B+ (4.1★, preinstalled); The Weather Channel 100M+ (4.6★, 3.61M); AccuWeather 100M+ (3.6★, 2.57M); 1Weather 100M+ (4.3★, 1.11M) | Checked daily. Big incumbents are ad-heavy and have a history of location-data monetization | Easy | Open-Meteo, Nominatim (place search), geolocation, Recharts, Leaflet | No home-screen widget. Severe-weather alerts can go out as Web Push, but need a scheduled forecast check to trigger them. Radar overlay needs a tile source outside the listed APIs |
| 5 | **Clock tools: stopwatch, timer, world clock** | Google Clock 1B+ (3.9★, preinstalled); Stopwatch Timer (Hybrid) 10M+ (4.5★, 249K); Stopwatch & Timer (Zaba) 10M+ (4.5★, 84K); Multi Timer 1M+ | Cooking, workouts, interval timing, time zones | Easy | Offline, Wake Lock, Web Audio, vibration (Android), REST Countries / Intl for zones, notifications (`showNotification`), Web Push | A finished timer can raise a notification, and a Web Push covers the app being closed. **Alarm-clock behaviour is not feasible**: a notification is not an alarm, so it won't ring loudly through a locked phone or silent mode |
| 6 | **Document scanner → PDF** | CamScanner 500M+ (4.6★, 5.06M); Adobe Scan 100M+ (4.6★, 3.04M) | Receipts, forms, homework. CamScanner was pulled from Play in 2019 over a malicious ad SDK (widely reported), which shows the trust problem | Medium | Camera, canvas (edge detect/perspective crop, B&W filter), jsPDF, file save/share | Everything stays on device. OCR is the hard part: tesseract.js language data is many MB and must be a lazy-loaded asset, not bundle code. AI OCR is possible via **Vault** (user's own key). No cloud storage |
| 7 | **PDF reader / PDF tools (merge, split, sign)** | Adobe Acrobat Reader 500M+ (4.5★, 8.03M); MobiOffice 100M+ (4.6★, 1.5M); Xodo 10M+; five "PDF Reader" apps in AppBrain's current US Tools top 10 | Everyone gets PDFs. Most top-chart PDF apps are thin wrappers full of ads | Medium | File picker, pdf.js (view), pdf-lib (merge/split/sign), offline | pdf.js worker is large (estimate: ~300 KB+ gzip), so it must load as a separate lazy chunk to stay inside the bundle rule. Local files only |
| 8 | **Photo editor / collage maker** | Picsart 1B+ (3.9★, 12.1M); Collage Maker 100M+ (4.9★, 3.67M); PicCollage 100M+ (4.7★, 1.81M); Photoshop Express 100M+ (4.5★, 2.6M) | Social posting. Collage grids, crop, filters, text and stickers | Medium (collage/crop/filters/text); not feasible for AI features | File picker, canvas/WebGL filters, download/Web Share | No server-side AI (background removal etc.). Could offer it through **Vault**, or a small on-device model as a lazy asset. Export via download or share sheet, not "save to gallery" |
| 9 | **Period / cycle tracker** | Flo 100M+ (4.7★, 5.14M); Period Calendar 100M+ (4.9★, 4.89M); Clue 50M+ (AndroidRank) | Very high engagement. **Privacy is a real differentiator**: Flo settled with the US FTC in 2021 over sharing health data with third parties | Easy | KV (encrypted client-side), offline, Recharts, Web Push (period-due / pill reminders) | Prediction must stay simple and honest (average cycle length). Keep push payloads generic ("Check your calendar") so nothing sensitive shows on the lock screen. Encrypt data before it reaches KV |
| 10 | **Home workout / bodyweight routines** | Home Workout – No Equipment 100M+ (4.9★, 4.04M); Six Pack in 30 Days 100M+ (4.93★); Lose Weight App for Men 100M+ (4.93★) (all Leap Fitness, AndroidRank) | Free, guided, no gym. Leap Fitness has several 100M+ titles from one template | Medium | Offline, Web Speech (TTS cues), timers, KV (progress), Wake Lock | The value is partly **content**: exercise illustrations/animations must be original or openly licensed (e.g. CC-licensed open exercise databases). Keep animations as SVG/CSS so the app stays offline and small |
| 11 | **Voice changer** | Voice changer with effects 100M+ (4.6★, 1.48M) | Fun, shareable clips | Easy | Mic, MediaRecorder, Web Audio (pitch, robot, echo, reverb), share/download | Pitch shifting without changing speed needs a small DSP lib. iOS records AAC/MP4, so handle codecs |
| 12 | **Flashlight** (borderline) | Tiny Flashlight 100M+ (4.4★, 4.05M); "Flashlight" 100M+ (4.77★, AndroidRank); Brightest Flashlight 50M+ (4.5★, 1.27M) | Huge historic demand. Classic home of over-permissioned adware | Easy, **Android Chrome only** | Camera track `torch` constraint, screen-light fallback | Torch control via `MediaStreamTrack.applyConstraints({advanced:[{torch:true}]})` works on Android Chrome only. **iOS Safari cannot turn on the LED**, so it falls back to a white screen. Modern phones have a built-in toggle anyway. Low priority |
| 13 | **Instrument tuner** | GuitarTuna 100M+ (4.5★, 2.67M); Tuner – Pitched! 1M+ (4.7★, 34K) | Every guitarist, ukulele and violin player | Easy | Mic, Web Audio (autocorrelation/YIN pitch detection), offline | Turn off `echoCancellation`/`noiseSuppression`/`autoGainControl` in the mic constraints. GuitarTuna's lessons/songs are content, so leave them out |
| 14 | **Virtual piano / keyboard** | Perfect Piano 100M+ (4.2★, 1.02M); Mini Piano Lite 10M+ (4.7★, 57K) | Kids, beginners, playing for fun | Easy | Web Audio (synth or small sample set), multitouch, offline | Audio latency on some Android devices. Samples must be CC0/own. Ship a synth fallback to stay small. Not a rhythm game (that's games) |
| 15 | **Drum pad / beat maker** | Drum Pad Machine 100M+ (4.3★, 1.05M); Drum Pads 24 10M+ | Music making without gear | Medium | Web Audio scheduler, multitouch, KV (saved patterns), Coll (share patterns) | Sample packs are the product, so you need CC0/self-made kits, cached for offline (size). Licensed packs are not an option |
| 16 | **Drawing / sketch pad** | ibis Paint X 100M+ (4.5★, 3.01M); Sketchbook 100M+ (4.1★, 707K) | Doodling, kids, digital art | Easy (simple), Medium (layers/brushes) | Canvas, Pointer Events (pressure), download PNG, offline | No cloud gallery (no file storage). Small drawings could be stored as vector strokes in KV/Coll within the 64 KB doc limit |
| 17 | **Calorie / food log** | MyFitnessPal 100M+ (4.4★, 2.92M); Yazio 50M+; fatsecret 50M+ (AndroidRank) | Weight loss is a perennial goal | Medium | Barcode scan, KV (log), Recharts, food data via Open Food Facts (free, no key; *not on the FAS list, verify CORS/rate policy*) | The food database is the moat: Open Food Facts coverage varies by country. Photo-based AI logging only via **Vault** |
| 18 | **Prayer times & Qibla compass** | Muslim Pro 100M+ (4.1★, 1.92M); Athan 10M+ (4.9★, 333K); Digital Tasbeeh Counter 10M+ (4.9★, 102K) | Daily use by a very large audience. Muslim Pro faced reporting in 2020 that its location data reached a data broker, so **privacy is a strong pitch** | Easy | Local calculation (adhan-js), geolocation, DeviceOrientation (Qibla), offline, Web Push (prayer-time alerts) | Prayer-time alerts, the incumbents' main feature, are delivered by Web Push at the computed times; a full adhan recitation playing through a locked phone is alarm behaviour and won't happen. Quran text is public domain, but recitation audio is licensed content |
| 19 | **GPS map / timestamp camera** | GPS Map Camera 100M+ (3.6★, 390K); "GPS Camera with Time Stamp" on AppBrain's current US Tools chart (#21) | Field workers, contractors and inspectors proving where and when a photo was taken | Easy | Camera, geolocation, Nominatim (reverse geocode), canvas overlay, download | Photos are saved by download/share, not straight to the gallery. A map thumbnail needs tile rendering into a canvas; respect the OSM tile usage policy. Writing EXIF needs a small lib |
| 20 | **Voice recorder** | Voice Recorder (bestrecorder) 50M+ (4.9★, 1.28M); Easy Voice Recorder 50M+ (4.7★, 624K); Samsung Voice Recorder 1B+ (preinstalled) | Lectures, meetings, memos | Easy | Mic, MediaRecorder, IndexedDB, download/share | Recording stops when the screen locks or the tab goes to the background (especially iOS). Local storage only. Transcription only via **Vault** |
| 21 | **Scientific / graphing calculator** | Scientific calculator plus 991 50M+ (4.8★, 563K); Desmos 10M+ (4.6★); GeoGebra 10M+ (4.3★) | Students. School exam-style calculators | Easy (scientific), Medium (graphing) | Offline, math.js or a custom parser, canvas plotting | Full math.js is close to the bundle budget, so import only the parts you need. Desmos is already free and excellent (no ads), so a FAS version's edge is smaller |
| 22 | **Resume / CV maker** | Resume – Intelligent CV maker 50M+ (4.5★, 547K) | Job seekers, especially in emerging markets | Easy | Forms, templates, jsPDF, KV (drafts), **Vault** (optional AI rewrite) | Template quality decides success. Keep jsPDF fonts small. Store only one or two resumes per user within KV limits |
| 23 | **Intermittent fasting tracker** | Fasting – Intermittent Fasting 50M+ (4.8★, 979K); BodyFast 10M+ (4.6★, 370K) | Popular diet trend. The app is essentially a timer plus a log | Easy | KV, Recharts, offline, Web Push ("fast complete" / eating-window alerts) | The timer is computed from a start time, so no background process is needed. Window alerts go out as Web Push at the end time |
| 24 | **Dictionary / word of the day** | Merriam-Webster 50M+ (3.6★, 519K); Dictionary.com 10M+ (4.0★, 968K); Vocabulary – Learn words daily 5M+ (4.5★, 113K) | Students, ESL learners, word nerds. Incumbents rate poorly because of ads | Easy | dictionaryapi.dev, Wikipedia, KV (saved words), Web Speech (pronunciation) | Lookups need a network connection. Offline works only for cached or saved words. "Word of the day" needs a curated local list |
| 25 | **Budget / expense tracker** | Money Manager 10M+ (4.6★, 467K); Wallet 10M+ (4.6★, 387K) | Personal finance without bank linking | Easy | KV (or Coll for household), Recharts, exchange rates, CSV export, offline | No bank sync (no server compute/aggregators). Long histories approach the 1 MB KV cap, so roll up by month |
| 26 | **Water intake tracker + reminders** | Water Reminder 10M+ (4.8★, 410K) | Hydration goals. The app is named for its reminders | Easy | KV (log), Recharts, offline, Web Push (scheduled reminders), Badging (glasses left today) | Reminders at the user's chosen interval via Web Push. Respect quiet hours |
| 27 | **Group bill splitting** | Splitwise 10M+ (4.0★, 195K); tricount 10M+ (4.8★, 196K); Splid 1M+ (4.9★, 87K) | Trips, flatmates. Splitwise's lower rating reflects user frustration with free-tier limits (*per user reviews; verify*) | Medium | Auth, friends, Coll (group ledger), RT (live updates), exchange rates, email (invites) | Uses FAS backend primitives well. No payments: "settle up" is a record only. Conflict handling for concurrent edits |
| 28 | **Currency converter** | Currency Converter Plus 10M+ (4.7★, 233K); Easy Currency Converter 10M+ (4.7★, 116K); XE 10M+ (4.5★, 401K) | Travel, online shopping, remittances | Easy | Exchange-rate API, REST Countries (flags), offline last-known rates | Rates are daily, not real-time. Label them clearly |
| 29 | **Unit converter** | Unit Converter (Smart Tools) 10M+ (4.4★, 222K) | Cooking, DIY, students | Easy | Offline only | Commodity. Win on breadth plus speed plus no ads |
| 30 | **To-do list + Pomodoro focus timer** | Google Tasks 10M+ (4.6★, 611K); Microsoft To Do 10M+ (4.6★, 483K); TickTick 10M+ (4.6★, 166K); Focus To-Do 10M+ (4.6★, 287K) | Productivity basics | Easy (solo), Medium (shared lists) | KV, Coll + RT (shared lists), Web Audio (timer chime), Wake Lock, Web Push (due dates), Badging (open-task count) | Due-date reminders via Web Push. The Pomodoro chime plays while the tab is open; a notification marks the end otherwise |
| 31 | **Mood journal / diary** | Daylio 10M+ (4.7★, 463K); Diary with Lock 10M+ (4.8★, 409K) | Mental-health self-tracking, private journaling | Easy | KV (client-side encrypted), Recharts, Tiptap, offline | "Lock" means a passphrase plus client-side encryption, not OS biometrics. No photo attachments |
| 32 | **Habit tracker** | HabitNow 5M+ (4.7★, 93K); Loop Habit Tracker 5M+ (4.7★, 63.5K) | Self-improvement streaks | Easy | KV, Recharts, friends + Ctr (accountability streaks), offline, Web Push (daily nudge), Badging | Loop is already open source and ad-free, so the FAS version's edge is web plus multi-device sync. Daily nudges via Web Push |
| 33 | **Medication / pill reminder + health log (BP, weight)** | Medisafe 5M+; MyTherapy 5M+; Blood Pressure Diary 1M+ (4.8★, 128K) | Chronic conditions, carers, doctor visits. Med reminders are the core value of the first two | Easy | KV (client-side encrypted), Recharts, jsPDF (report for the doctor), Web Push (dose reminders), Badging (doses due) | A missed push must never be the only safeguard: show "doses due" on open and say so plainly. Keep push text generic on the lock screen |
| 34 | **Sound level meter (dB)** | Sound Meter (gamebasic) 10M+ (4.5★, 186K); Sound Meter (Smart Tools) 10M+ (4.4★, 205K) | Noise complaints, workplaces, curiosity | Easy | Mic, Web Audio analyser, Recharts | Readings are uncalibrated estimates (the same is true of native apps). Disable AGC/noise suppression |
| 35 | **Metronome** | Metronome Beats 10M+ (4.7★, 183K); Easy Metronome 1M+ (4.9★) | Musicians practising | Easy | Web Audio lookahead scheduling, offline, vibration (Android) | Must use the Web Audio clock, not `setInterval`. Background playback is unreliable on iOS |
| 36 | **Compass, bubble level, ruler** | Digital Compass 10M+ (4.7★, 626K); Bubble Level (Gamma Play) 10M+ (4.7★, 335K); Ruler 10M+ (4.3★, 115K) | DIY, hiking, hanging pictures | Easy | DeviceOrientation/DeviceMotion, geolocation, offline | iOS needs an explicit motion permission prompt and uses `webkitCompassHeading`. Compass accuracy varies. A ruler needs on-screen calibration (credit-card trick). Camera AR measuring is not feasible |
| 37 | **GPS speedometer / odometer** | Speedometer: GPS Speedometer 10M+ (4.5★, 175K) | Drivers, cyclists, runners | Easy | Geolocation (`speed`), Wake Lock, Leaflet (trip map) | Foreground only, so the screen must stay on. No background trip logging |
| 38 | **Magnifier & mirror** | Magnifier & Microscope [Cozy] 10M+ (4.7★, 126K); Mirror Plus 10M+ (4.8★, 392K) | Elderly users reading small print; make-up | Easy | Camera (zoom/torch constraints on Android), canvas contrast filters | Optical zoom/torch control is Android Chrome only. iOS gets digital zoom only |
| 39 | **Counters: tally, tasbeeh, score keeper, chess clock** | Digital Tasbeeh Counter 10M+ (4.9★, 102K); Chess Clock 10M+ (4.6★, 25K); Tally Counter 500K+; Score Counter 500K+ (4.9★) | Prayer counting, board games, inventory, events | Easy | KV, Ctr (shared tallies), RT (live shared scoreboard), vibration (Android) | Vibration API is missing on iOS Safari. Shared live scoreboards are a real edge over native apps |
| 40 | **Randomizers: spin the wheel, dice, coin, picker** | Spin The Wheel – Random Picker 10M+ (4.8★, 150K) | Classrooms, groups, streamers | Easy | Offline, `crypto.getRandomValues`, RT (group spin everyone sees) | Commodity. The social room is the hook |
| 41 | **Sleep sounds / white noise / breathing / meditation timer** | BetterSleep 10M+ (4.3★, 397K); Insight Timer 10M+ (4.7★); Sleep Sounds 5M+ (4.8★, 214K); White Noise Lite 5M+ (4.5★); Breathe 1M+ (4.9★) | Sleep, focus, anxiety relief | Easy | Web Audio (procedural white/pink/brown noise, tones), timers, offline | Calm/Headspace-style guided content is out (licensed). Long playback with the screen locked is unreliable in iOS PWAs. Use procedural audio to avoid big files |
| 42 | **Shared grocery / shopping list** | Listonic 10M+ (4.6★, 318K); AnyList 1M+ (4.9★, 30.8K) | Households shop together | Easy–Medium | Auth, friends, Coll + RT (live sync), offline queue | 10k docs × 64 KB is plenty. Needs offline edit merging |

### Further candidates (lower demand evidence, all Easy unless noted)

- **Periodic table**: Periodic Table 2026 10M+ (4.8★, 433K). Static data, offline.
- **Stylish text / fancy fonts generator**: Stylish Text 10M+ (4.3★, 236K). A copy-paste Unicode generator is feasible. The *keyboard* part is not.
- **Flashcards / spaced repetition (Medium)**: AnkiDroid 10M+ (4.8★, 166K), Quizlet 50M+ (content/network effect). SRS plus Coll-shared decks. No image uploads.
- **Age / date / countdown calculator**: Age Calculator 5M+ (4.7★, 177K); Time Until 5M+ (4.6★). Much of the latter's value is its widget, which is not feasible.
- **Invoice / estimate maker**: Invoice Simple 5M+ (4.8★, 172K). jsPDF plus SDK email to send. No payment collection.
- **Gym workout log**: Hevy 5M+ (4.9★, 278K); FitNotes 1M+ (4.8★). KV plus Recharts.
- **Car fuel / expense log**: Fuelio 5M+; Drivvo 5M+.
- **Baby tracker**: Baby Tracker – Newborn Log 1M+ (4.9★, 72K). Coll shared between parents.
- **Loan/EMI and tip calculators**: EMI Calculator 5M+; Tip Calculator 500K+.

## Not buildable on FAS (and why)

These look simple and have huge installs, but fail the constraints:

- **Phone cleaners / junk removers / "booster" apps** (AppBrain's current US Tools chart is full of them, e.g. Cleanup 33M installs, CCleaner 100M+). They need filesystem and process access a browser can't have, and their value is largely illusory anyway.
- **VPN / proxy apps** (Turbo VPN 500M+, Proton VPN 100M+, 1.1.1.1 100M+). They need the OS VPN service and server infrastructure.
- **Antivirus / mobile security** (AVG 100M+, Avast One 100M+, Norton 100M+). These need OS-level scanning.
- **App lockers / calculator vaults** (AppLock 100M+, HideU Calculator Lock 100M+). They need accessibility or usage-access hooks and the ability to hide other apps.
- **Launchers & home-screen customisation** (Nova Launcher 100M+, HiPhone Launcher 100M+, live wallpapers 100M+). These need launcher replacement, widgets or wallpaper APIs.
- **Keyboards** (Gboard 10B+, SwiftKey 1B+, Emoji keyboard 100M+). These need a system input method.
- **Offline file transfer (SHAREit 1B+, Xender 500M+, ShareMe 1B+)**. They work over Wi-Fi Direct/hotspot with no internet. A WebRTC "PairDrop-style" version using FAS realtime rooms for signalling is *partly* possible, but it needs internet plus STUN/TURN. FAS provides no TURN relay, so transfers fail behind strict NATs. A weak substitute.
- **Screen recorder** (Screen Recorder 100M+, Mobizen 100M+). `getDisplayMedia` is not available in mobile browsers.
- **Alarm clock** (e.g. Alarmy). A web app can notify at a set time via Web Push, but a notification is not an alarm: it can't ring loudly with sound while the phone is locked, override silent mode, or guarantee an exact-second wake. Those are what an alarm clock is for.
- **Step counter / pedometer** (Step Counter – Pedometer 100M+, Sweatcoin 100M+). Needs background sensor access. Motion events only arrive while the page is open.
- **Run/ride GPS tracking** (Strava 100M+, adidas Running 50M+). Needs background geolocation while the screen is off. A foreground-only tracker is possible but frustrating.
- **Sleep tracking** (Sleep Cycle 10M+). Needs all-night mic and motion sensing in the background.
- **Caller ID / call blocking / call recorder** (Truecaller 1B+). Needs system telephony hooks and a crowd-sourced number database.
- **Sticker maker for WhatsApp / status saver / video downloader** (Sticker maker 100M+, Status Saver 100M+, All Video Downloader 100M+). Needs native intents to WhatsApp, or access to other apps' storage. Downloaders also raise ToS and copyright issues.
- **Auto clicker / assistive touch** (Auto Clicker 100M+, Assistive Touch 100M+). Needs accessibility services.
- **TV remotes** (Universal TV Remote 36M on AppBrain). Need an IR blaster or LAN device discovery, which browsers lack.
- **Wi-Fi tools / file recovery / device info** (WiFi Master 100M+, WPS testers 100M+, DiskDigger 100M+, CPU X 10M+). Need radio, raw storage or system APIs.
- **Speed test** (Speedtest by Ookla 100M+, 4.6★, 1.49M). Needs dedicated measurement servers. Not in FAS's free-API set, and no server compute.
- **Translator** (Google Translate 1B+, Microsoft Translator 100M+). The value is server-side ML. A **Vault**-based version (user's own LLM key) is possible but is not "simple, free" for most users, and camera/offline translation is out.
- **Music ID** (Shazam 500M+). Needs a fingerprint database and server matching.
- **Authenticator / password manager** (Google Authenticator 100M+, Bitwarden 5M+). TOTP itself is easy client-side. But storing 2FA seeds and passwords in a web origin, synced through KV, is a security-critical product where a "built in days" version is irresponsible. Not recommended.
- **Content-library apps**: Duolingo 500M+, YouVersion Bible 100M+, Calm 50M+, Quizlet 50M+, music streaming. The value is licensed or curated content or a network effect, not code.

## Sources

Google Play listings (installs/rating/reviews read 2026-10-15, en_US):
- https://play.google.com/store/apps/details?id=com.google.android.calculator
- https://play.google.com/store/apps/details?id=com.dencreak.dlcalculator
- https://play.google.com/store/apps/details?id=com.digitalchemy.calculator.freedecimal
- https://play.google.com/store/apps/details?id=com.google.android.keep
- https://play.google.com/store/apps/details?id=com.socialnmobile.dictapps.notepad.color.note
- https://play.google.com/store/apps/details?id=com.gamma.scan
- https://play.google.com/store/apps/details?id=com.miui.weather2
- https://play.google.com/store/apps/details?id=com.weather.Weather
- https://play.google.com/store/apps/details?id=com.accuweather.android
- https://play.google.com/store/apps/details?id=com.handmark.expressweather
- https://play.google.com/store/apps/details?id=com.google.android.deskclock
- https://play.google.com/store/apps/details?id=com.hybrid.stopwatch
- https://play.google.com/store/apps/details?id=com.zabamobile.sportstimerfree
- https://play.google.com/store/apps/details?id=com.digitalchemy.timerplus
- https://play.google.com/store/apps/details?id=com.intsig.camscanner
- https://play.google.com/store/apps/details?id=com.adobe.scan.android
- https://play.google.com/store/apps/details?id=com.adobe.reader
- https://play.google.com/store/apps/details?id=com.mobisystems.office
- https://play.google.com/store/apps/details?id=com.xodo.pdf.reader
- https://play.google.com/store/apps/details?id=com.picsart.studio
- https://play.google.com/store/apps/details?id=photoeditor.layout.collagemaker
- https://play.google.com/store/apps/details?id=com.cardinalblue.piccollage.google
- https://play.google.com/store/apps/details?id=com.adobe.psmobile
- https://play.google.com/store/apps/details?id=org.iggymedia.periodtracker
- https://play.google.com/store/apps/details?id=com.popularapp.periodcalendar
- https://play.google.com/store/apps/details?id=homeworkout.homeworkouts.noequipment
- https://play.google.com/store/apps/details?id=com.baviux.voicechanger
- https://play.google.com/store/apps/details?id=com.devuni.flashlight
- https://play.google.com/store/apps/details?id=goldenshorestechnologies.brightestflashlight.free
- https://play.google.com/store/apps/details?id=com.ovelin.guitartuna
- https://play.google.com/store/apps/details?id=com.stonekick.tuner
- https://play.google.com/store/apps/details?id=com.gamestar.perfectpiano
- https://play.google.com/store/apps/details?id=umito.android.minipiano
- https://play.google.com/store/apps/details?id=com.agminstruments.drumpadmachine
- https://play.google.com/store/apps/details?id=com.paullipnyagov.drumpads24
- https://play.google.com/store/apps/details?id=jp.ne.ibis.ibispaintx.app
- https://play.google.com/store/apps/details?id=com.adsk.sketchbook
- https://play.google.com/store/apps/details?id=com.myfitnesspal.android
- https://play.google.com/store/apps/details?id=com.gpsmapcamera.geotagginglocationonphoto
- https://play.google.com/store/apps/details?id=com.bitsmedia.android.muslimpro
- https://play.google.com/store/apps/details?id=com.athan
- https://play.google.com/store/apps/details?id=com.sevapp.smart_tasbeeh
- https://play.google.com/store/apps/details?id=com.media.bestrecorder.audiorecorder
- https://play.google.com/store/apps/details?id=com.coffeebeanventures.easyvoicerecorder
- https://play.google.com/store/apps/details?id=advanced.scientific.calculator.calc991.plus
- https://play.google.com/store/apps/details?id=com.desmos.calculator
- https://play.google.com/store/apps/details?id=org.geogebra.android
- https://play.google.com/store/apps/details?id=icv.resume.curriculumvitae
- https://play.google.com/store/apps/details?id=bodyfast.zero.fastingtracker.weightloss
- https://play.google.com/store/apps/details?id=com.bodyfast
- https://play.google.com/store/apps/details?id=com.merriamwebster
- https://play.google.com/store/apps/details?id=com.dictionary
- https://play.google.com/store/apps/details?id=com.hrd.vocabulary
- https://play.google.com/store/apps/details?id=com.realbyteapps.moneymanagerfree
- https://play.google.com/store/apps/details?id=com.droid4you.application.wallet
- https://play.google.com/store/apps/details?id=com.Splitwise.SplitwiseMobile
- https://play.google.com/store/apps/details?id=com.tribab.tricount.android
- https://play.google.com/store/apps/details?id=splid.teamturtle.com.splid
- https://play.google.com/store/apps/details?id=com.digitalchemy.currencyconverter
- https://play.google.com/store/apps/details?id=com.easy.currency.extra.androary
- https://play.google.com/store/apps/details?id=com.xe.currency
- https://play.google.com/store/apps/details?id=kr.sira.unit
- https://play.google.com/store/apps/details?id=com.google.android.apps.tasks
- https://play.google.com/store/apps/details?id=com.microsoft.todos
- https://play.google.com/store/apps/details?id=com.ticktick.task
- https://play.google.com/store/apps/details?id=com.superelement.pomodoro
- https://play.google.com/store/apps/details?id=net.daylio
- https://play.google.com/store/apps/details?id=diary.journal.lock.mood.daily
- https://play.google.com/store/apps/details?id=com.habitnow
- https://play.google.com/store/apps/details?id=org.isoron.uhabits
- https://play.google.com/store/apps/details?id=com.gamebasic.decibel
- https://play.google.com/store/apps/details?id=kr.sira.sound
- https://play.google.com/store/apps/details?id=com.andymstone.metronome
- https://play.google.com/store/apps/details?id=com.digipom.easymetronome
- https://play.google.com/store/apps/details?id=com.vincentlee.compass
- https://play.google.com/store/apps/details?id=com.gamma.bubblelevel
- https://play.google.com/store/apps/details?id=org.nixgame.ruler
- https://play.google.com/store/apps/details?id=gps.speedometer.gpsspeedometer.odometer
- https://play.google.com/store/apps/details?id=com.hantor.CozyMag
- https://play.google.com/store/apps/details?id=mmapps.mirror.free
- https://play.google.com/store/apps/details?id=com.chess.clock
- https://play.google.com/store/apps/details?id=de.cliff.strichliste
- https://play.google.com/store/apps/details?id=ua.napps.scorekeeper
- https://play.google.com/store/apps/details?id=com.spinthewheeldecider
- https://play.google.com/store/apps/details?id=ipnossoft.rma.free
- https://play.google.com/store/apps/details?id=com.spotlightsix.zentimerlite2
- https://play.google.com/store/apps/details?id=relax.sleep.relaxation.sleepingsounds
- https://play.google.com/store/apps/details?id=com.tmsoft.whitenoise.lite
- https://play.google.com/store/apps/details?id=com.havabee.breathe
- https://play.google.com/store/apps/details?id=com.l
- https://play.google.com/store/apps/details?id=com.purplecover.anylist
- https://play.google.com/store/apps/details?id=mendeleev.redlime
- https://play.google.com/store/apps/details?id=com.theruralguys.stylishtext
- https://play.google.com/store/apps/details?id=com.remind.drink.water.hourly
- https://play.google.com/store/apps/details?id=com.ichi2.anki
- https://play.google.com/store/apps/details?id=com.quizlet.quizletandroid
- https://play.google.com/store/apps/details?id=com.happyverse.agecalculator
- https://play.google.com/store/apps/details?id=com.brunoschalch.timeuntil
- https://play.google.com/store/apps/details?id=com.aadhk.woinvoice
- https://play.google.com/store/apps/details?id=com.medisafe.android.client
- https://play.google.com/store/apps/details?id=eu.smartpatient.mytherapy
- https://play.google.com/store/apps/details?id=com.bluefish.bloodpressure
- https://play.google.com/store/apps/details?id=com.hevy
- https://play.google.com/store/apps/details?id=com.github.jamesgay.fitnotes
- https://play.google.com/store/apps/details?id=com.kajda.fuelio
- https://play.google.com/store/apps/details?id=br.com.ctncardoso.ctncar
- https://play.google.com/store/apps/details?id=com.nighp.babytracker_android
- https://play.google.com/store/apps/details?id=com.continuum.emi.calculator
- https://play.google.com/store/apps/details?id=com.skollabs.tipcalc
- https://play.google.com/store/apps/details?id=org.zwanoo.android.speedtest
- https://play.google.com/store/apps/details?id=com.google.android.apps.translate
- https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2
- https://play.google.com/store/apps/details?id=com.x8bit.bitwarden
- https://play.google.com/store/apps/details?id=pedometer.steptracker.calorieburner.stepcounter
- https://play.google.com/store/apps/details?id=com.northcube.sleepcycle
- https://play.google.com/store/apps/details?id=com.shazam.android
- https://play.google.com/store/apps/details?id=com.duolingo
- https://play.google.com/store/apps/details?id=com.sirma.mobile.bible.android
- https://play.google.com/store/apps/details?id=com.calm.android

Rankings and context:
- AndroidRank, most installed Tools (pages 1–7): https://www.androidrank.org/android-most-popular-google-play-apps?category=TOOLS&sort=4&price=free
- AndroidRank, most installed Productivity: https://www.androidrank.org/android-most-popular-google-play-apps?category=PRODUCTIVITY&sort=4&price=free
- AndroidRank, most installed Health & Fitness: https://www.androidrank.org/android-most-popular-google-play-apps?category=HEALTH_AND_FITNESS&sort=4&price=free
- AndroidRank, most installed Music & Audio: https://www.androidrank.org/android-most-popular-google-play-apps?category=MUSIC_AND_AUDIO&sort=4&price=free
- AndroidRank, most installed Finance (all banking/payments, so no simple apps there): https://www.androidrank.org/android-most-popular-google-play-apps?category=FINANCE&sort=4&price=free
- AppBrain, Top Free Tools chart (US): https://www.appbrain.com/stats/google-play-rankings/top_free/tools/us
- Wikipedia, List of most-downloaded Google Play applications (tiers as of 10 Aug 2024): https://en.wikipedia.org/wiki/List_of_most-downloaded_Google_Play_applications
- FoxData, App downloads by category in 2025 (Tools ≈ 12.46B Play downloads; third-party estimate): https://foxdata.com/en/blogs/app-downloads-by-category-in-2025-games-lead-while-utility-and-content-apps-reshape-global-demand/
- AppTweak, App downloads by category (alternative, much lower estimate): https://www.apptweak.com/en/reports/app-downloads-by-category

Notes on claims from memory rather than fetched this session (verify before quoting externally): the CamScanner 2019 Play removal over a malicious ad SDK, the Flo 2021 FTC settlement, the 2020 Muslim Pro location-data reporting, the Splitwise free-tier limits, and browser API support details (BarcodeDetector, torch constraint, iOS motion permission, `getDisplayMedia` on mobile).
