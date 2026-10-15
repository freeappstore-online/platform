# Niche and Paid Simple Apps: FAS Opportunity Scan

**Date:** 2026-10-15

> Revised 2026-10-15: corrected notification/push capability (PWAs support Web Push incl. iOS 16.4+ home-screen apps).

**Scope:** Simple ("trivial-to-build") mobile apps that earn large revenue or have huge install bases through ads, subscriptions or data monetization, and where users are visibly frustrated. These are the best targets for a free, no-ads, no-tracking FreeAppStore (FAS) PWA.

## Summary

- The money in "simple" apps comes mostly from **aggressive subscriptions on commodity features** (QR/PDF scanners, fasting timers, tuners, sobriety counters, habit trackers) and from **ad/data monetization of high-frequency utilities** (weather, prayer times/Qibla, step counters, calculators). Security firm Avast counted 204 "fleeceware" apps, with QR and PDF readers prominent among them, at about 1 billion downloads and an estimated $400M+ in revenue (2021). A single QR reader was reported at about $5.3M/yr, and a "Scanner App" at about $14–15M/yr (Sensor Tower, 2019). The iOS camera already does the same scanning for free.
- The **privacy-sensitive categories** are where "no tracking" is the product itself, not just a nice extra. These are period/fertility tracking (Flo FTC settlement, post-Dobbs app switching), prayer/Qibla (Muslim Pro and Qibla Compass location data sold via X-Mode to US military contractors), weather (Weather Channel location-data suit), and baby/health logs.
- **Paywall-creep backlash** shows demand that can be measured. Examples include Splitwise's 3-expenses-per-day free cap, Quizlet moving Learn mode behind Plus, Simple Mobile Tools being sold to ZipoApps and then adding ads (which led to the Fossify fork), GuitarTuna's subscription, and Fastic's consumer-protection case.
- **FOSS proof of demand:** Loop Habit Tracker (GPLv3) has 5M+ Play installs (about 7.7M by AppBrain's estimate) and a 4.7 rating with no marketing budget. Free clean versions win when they exist and can be found.
- **2025–26 growth:** Appfigures says thin AI "wrapper" apps earned $726M since 2023. Cal AI (photo calorie counting) reportedly reached about $35M in 2025. The Hallow prayer app earns about $10M/month at its peak. Health & Fitness in-app purchase revenue reached a record ~$4.5B in 2025 (Sensor Tower, second-hand). FAS's BYO-key AI vault makes "AI wrapper without the $9.99/week markup" a credible pitch.

## Methodology

- Web search across Sensor Tower public blog reports, Appfigures insights, AppGoblin / Screensdesign / Lazyweb / Latka third-party estimates, AppBrain install counts, App Store and Play listings, security-vendor reports (Avast, Kaspersky), press (TechCrunch, Forbes, Vice, heise, Android Police), and community threads (Reddit and Lemmy mirrors, Fairphone forum, Trustpilot).
- **All revenue and download figures are third-party estimates unless they are marked company-reported.** Estimators disagree widely, sometimes by 10–50x (e.g., GuitarTuna: AppGoblin ~$50K/mo vs Adapty ~$2M/mo vs Lazyweb $24M/yr). Treat them as orders of magnitude only. Appfigures figures are net of store fees. Screensdesign figures often have no stated period.
- Rows are ranked by a qualitative score: **demand** (installs and search volume) × **frustration** (ads, paywall, privacy incidents) × **simplicity** (fits the FAS constraints: client-side, ≤300 KB, no file storage or server compute).
- **Platform capabilities counted as available:** every FAS app is an installable PWA with a service worker, so **Push notifications (Web Push)** (Android, desktop, and iOS/iPadOS 16.4+ Home Screen apps; delivered even when the app is closed), local notifications and **Badging** (`navigator.setAppBadge`) are in scope. The platform already sends VAPID web push in production. `@freeappstore/sdk` has no documented `fas.push` helper yet, so an app uses the standard Web Push API with its own VAPID key, and a timed reminder needs something to send the push at the right time. **Recommendation:** a first-class `fas.push` / scheduled-send primitive (the platform already has `sendWebPush`) would make reminder apps trivial.
- **Ranking caveat:** PWAs cannot run native background tasks. Alarm-clock behaviour (ringing through a locked phone or silent mode, a guaranteed exact-second wake) and background step counting are out, and archetypes that depend on them are scored lower. Reminders and notifications are not a constraint.

## Opportunity table

| # | App archetype | Example apps, monetization, revenue/download estimate | User pain points (ads / paywall / privacy) | FAS free-alternative pitch | Buildability | FAS features used |
|---|---|---|---|---|---|---|
| 1 | **QR / barcode scanner and generator** | TinyLab QR Code Reader: $3.99/wk after a 3-day trial, ~$5.3M/yr (TechCrunch/Forbes, 2019). "Scanner App": ~$14–15M/yr per Sensor Tower before Apple pulled it. Avast fleeceware set (QR/PDF readers prominent): ~1B downloads, ~$400M est. revenue (2021). | Weekly-subscription traps, trial auto-charges (a Play QR app charged users ~$100 after they cancelled, per Android Police), fake "Start" ad buttons (Swiss NCSC 2023). | "Scan and make QR codes. Free forever, no trial, no account." History is kept on the device. Wi-Fi/vCard/URL generators and a warning on unsafe links. | Easy | Camera (BarcodeDetector API or a small JS decoder), per-user KV for optional synced history, offline |
| 2 | **Period / fertility tracker** | Flo: ~$200M premium revenue (2023, Business of Apps), ~$263M (2024, Lazyweb, unverified), 62M MAU. Clue, Stardust. Subscription. | FTC settlement over sharing health data with Facebook/Google analytics. Post-Dobbs users moved to "safer" apps (TechCrunch 2022). Core predictions sit behind a paywall. | "Your cycle data never leaves your phone by default." Local-first. Optional end-to-end encrypted sync. No analytics SDKs. Prediction, symptom log and export are all free. Proven FOSS demand: drip, Euki. | Easy | Local storage, optional per-user KV (client-side encrypted), dark mode, offline |
| 3 | **Prayer times + Qibla compass** | Muslim Pro: 145M+ downloads, 25M+ MAU (company-reported). Revenue historically 55% IAP / 45% ads (2014). Qibla Compass: 5M+ Play installs. | Muslim Pro and several Qibla apps shared location data with X-Mode, which reached US military contractors (Vice 2020). Ad-heavy UI. | "Prayer times without selling your location." Calculated on the device (adhan.js-style math). Qibla bearing from geolocation and device orientation. Hijri calendar. Prayer-time alerts by Web Push. | Easy | Geolocation, DeviceOrientation, Nominatim (city lookup), offline, Web Audio (adhan in-app), Web Push (prayer-time alerts) |
| 4 | **PDF / document scanner** | CamScanner: 100M+ downloads, ads + IAP. A malicious ad SDK (Trojan dropper) was found in 2019 by Kaspersky. Avast lists PDF readers among fleeceware. | Malware via ad SDKs, watermarks, weekly subscriptions, forced cloud upload. | "Scan to PDF on your device. No upload, no watermark." Camera capture, edge crop, filters and multi-page PDF built client-side and saved through the share/download sheet. | Medium (bundle discipline: jsPDF plus a light crop. No OCR, or OCR only through BYO-key AI) | Camera, client-side PDF generation, BYO-key AI vault (optional OCR) |
| 5 | **Intermittent fasting timer** | Zero: 15M+ downloads (est.), ~5k downloads/day (Appfigures 2022), Plus $69.99/yr. Simple: $99.99/yr, raised $30M+. Fastic: $39.99/yr. | Basic timer features moved behind annual subscriptions (top 1–3★ complaint). Fastic: German consumer center legal action over unintended €99 annual subscriptions. | "A fasting timer is a clock. It should be free." Presets (16:8, 18:6, OMAD), streaks, history, window alerts, optional weight log. | Easy | Per-user KV, counters (streaks), offline, Web Push (fasting-window alerts) |
| 6 | **Habit tracker / streaks** | Fabulous, Habitify, Streaks (paid), Productive. Screensdesign est. $15K–150K per app (period unclear). FOSS Loop Habit Tracker: 5M+ installs, 4.72★. | Paywalls after 3–5 habits, subscription upsell nags. | "Unlimited habits, no paywall." Loop-style scoring, heatmaps, optional accountability with friends, daily nudges. | Easy | Per-user KV, friends, counters, realtime (shared streaks), offline, Web Push, Badging |
| 7 | **Water / hydration tracker** | Drink Water Reminder N Tracker: 8.9M installs, 441K MAU, $10K+/mo est. (AppGoblin, 100% IAP). Screensdesign category avg ~$590K (unreliable). | Reminder customization paywalled, ads. | "Tap to log water, with reminders you don't pay for." Goals by weight and weather (Open-Meteo temperature), reminder schedule with quiet hours. | Easy | Per-user KV, counters, Open-Meteo, Web Push (reminders), Badging |
| 8 | **Sleep sounds / white noise** | Calm (~$2.8–4.75M/mo est.), BetterSleep (~$600K est.), Endel (~$550K est.). Screensdesign category average ~$300K/mo (est.). | Sounds behind a paywall, timer locked, constant upsells, ads in free tiers. | "White, pink and brown noise, fan and rain. All generated in your browser, so it is free and works offline." The sound is synthesized with Web Audio, so there are no audio files. | Easy | Web Audio API, offline, dark mode, per-user KV (mixes) |
| 9 | **Group expense split (Splitwise-type)** | Splitwise: Pro $5/mo or $40/yr. Free tier capped at 3–4 expenses/day with cooldown and video ads (since late 2023). | Trustpilot and X backlash ("your long-term users hate what you've done"). Ads before every entry. | "Split bills with friends with no daily limit." Shared groups, multi-currency, settle-up suggestions. | Medium | Shared collections, friends, realtime rooms, exchange-rates API, auth, email (invites) |
| 10 | **Flashcards / spaced repetition** | Quizlet: claimed 60M+ MAU (unverified), Plus ~$35.99/yr. Anki (desktop free, iOS $24.99). | Quizlet moved Learn mode and tests behind a paywall in 2022, and the free tier has ads (top 1–3★ complaint, 26%). Trustpilot 1.4★. | "Anki-grade spaced repetition, Quizlet-easy UI, free." FSRS/SM-2, shareable public decks, Anki CSV import. BYO-key AI card generation from pasted text. | Medium | Shared collections (public decks), per-user KV, BYO-key AI vault, dictionary API, offline |
| 11 | **Guitar / instrument tuner** | GuitarTuna: 100M+ downloads (company-reported). Revenue est. from ~$50K/mo (AppGoblin, 71% ads) to $24M/yr (Lazyweb). Subscriptions up to $139.99. | "Used to be a good tuner, now bloated with a subscription." Alternate tunings behind a paywall. Ads. | "A tuner with every tuning free, no ads, works offline." Chromatic plus presets for guitar, bass, ukulele and violin. | Easy | Microphone, Web Audio (pitch detection: autocorrelation/YIN), offline |
| 12 | **Metronome / practice tools** | Soundbrenner: 7M downloads (company-reported), "Plus" subscription $7.99–79.99. Pro Metronome (IAP). | Features such as tempo ramp and subdivisions locked behind paywalls. | "A metronome with every feature unlocked." Precise Web Audio scheduling, polyrhythm, tempo trainer, setlists. Pairs with the tuner. | Easy | Web Audio, per-user KV (setlists), offline |
| 13 | **Baby tracker (feeds, sleep, diapers)** | Huckleberry: US weekly revenue peak ~$69K, 25.9K weekly downloads, 506K+ active users (Sensor Tower, Q1 2025). Screensdesign est. ~$550K/mo. | Sleep predictions paywalled. Sensitive child health data held by a VC-backed company. Partner sync often premium. | "Track feeds and naps with your partner in real time, free and private." One-tap logging, timers, charts, two-parent live sync. | Medium | Shared collections (household), friends, realtime rooms, offline |
| 14 | **Budget / expense tracker (manual)** | YNAB $99–109/yr, Monarch ~$99.99/yr, Copilot ~$95/yr. Mint shut down in March 2024. Actual Budget (FOSS) gained popularity. | Mint refugees priced out. Bank-sync apps harvest financial data. Ads in free trackers. | "Envelope budgeting without bank access or fees." Manual and CSV-based, multi-currency, household sharing. | Medium | Per-user KV (100 keys / 1 MB requires a compact monthly-bucket schema), shared collections (household), exchange rates |
| 15 | **Weather (ad-free, no location resale)** | The Weather Channel: LA City Attorney suit (settled 2020) over location data used for ads. Carrot (subscription). | Location sold or used for ads, heavy ads, premium radar. | "Weather that doesn't sell where you are." Open-Meteo forecast, hourly, AQI, UV, no account. | Easy | Open-Meteo, Nominatim, geolocation, offline cache |
| 16 | **Sobriety / quit counter** | I Am Sober: 18M+ users (company claim), $4.99/mo or $49.99/yr, est. $10K–200K (AppGoblin/Screensdesign disagree). | Stats and motivation packs locked. Very sensitive data. | "A private sobriety counter. Nothing to unlock." Days, money saved, milestones, optional anonymous support room. | Easy | Counters, per-user KV, realtime rooms (support), offline |
| 17 | **Focus / Pomodoro timer** | Forest: peak ~$400K/mo iOS (36Kr/Diandian), 4.3M installs now (<$10K/mo est., AppGoblin). | Paid upfront on iOS, Pro needed for cross-device, cosmetic upsells. | "Pomodoro with group focus rooms. Free." Study-with-me rooms, session stats. | Easy | Realtime rooms, friends, counters, per-user KV |
| 18 | **Mood tracker / micro-journal** | Daylio (Relaxio). Premium subscription, Appfigures profile only. Screensdesign "journaling with AI" category avg ~$297K (est.). | Stats and exports paywalled. Sensitive mental-health data. | "Mood plus a one-line diary, private by default." Optional BYO-key AI weekly reflection. | Easy | Per-user KV, BYO-key AI vault, offline |
| 19 | **AI journaling / reflection coach** | Rosebud: $6M seed (June 2025), 2,500+ paying (Aug 2025, company), ~$100K est. Stoic, Day One. | $10–15/mo subscriptions, which are mostly LLM markup. Very intimate data on a vendor's server. | "Your journal, your AI key, no middleman." Prompts and summaries through the user's own OpenAI/Anthropic key, entries kept local or encrypted. | Medium | BYO-key AI vault, secret proxy, per-user KV |
| 20 | **AI calorie / photo food logger** | Cal AI: ~$35M revenue 2025 (Latka, est.), >$2M in Feb 2025. MyFitnessPal US weekly revenue $2–3.8M (Sensor Tower 2025). | $30–60/yr for what is a vision-model call. Barcode scan and macros paywalled in MyFitnessPal. | "Snap a meal, use your own AI key, keep the log." Photo is sent directly to the user's model and not stored, so FAS needs no file storage. | Medium | Camera, BYO-key AI vault, per-user KV |
| 21 | **Calculator suite (tip, split, %, loan, date)** | Countless ad-funded "Calculator" apps. Calculator Vault fleeceware. | Full-screen interstitials in a calculator, permission overreach. | "Every everyday calculator in one clean app." Tip/split, percent, loan, date difference, discount. | Easy | Offline, per-user KV (favorites) |
| 22 | **Unit and currency converter** | Many ad-funded converters. Open-source Converter NOW exists (r/opensource). | Ads, currency rates paywalled, no offline mode. | "Every unit, live currencies, offline." | Easy | Exchange-rates API, offline cache |
| 23 | **Interval / HIIT / workout timer** | Seconds, Interval Timer apps. Subscription or ads. | Saved routines or voice cues paywalled. | "Build any interval routine, with voice cues, free." | Easy | Web Audio / SpeechSynthesis, per-user KV, Wake Lock |
| 24 | **Catholic / Christian prayer and devotion** | Hallow: ~$10M net/mo peak (Mar 2024), $9.7M (Apr 2025), ~280K downloads/mo (Appfigures). | $69.99/yr for devotional content, much of it public domain. | "Rosary, Liturgy of the Hours, daily readings. Public-domain texts, free." Prayer timers, streaks, group prayer rooms. | Medium (content licensing: only public-domain texts) | Counters, realtime rooms, per-user KV, offline |
| 25 | **Step counter / pedometer** | Stepz, Pedometer apps. Ad-funded (e.g., 100% ads per AppGoblin). | "Ads pop up at almost every touch." Must stay in the foreground. | Weak: a PWA can't count in the background. Pitch it as a "walk session" tracker with friend challenges. | Medium (platform-limited) | Geolocation, DeviceMotion, friends, counters |
| 26 | **Tasbih / dhikr counter** | Tasbih PRO! and similar (<$10K/mo est.). Many ad-funded clones. | Ads in a tap-counter. | "A tap counter with presets, haptics and history." | Easy | Counters, per-user KV, Vibration API |
| 27 | **Language word-of-day / vocab builder** | Many ad-funded vocab apps (Duolingo is out of scope). | Ads, streak-shaming paywalls. | Dictionary-API word of the day, spaced review, BYO-key AI example sentences. | Easy | Dictionary API, Wikipedia, BYO-key AI, per-user KV |
| 28 | **Reading log / book tracker** | Goodreads (Amazon), StoryGraph Plus. | Amazon data, ads. Stats paywalled. | "Track reading without Amazon." Open Library search, shelves, yearly goal, friends' activity. | Easy | Open Library API, shared collections, friends, counters |

**Notes on ranking:** Rows 1–4 combine very large install bases with documented privacy or fraud incidents, which makes the trust message easy to communicate. Rows 5–12 are pure paywall-on-commodity plays that need almost no backend; water tracking (#7) moved up because its paywalled feature, reminder customization, is exactly what Web Push gives away free. Rows 13–14 need shared or realtime features, where FAS's backend is a differentiator against single-user FOSS apps.

## F-Droid / FOSS demand signals

- **Loop Habit Tracker** (GPLv3, also on F-Droid): 5M+ Play installs (AppBrain est. ~7.7M), ~87K downloads in the last 30 days, 4.72★. This shows that a free, no-ads habit tracker can win at scale.
- **Simple Mobile Tools → Fossify** (late 2023): the popular ad-free suite (calendar, gallery, notes, file manager and others) was sold to ZipoApps. Users then reported video ads and a weekly charge replacing the one-time $2.99. The community forked the GPL code as **Fossify**, which reached F-Droid in January 2024. This is direct evidence that users of simple utilities leave when ads or subscriptions are introduced.
- **drip** and **Euki** (period tracking) are frequently recommended after Dobbs as no-data alternatives.
- **Actual Budget** (FOSS, self-hostable) gained Mint refugees after the 2024 shutdown.
- **Converter NOW**, **CalcuGo** and similar ad-free converters and calculators are promoted on r/opensource and Product Hunt with "no ads, no tracking, no internet permission" as the headline.
- Editorial lists that are always cited (NewPipe, K-9/Thunderbird, OsmAnd~, AdAway, Aegis, Aurora Store) show that F-Droid demand concentrates on **removing ads and tracking from everyday tools**, the same pitch FAS makes. F-Droid does not publish reliable per-app download counts, so these are qualitative signals.
- **Implication for FAS:** FOSS apps rarely include multi-user features (shared groups, realtime, friends). FAS can offer free plus private plus social, which neither F-Droid apps nor paid apps combine.

## Emerging simple categories (2025–2026)

1. **BYO-key AI utilities.** Appfigures: "General Assistant" thin wrappers earned $726M (2023 to Jan 2025), about 40% of top-1K AI app spending. ChatGPT mobile ~$2.48B in 2025 (+408%). Most wrappers resell API calls at a 10–50x markup. FAS pitch: the same UX with the user's own key. Good fits: summarizer, rewrite/translate, photo-to-calories, flashcard generator, journal reflection, recipe-from-fridge, email drafter.
2. **AI nutrition and photo logging.** Cal AI ~$35M in 2025 (Latka est.). Sensor Tower cites AI nutrition and diet tracking as a top Health & Fitness growth subgenre in 2025, a category at a record ~$4.5B IAP (+13%).
3. **Faith and devotion apps.** Hallow ~$10M/mo peak (Appfigures), with predictable Lent and Ramadan spikes. Prayer-time and Qibla apps have a privacy track record that rewards a no-tracking brand.
4. **Focus / digital wellbeing.** Opal: ~$4.8M (2024, Lazyweb est.), 4M+ users claimed. App blocking needs native OS hooks that FAS lacks, so the target is the **social focus room / Pomodoro** sub-niche.
5. **Journaling and mental-health micro-tracking.** Rosebud seed $6M (2025). Mood and sobriety trackers. Privacy is the main purchase driver here.
6. **Fleeceware-adjacent utilities persist.** Utilities was #5 by revenue in 2024 with very high YoY growth (Appfigures, includes AI identifiers and cleaners). Scanners, cleaners and identifiers keep monetizing commodity features through weekly plans, so "free forever, no trial" stays a differentiator.

## Sources

- TechCrunch, fleeceware QR reader (~$5.3M/yr): https://techcrunch.com/?p=1731985
- John Koetsier / Forbes, Apple pulls scammy app up to $14.3M/yr: https://johnkoetsier.com/apple-pulls-scammy-app-making-up-to-14-3m-year-questions-remain/
- Android Police, QR app trial scheme (~$100 charges): https://www.androidpolice.com/2019/06/18/qr-code-app-on-play-store-ripping-people-off-for-100-through-shady-trial-scheme/
- Swiss NCSC weekly review 23w03 (QR scanner ad tricks): https://www.bacs.admin.ch/en/23w03-en
- Avast / Gen Digital fleeceware press release (2021): https://newsroom.gendigital.com/2021-03-24-Free-trial-for-Only-3,432-per-Year-Avast-Discovers-new-Fleeceware-Apps-on-the-Google-Play-and-Apple-App-Stores
- iMore, fleeceware $400M+: https://www.imore.com/fleeceware-apps-have-ripped-more-400-million-users
- BGR, CamScanner malware (100M+ downloads): https://bgr.com/tech/android-malware-camscanner-trojan-dropper/
- Business of Apps, Flo statistics: https://www.businessofapps.com/?p=94248
- Lazyweb, Flo company profile: https://app.lazyweb.com/company/flo
- TechCrunch, period-tracking app switching after Roe: https://techcrunch.com/2022/06/27/consumers-swap-period-tracking-apps-in-search-of-increased-privacy-following-roe-v-wade-ruling
- Tom's Guide, period-tracking apps respond to Roe: https://tomsguide.com/news/period-tracking-apps-respond-to-roe-v-wade-ruling
- ProPrivacy, Muslim Pro accused of selling data: https://proprivacy.com/privacy-news/muslim-pro-accused-of-selling-data
- The New Arab, more Muslim apps selling data to X-Mode: https://www.newarab.com/news/more-muslim-apps-selling-data-us-military-linked-x-mode?amp
- Bintang Capital, Bitsmedia / Muslim Pro (145M+ downloads, 25M MAU): https://www.bintangcapitalpartners.com/bitsmedia
- Wamda, Muslim Pro revenue mix (2014): https://www.wamda.com/en/2014/01/how-the-muslim-pro-app-got-9m-of-muslim-users
- Appfigures, Zero download surge: https://appfigures.com/resources/insights/20220902/1-elon-musks-tweet-gives-zero-a-surge-of-downloads
- Unstar, fasting apps ranked 2026 (pricing, complaints): https://unstar.app/blog/zero-simple-fastic-life-fasting-bodyfast-intermittent-fasting-apps-ranked-2026
- heise, Fastic subscription consumer case: https://www.heise.de/en/news/Weight-loss-app-Fastic-could-also-unknowingly-slim-down-your-wallet-10509156.html
- Screensdesign, white noise apps category: https://screensdesign.com/categories/white-noise-apps/
- Screensdesign, habit tracker apps category: https://screensdesign.com/categories/habit-tracker-apps/
- Screensdesign, water reminder apps: https://screensdesign.com/categories/water-reminder-apps/
- AppGoblin, Drink Water Reminder N Tracker: https://appgoblin.info/apps/870372885
- Sensor Tower, Q1 2025 US parenting top 5 (Huckleberry): https://sensortower.com/blog/2025-q1-unified-top-5-parenting-revenue-us-60770e78241bc16eb81e8fcf
- Screensdesign, Huckleberry: https://screensdesign.com/showcase/huckleberry-baby-child
- AppGoblin, GuitarTuna: https://appgoblin.info/apps/527588389
- Adapty, GuitarTuna paywall: https://adapty.io/paywall-library/guitartuna/
- Lazyweb, GuitarTuna: https://app.lazyweb.com/company/guitartuna
- Soundbrenner Plus announcement: https://www.soundbrenner.com/blogs/articles/introducing-soundbrenner-plus
- ITVoice, Splitwise free-expense limits: https://www.itvoice.in/splitwise-has-introduced-restrictions-on-the-number-of-free-expenses-users-can-add
- Trustpilot, Splitwise reviews: https://au.trustpilot.com/review/splitwise.com
- Unstar, flashcard apps ranked 2026 (Quizlet paywall): https://unstar.app/blog/quizlet-anki-brainscape-knowt-studysmarter-flashcard-study-apps-ranked-2026
- Heuristica, Anki vs Quizlet: https://www.heuristi.ca/compare/anki-vs-quizlet
- Motley Fool, Mint alternatives: https://fool.com/the-ascent/personal-finance/articles/the-mint-budgeting-app-is-gone-here-are-some-alternatives/
- White Coat Investor, Mint shutting down: https://www.whitecoatinvestor.com/mint-budgeting-app-shutting-down/
- Frankfurt Kurnit, Weather Channel settlement takeaways: https://advertisinglaw.fkks.com/post/102ge0y/takeaways-from-the-weather-channel-settlement-over-location-data-practices
- AppGoblin, I Am Sober: https://appgoblin.info/apps/672904239
- 36Kr, Forest / Seekrtech analysis: https://eu.36kr.com/de/p/3432666329124482
- AppGoblin, Forest: https://appgoblin.info/apps/866450515
- TechCrunch, Rosebud $6M seed: https://techcrunch.com/2025/06/04/rosebud-lands-6m-to-scale-its-interactive-ai-journaling-app
- Latka, Cal AI revenue: https://getlatka.com/companies/calai.app
- Appfigures, Hallow Lent surge: https://appfigures.com/resources/insights/hallow-lent-surge-prayer-app-revenue
- Sensor Tower, Q4 2025 US iOS reference apps (Hallow): https://sensortower.com/blog/2025-q4-ios-top-5-reference-apps-revenue-us-60772727241bc16eb8784bc8
- Sensor Tower, State of Mobile Health & Fitness 2025: https://sensortower.com/blog/state-of-mobile-health-and-fitness-in-2025
- Sensor Tower, Q3 2025 US health & fitness top 5: https://sensortower.com/blog/2025-q3-unified-top-5-health and fitness-revenue-us-600af518241bc16eb8dce802
- Appfigures, AI apps a $2B opportunity / thin wrappers: https://app.appfigures.com/resources/insights/20250131?f=1
- PYMNTS, ChatGPT mobile $2.5B in 2025 (Appfigures): https://www.pymnts.com/artificial-intelligence-2/2025/consumers-spent-2-5-billion-in-chatgpt-mobile-app-in-2025/
- Lazyweb, Opal: https://app.lazyweb.com/company/opal
- AppBrain, Loop Habit Tracker: https://www.appbrain.com/app/org.isoron.uhabits
- GitHub, Loop Habit Tracker: https://github.com/iSoron/uhabits
- Fairphone forum, Simple Mobile Tools sold to ZipoApps: https://forum.fairphone.com/t/simple-mobile-tools-sold-to-zipoapps/103308
- kvibber, Fossify replacing Simple Mobile Tools: https://kvibber.com/reviews/apps/fossify-replace-smt/
- Computer Hope, F-Droid (popular apps): https://www.computerhope.com/jargon/f/f-droid.htm
- nextpit, ad-free unit converter: https://nextpit.com/free-instead-of-0-99-convert-hundreds-of-units-android
- Justuseapp, Stepz reviews (ad complaints): https://justuseapp.com/en/app/839671656/stepz-step-counter-tracker/reviews
