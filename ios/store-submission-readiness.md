# Apple submission readiness

Checked 2026-11-28 for FreeAppStore Companion, app `6840294127`, iPhone build **0.2.0 (55)**. Internal TestFlight is available; the public App Store version is **Prepare for Submission**. This is an evidence sheet, not a record of submitted declarations. Saved artwork/copy is recorded in [store-listing.md](store-listing.md).

## App Privacy: answers supported by implementation

**Data collected: Yes. Linked to the user: Yes for the rows below. Tracking: No. Purpose: App Functionality.** Account/device linkage remains collection even when a feature is optional or the public audio manifest omits the contributor. The app has no advertising, analytics or crash-reporting SDK. Do not equate that with collecting no data. Apple's [privacy instructions](https://developer.apple.com/app-store/app-privacy-details/) require ongoing optional-feature collection to be disclosed.

| Apple data type | Actual flow / evidence |
| --- | --- |
| Name; Email Address | Connected account profile and authentication. `packages/backend/src/routes/native.ts` `/me`, `routes/auth.ts`; local profile in `CompanionRepository.swift`. |
| User ID | Account ID/login on device registration, leases, submissions and reports. App publishers can see contributors to their own jobs. |
| Device ID | Random native-device ID, credential association and runner `ndev:<id>`; no advertising identifier. `routes/native.ts`, `routes/generation.ts`. |
| Precise Location | Enabled, consented route samples: coordinates, accuracy and time. Platform retention seven days; Run can keep the user's saved workout until deleted. `LocationCollector.swift`, `LocationPolicy.swift`, backend `lib/native-companion.ts`. |
| Audio Data | Generated narration uploaded under the connected account. Accepted audio becomes public; the app never records microphone input. `Generation.swift`, `routes/generation.ts`. |
| Other User Content | Contribution quality choice and optional note, plus related submitted metadata. |
| Performance Data | Generation stage duration, CPU/memory and energy-related measurements in account-linked attempt records. |
| Other Diagnostic Data | Errors, app/OS/device versions, network/thermal state and execution context. Attempt records retained 14 days. |
| Product Interaction | Account-linked job claims, submission/review actions and outcomes; native-device last-seen activity. This describes use of Contribute/device services, beyond technical timings. **Missing from build 55's manifest; add for the next build and include in App Privacy.** |

The first nine types are already declared in build 55's manifest. The source [PrivacyInfo.xcprivacy](FreeAppStore/PrivacyInfo.xcprivacy) now adds Product Interaction under [#866](https://github.com/freeappstore-online/platform/issues/866), pending a new signed upload. Product Interaction is the more specific usage category; do not also add Other Usage Data for the same records. Apple's [manifest data-type definitions](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype) support that classification.

