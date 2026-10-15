# App research: what to build on FreeAppStore

Research date 2026-10-15. Four reports, one decision list.

| Report | Covers |
|---|---|
| [google-play-top-simple-apps.md](google-play-top-simple-apps.md) | 42 non-game app types ranked by Google Play installs, ratings and review counts |
| [apple-app-store-top-simple-apps.md](apple-app-store-top-simple-apps.md) | 41 app types from Apple's US free, paid and top-grossing charts, plus 20 paid apps FAS could offer free |
| [niche-and-paid-simple-apps.md](niche-and-paid-simple-apps.md) | 28 trivial apps with big revenue or user anger at ads, paywalls and tracking; F-Droid demand; 2025–26 trends |
| [FGS: simple-games.md](https://github.com/freegamestore-online/platform/blob/main/docs/app-research/simple-games.md) | Games, in the FreeGameStore repo with their own priority list |

Every app type below was checked against the current FAS catalog (149 apps, `sites/storefront/registry.json`) and against what FAS can do today.

## How the list is ranked

Priority = demand (installs, ratings, chart rank, revenue) × **gap** (not in the catalog, or the catalog version is far behind the leaders) × **ease** × **FAS edge** (the leaders are ad-heavy, paywalled or have a privacy record that "free, no tracking" beats).

Each app type gets one decision:

- **Build now**: buildable with today's SDK and browser APIs.
- **Build now, upgrade later**: ship the core now; one feature waits for a platform update (named).
- **Upgrade existing**: the catalog already has it; close the gap to the market leaders instead of adding a duplicate.
- **Defer**: blocked by a platform update or a non-platform risk (named).
- **Won't build**: needs native OS access or a content library, so a web app can't do it at all.

## Platform updates the deferred items wait on

| # | Update | Unblocks | Size |
|---|---|---|---|
| **P1** | **`fas.push`: Web Push subscriptions plus scheduled send.** The SDK stores a push subscription per user; the app schedules a notification at a time or repeat rule; the backend sends it. Built on what exists: `sendWebPush` in `workers/agent/src/push.ts`, the VAPID keys, and the backend's `scheduled()` handler, which already runs every 15 minutes. Prayer times need minute precision, so use Durable Object alarms (or a 1-minute cron) rather than the 15-minute tick. Add quiet hours and generic lock-screen text for health apps. | Timed reminders in about 12 apps: period, fasting, water, prayer, medication, habits, to-do, subscriptions, plus the existing `bill-reminders`, `pillcount`, `habits` and `family-hub` | Small–medium. **Highest-value platform item on this list.** |
| **P2** | **Compliance rule for large lazy-loaded assets.** `bundle-size` checks only the largest `.js` file under `web/dist/assets`. OCR (tesseract wasm plus language data) and the pdf.js worker should load on demand. State in the check and docs that lazily loaded wasm, data and worker chunks are allowed, and set a cap for them. | OCR in the document scanner; heavier PDF tools | Small |
| **P3** | **Add Open Food Facts to the documented no-key API list** (check its CORS and rate policy). | Barcode lookup for the calorie log | Tiny |
| **P4** | **Scheduled server-side fetch for each app** (check a URL on a schedule, push when it changes). This is cron plus server compute, which is a Pro feature today. | Severe-weather alerts, package tracking, price alerts | Medium. **Decide whether this belongs in FAS or stays PAS-only.** |

## Priority list: build first

### Wave 1: new apps, highest priority (all build now)

| # | App | Why first | Decision | Waits on |
|---|---|---|---|---|
| 1 | **Period / cycle tracker** | 100M+ installs each for Flo and Period Calendar; Flo's FTC settlement over sharing health data makes "your data never leaves your phone" the pitch. Not in the catalog. | Build now, upgrade later | P1 for period-due and pill reminders |
| 2 | **Document scanner → PDF** | CamScanner 500M+, six or more scanners in Apple's top-grossing Business chart, weekly-subscription traps. Not in the catalog. | Build now (edge crop, filters, multi-page PDF); OCR in v2 | P2 for OCR |
| 3 | **Prayer times & Qibla** | Muslim Pro 100M+; Qibla apps' location data reached US military contractors. Calculation is local (adhan-js). Not in the catalog. | Build now, upgrade later | P1 for prayer-time alerts |
| 4 | **Intermittent fasting timer** | Zero, Fastic and Simple charge $40–100/yr for a clock; Google Play's top fasting app has 50M+ installs. Not in the catalog. | Build now, upgrade later | P1 for window alerts |
| 5 | **Water tracker** | Water Reminder 10M+; incumbents paywall reminder customisation. Not in the catalog. | Build now, upgrade later | P1 (the reminder *is* the product, so ship P1 soon after) |
| 6 | **Sleep sounds / white-noise generator** | Calm about $3–5M a month; BetterSleep 10M+. Generated with Web Audio, so no files are needed. `meditation` has ambient sound but no noise machine. | Build now | — |
| 7 | **Sensor toolkit: sound meter, compass, bubble level, ruler** | Each 10M+ on Google Play; classic adware category. Not in the catalog. | Build now | — |
| 8 | **Voice changer + voice recorder** | Voice changer 100M+; recorders 50M+ each. Not in the catalog. | Build now | — |
| 9 | **Medication & blood-pressure log** | Medisafe and MyTherapy 5M+; BP Diary 4.8★. Extends `pillcount` into a med schedule, vitals charts and a PDF report for the doctor. | Build now, upgrade later | P1 for dose reminders |
| 10 | **Everyday calculator suite: tip, %, discount, age/date, fuel** | Tip, EMI and age calculators each 5M+. `calculator` is basic and `loan` is separate. | Build now | — |
| 11 | **Baby tracker (two parents, live)** | Huckleberry and Baby Tracker 4.9★; strong fit for shared collections plus rooms. Not in the catalog. | Build now | P1 for feed reminders (nice to have) |
| 12 | **Sobriety / quit counter** | Private by design; "nothing to unlock". Not in the catalog. | Build now | — |
| 13 | **Drum pad / beat maker** | Drum Pad Machine 100M+. Needs CC0 or self-made samples. Not in the catalog. | Build now | — |
| 14 | **Reading log (Open Library)** | Goodreads alternative "without Amazon". `Books` is audiobooks, not a reading tracker. | Build now | — |
| 15 | **Financial & trade calculators (TVM, NPV/IRR, conduit bending)** | 10bii and QuickBend are #1 in their paid charts. Pure maths. | Build now | — |

### Wave 2: upgrade existing catalog apps to match the leaders

The catalog already covers these app types. The leaders show what's missing.

| # | Existing app | Upgrade to | Evidence | Waits on |
|---|---|---|---|---|
| 16 | `habits`, `streak` | Unlimited habits, Loop-style scoring, daily nudges, app badge | Streaks is #1 paid H&F; Loop 5M+ | P1 for nudges |
| 17 | `bill-reminders` | Subscription tracker: monthly total, renewal alerts, currency conversion | Subpilot and SubSeek are top-grossing Finance | P1 |
| 18 | `my-todos`, `taskflow`, `kanban` | One flagship to-do app: due dates, shared lists, badge count | TickTick and Things 3 (#3 paid Productivity) | P1 for due dates |
| 19 | `Converter` | Add currency with offline last-known rates | Currency converters 10M+ each | — |
| 20 | `countdown` | "Days since" / relationship and milestone counter | My Love 1.04M ratings | P1 for milestone pushes |
| 21 | `PDF Reader` | Merge, split, sign, reorder (pdf-lib) | Acrobat 500M+; five PDF apps in AppBrain's US Tools top 10 | P2 if the worker is too big |
| 22 | `photo` | Collage grids, frames, print-size layouts | Collage Maker 100M+ | — |
| 23 | `shoplist`, `Shopping List`, `recipes` | Shared live lists (collections plus rooms), recipe URL import via the proxy | Listonic 10M+; Paprika #1 paid Food & Drink | — |
| 24 | `calories` | Barcode lookup, a larger food database, BYO-key photo logging | MyFitnessPal is #1 top-grossing H&F | P3 |
| 25 | `workout`, `hiit` | Couch-to-5K plan with voice cues; bodyweight routine library (openly licensed art) | C25K is a paid hit; Leap Fitness has several 100M+ titles | — |
| 26 | `flashcards` | FSRS scheduling, Anki CSV/.apkg import, shared public decks | AnkiMobile $24.99; Quizlet moved Learn mode behind its paywall | — |
| 27 | `QR Code`, `QR Reader` | Merge into one: scan + generate (Wi-Fi, vCard), history, unsafe-URL warning; market it as "no subscription, ever" | Gamma Play 500M+; four QR readers in top-grossing Utilities | — |
| 28 | `Weather` | Hourly forecast, AQI, UV, radar | Weather Channel and AccuWeather 100M+ each | P4 for severe-weather alerts |
| 29 | `journal`, `mood` | Client-side encryption with a passphrase lock; BYO-key weekly reflection | Daylio 10M+; Diary with Lock 10M+ | — |
| 30 | `instrument-tuner`, `forktuner`, `metronome` | All tunings free, tempo trainer, setlists; bundle as one practice app | GuitarTuna 100M+; TonalEnergy #1 paid Music | — |

### Wave 3: new apps, mid demand (all build now)

| # | App | Notes |
|---|---|---|
| 31 | Digital business card (QR / vCard + public profile) | Blinq and Popl. QR only on iOS (no NFC writing). |
| 32 | Teleprompter | PromptSmart Pro charges $29.99. Scroll speed, mirror mode. |
| 33 | GPS timestamp camera | 100M+ installs on Google Play; field workers. |
| 34 | Counters: tally, tasbeeh, score keeper with a shared live scoreboard | Tasbeeh 10M+. `Chess Clock` exists; this is the rest of the set. |
| 35 | GPS speedometer / trip meter | 10M+. Foreground only (Wake Lock). |
| 36 | Magnifier & mirror | 10M+ each. Zoom and torch are Android-only. |
| 37 | Wishlist / gift registry | Shared collections; product scraping goes through the proxy (counts toward 10k requests/day). |
| 38 | Event invite / RSVP page | Guests never install anything. Overlaps `Meetup`; check before building. |
| 39 | Test-prep quiz banks (driver's licence, FCC ham radio) | Public-domain question pools. `Quiz` exists; reuse its engine. |
| 40 | Car fuel / expense log | Fuelio and Drivvo 5M+. |
| 41 | Flashlight / screen light | 100M+, but LED control works on Android Chrome only; iOS gets a screen light. Low priority. |

### Wave 4: bring-your-own-key AI apps (build now with the user key vault)

The user stores their own OpenAI/Anthropic key and the app calls it through the proxy. There's friction for non-technical users, so this comes after the waves above.

| # | App | Evidence |
|---|---|---|
| 42 | AI journaling / reflection coach | Rosebud raised $6M (2025). |
| 43 | AI photo calorie logger | Cal AI about $35M in 2025. Pairs with the `calories` upgrade. |
| 44 | AI task breakdown / ADHD helper | Charting on the App Store. |
| 45 | Translator (text and voice) | Google Translate 1B+. There's no free no-key translation API, so it's BYO key only. |

## Deferred, and what each waits on

| App | Blocked by | Note |
|---|---|---|
| Package tracking | P4 plus carrier API keys | Status on open works today; pushes on status change don't. |
| Severe-weather and price alerts | P4 | Forecast and price views are fine today. |
| 2FA authenticator (TOTP) | **Security review, not platform** | TOTP is easy, but if iOS clears the web app's storage the user loses their 2FA codes. Needs a forced encrypted backup and a review before shipping. Apple's top-grossing Utilities has subscription copies at #12 and #46, so demand is real. |
| Self-care pet (Finch-style) | **Art and content, not platform** | 764k ratings at 4.95★, but the value is character art and writing. |
| Brain training | Belongs on FGS | Covered in the games research. |

## Won't build (not possible as a web app)

These all need native OS access or a content library: alarm clocks that ring through a locked phone or silent mode, step counters and background GPS run tracking, sleep tracking, phone cleaners, VPNs, antivirus, app lockers and screen-time blockers, launchers and keyboards, call blocking and recording, screen recorders, TV remotes, Wi-Fi tools, speed tests, music ID, plant identifiers, bank-linked budgeting, and content-library apps (Duolingo, Calm, Quizlet). The reasons are in each report's "Not buildable" section.
