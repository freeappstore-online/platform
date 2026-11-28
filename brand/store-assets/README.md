# Native store creative assets

`app-store-header.png` is an opaque 3840 × 1646 sRGB brand graphic for the App Store Connect product-page header. It uses the canonical outlined FreeAppStore wordmark, Manrope and the same blue palette as the Google Play feature graphic. It is marketing artwork, not a screenshot or a claim of app activity.

Run `node brand/store-assets/render.mjs` to reproduce it. The font and SIL Open Font License are in `android/play/design/fonts/`. The manifest records output dimensions and SHA-256. Keep the important content centered; inspect App Store Connect's header preview before saving so platform crops do not cut off the wordmark or headline.

Apple's current [asset best practices](https://developer.apple.com/app-store/asset-best-practices/) allow focused brand creative for headers and advise a central safe area. This asset avoids pricing, unverified recognition, other marketplace logos and website URLs. App screenshots must separately show the real app and belong in their device-specific slots.