Favourites, recent app IDs and catalogue searches stay on-device; do not label them as uploaded browsing/search history. QR camera frames are not retained or uploaded. Offline Sherpa inference does not itself send data. Native catalogue apps open externally in the browser. See [data inventory](../docs/device-data.md), [SDK privacy review](Privacy/README.md) and the [public policy](https://freeappstore.online/privacy).

**Reconcile before final declarations:**

- Location collection accepts only fixes with horizontal accuracy at most 100 metres and preserves full coordinates. Merely handling iOS's approximate-permission flag does not establish Coarse Location collection; normal Reduced Accuracy fixes fail that gate. No speculative Coarse Location addition is proposed.
- Run receives samples for exercise recording. Verify whether the receiving service's workout data must additionally be classified as Fitness for this companion's scope; absence of HealthKit alone is not evidence against Fitness collection. The companion uploads coordinates/time, not heart rate, steps or workout summaries.
- Pairing stores a daily IP hash for abuse prevention. Include this pseudonymous network identifier in the identifier/security inventory; hashing does not justify a blanket “not collected” claim. Verify actual infrastructure retention and any provider access logs against the label before final publication.
- Functionality is supported by account operation, delivery, quality checks and troubleshooting. If operators also use these records for audience/product analytics, add Analytics for the affected types. No such separate use is established by the native code audit. Owner confirmation concerns actual operational use, not permission to omit existing collection.

## Age-rating questionnaire

Use Apple's [current definitions](https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/); let Apple calculate the rating. The following are implementation-backed answers for native capabilities, not a certification of every live catalogue item or queued book excerpt.

| Field | Prepared answer / limit |
| --- | --- |
| Parental controls; Age assurance | No native parental controls or age-verification mechanism. Contribution limits are not parental controls. |
| Advertising; Messaging/chat; Social media | No native advertising, user-to-user messaging or social feed. Catalogue entries are not a social network. |
| Unrestricted web access | No embedded general browser; catalogue URLs open in the external browser. |
| User-generated content | **Yes proposed:** publisher-created catalogue content and narration inputs/audio are part of the experience. This is broader than chat. |
| Shared location | No person/group sharing is implemented: approved Run access is for the same user's account. Recheck if more recipient apps are enabled. |
| Gambling; Simulated gambling; Loot boxes; Contests | None in native functionality. No wagering, randomized purchases or competitions. |
| Dating/relationships; Medical/treatment information | None in native functionality. |
| Health/wellness | Route recording supports exercise, but the native UI does not give lifestyle recommendations. Check displayed catalogue/job content against this field before selecting a final answer. |
| Profanity, fear/horror, substances, suggestive/sexual content, violence, weapons | **Content inventory required:** backlog previews and generated book narration can contain third-party text. Do not select “None” across all fields from native UI strings alone. Review current eligible content and publisher restrictions, then record frequency. |

No Kids-category claim or fixed 4+ rating is justified by this review. Content restrictions, UGC reporting/moderation and any required regional rating details must match what users can actually encounter.

## Content rights and encryption

**Third-party content: Yes.** The app displays/accesses publisher app assets and text, narration inputs, voice-model data and third-party library components. Before affirming that all necessary rights are held, inventory publisher permissions, book/public-domain territory status, model/voice licences and required notices. The platform's code licence is not proof of rights to every book or model. This is an owner/publisher evidence gap, not a reason to choose “does not contain third-party content.” See Apple's [app information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/).

**Encryption:** build 55 declares `ITSAppUsesNonExemptEncryption=false`. The source uses OS HTTPS, Keychain, secure random generation and CryptoKit SHA-256 for PKCE/download integrity. These support **uses encryption, exempt from Apple's documentation upload**, not “no encryption whatsoever.” No proprietary encryption protocol was found. Include linked libraries when rechecking a new binary. Apple's [export guidance](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations) distinguishes exemption from all legal/export obligations; regional or government reporting facts remain the account holder's responsibility.

## Review access and owner-only facts

1. **Working review access is missing independently of contact details.** Store browsing works signed out; Contribute and Sharing require account connection. Prepare a dedicated, permitted review account with a usable sign-in path and full feature access, or an approved demo mode. Current source has no demo mode. Do not supply the owner's personal credentials. A ten-minute single-use pairing code is not durable review access. Verify the actual provider sign-in path and recovery/2FA behavior before submitting private credentials in App Store Connect. Account auth supports provider flows; implementation alone does not prove every provider is configured in production.
2. Arrange real reviewable contribution work and document model/storage requirements and foreground Run now. If production queue is empty, say so; do not invent completed jobs. Explain optional background location and provide a test path for same-account Run recording. Full steps are in [App Review notes](store-listing.md#app-review-notes). Apple requires usable access to account-based features in its [review instructions](https://developer.apple.com/app-store/review/).
3. **Real review contact required:** use the account holder's real name and review email; review phone has been requested separately. Do not invent a phone or use the support address as proof it reaches the reviewer contact. Public support is `support@freeappstore.online`. Both App Review and external TestFlight review fields need checking.
4. Confirm legal seller, agreements, territories, trader/regional declarations and any China-mainland content/security/AI requirements if that territory is selected. Repo code cannot supply those legal facts. No regional form was submitted by this audit.
5. Accessibility support claims require feature-level testing. Current iPhone screenshots and larger-text checks are not a complete VoiceOver/accessibility certification. Physical TestFlight installation and a fresh contribution upload remain unverified.

### Existing review-access arrangements checked

Metadata-only inspection on 2026-11-28 found an existing **canary account** used by production CI. The ops entry `fas/FAS_E2E_GITHUB_TOKEN` is an OAuth device-flow token consumed by `prod-smoke.yml` and `prod-platform-e2e.yml`; it is not a documented reviewer username/password or a durable native sign-in procedure. Its credential was not retrieved, used or transmitted. Reusing a CI credential for reviewers is not part of this release plan.

[Platform #540](https://github.com/freeappstore-online/platform/issues/540#issuecomment-6699371285) records the owner's earlier decision to build a dedicated, revocable reviewer sign-in for one sandbox identity in the **MCP authorization flow**. That issue remains open. The current repository search found no `REVIEWER_LOGIN_ENABLED`, `review-demo` or reviewer-sign-in implementation, and ops metadata contains no reviewer credential entry. The existing decision is useful design context, but does not establish an available native-app review login. The missing fact is whether the owner already has a separate, usable reviewer account outside these documented arrangements; otherwise a supported review-access path must be prepared before external review. No account, authentication bypass or new secret was created during this check.

The next release should incorporate the Product Interaction manifest fix, pass the existing archive checks, upload through the account-backed Xcode path, and verify internal tester availability. External TestFlight review and App Store review are separate submissions; neither is complete merely because the internal build is Testing.
