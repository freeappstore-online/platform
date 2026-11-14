# Small, temporary photos

`fas.photos` stores user photos in one private R2 Standard bucket, `fas-uploads`.
The bucket is separate from application assets and backups. All reads go through
the platform; never enable public bucket access or expose storage credentials.

## Contract

- JPEG or WebP, still images only, at most **200,000 bytes** before metadata stripping.
- At most **640 pixels on either edge**, checked from the actual encoded frame.
- The SDK re-encodes with browser canvas, flattens transparency on white, respects
  browser orientation, and targets 100,000 bytes. It never upscales.
- The API parses the image container, checks its format against Content-Type,
  rejects truncated containers and animations, and removes EXIF/GPS, XMP,
  ICC and comments. Container validation is not a full pixel decoder.
- Authentication required to upload. Private by default. `visibility: 'public'`
  explicitly allows anonymous reads. Only the uploader can list/delete/download
  their private photos. Cross-app session audiences are refused.
- Exact API expiry **90 days from upload**, irrespective of the later R2 deletion.
  API reads use `no-store`, including public photos, so caches cannot extend expiry.
- Upload quota: **20 per user per UTC day across all apps**, **1,000 per app/day**.
- Live quota: **100 photos / 20 MB per user per app**; **10,000 / 1 GB per app**.
  Reservations are atomic in D1, including in-flight uploads. Deleting does not
  refund the daily quota. Failed uploads free live space but count as an attempt.

## SDK

```ts
const photo = await fas.photos.upload(file, { visibility: 'public' });
// photo: id, absolute url, visibility, bytes, contentType, width, height,
//        createdAt and expiresAt (epoch milliseconds).
const mine = await fas.photos.list();
await fas.photos.delete(photo.id);

const privatePhoto = await fas.photos.upload(file);
const blob = await fas.photos.download(privatePhoto.id);
// Revoke any URL.createObjectURL(blob) after use.
```

API: `POST /v1/apps/:appId/photos?visibility=private|public` takes raw image bytes;
`GET` on the collection lists the caller's photos; `GET` and `DELETE` on `/:id`
read and remove a photo. The returned API URL is relative; the SDK resolves it.

## Retention and deployment

The backend deploy workflow ensures the dedicated bucket exists and applies
`packages/backend/config/uploads-lifecycle.json` before deploying its binding.
The configuration expires objects after 90 days and aborts incomplete multipart
uploads after one day. R2 normally deletes expired objects within a day; the API
refuses them at the exact expiry timestamp.

A bounded reaper runs every 15 minutes: expired rows, tombstones, abandoned
reservations and photos belonging to deleted users/apps are retried after failed
object deletion. Account deletion immediately blocks public reads through a live
user check. Unpublishing deletes photo metadata, making objects unreachable;
R2 lifecycle removes any remaining blobs within the retention window.

Retention applies to photo blobs and their metadata, not every collection in an
app. Apps must hide listings when their `expiresAt` passes and render a fallback
when a photo is removed. Listing records remain subject to collection quotas.
These limits and expiry are for temporary content; do not use this service for
permanent avatars, documents, backups or videos.
