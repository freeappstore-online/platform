# Permissions on your listing

Your app's storefront listing has a **Permissions** section that tells people, before they open it,
what the browser will ask them for: microphone, camera, location and so on. Cards on the store also
show a small icon for each one. Nobody gets a surprise prompt.

## Declare them in your manifest

Add a `permissions` list to `web/public/manifest.json`. Give each permission a one-line reason; it's
shown on your listing next to the permission.

```json
{
  "name": "EchoShift",
  "permissions": [
    { "name": "microphone", "reason": "Applies live voice effects to what you say." },
    "camera"
  ]
}
```

An entry is either a name (`"camera"`) or `{ "name", "reason" }`. Browsers ignore this member; only
the store reads it. An app that asks for nothing can leave it out.

| Name | Listing shows | The app uses |
|---|---|---|
| `microphone` | 🎙️ Microphone | `getUserMedia({ audio })`, speech recognition (`useVoiceInput`) |
| `camera` | 📷 Camera | `getUserMedia({ video })` |
| `location` | 📍 Location | `navigator.geolocation` |
| `motion` | 🧭 Motion sensors | `DeviceOrientationEvent`, `DeviceMotionEvent`, sensor APIs |
| `notifications` | 🔔 Notifications | `fas.push.subscribe()`/`schedule()`, `Notification.requestPermission()` |
| `midi` | 🎹 MIDI devices | `navigator.requestMIDIAccess()` |
| `clipboard` | 📋 Clipboard | `navigator.clipboard.readText()`/`read()` (writing needs no permission) |
| `screen` | 🖥️ Screen sharing | `getDisplayMedia()` |
| `bluetooth` | 📶 Bluetooth devices | `navigator.bluetooth` |
| `usb` | 🔌 USB devices | `navigator.usb` |
| `serial` | 🔗 Serial devices | `navigator.serial` |
| `hid` | 🕹️ HID devices | `navigator.hid` |

Only features that make the browser ask are listed. Fullscreen, wake lock, vibration and writing to
the clipboard need no permission, so they don't appear. Payments are never allowed on FreeAppStore
(see [Browser Capabilities](capabilities.md#no-payments)).

## How the store finds them

- **`fas check`** scans your source for the APIs above. Its **Permissions declared** check warns
  (it never fails) when your app uses one you haven't declared, names the file, and shows the line to
  add. It also warns on names it doesn't know.
- **The store** rescans every app's repo daily and lists what you declared plus anything it detects,
  so a listing is right even if you forget to declare something. Declaring adds your reason;
  undeclared ones get a generic line ("Uses your camera.").

Detection reads your source, not the built bundle. The SDK always includes its push client, so
scanning bundles would list notifications for every app.

## Limits

- Declarations are read from `web/public/manifest.json` (the template's manifest). A manifest written
  inline in `vite.config.ts` isn't read for `permissions`; move it to `manifest.json` (set
  `manifest: false` in `VitePWA`, as the template does).
- A new app's listing shows "Not checked yet" until the next daily scan.
