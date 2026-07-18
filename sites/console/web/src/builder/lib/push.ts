export const VAPID_PUBLIC_KEY = "BB9nIKmrVFJQJWZ4MiXzv3eN2UfGtuXESqVlQMobPiZiTmS8cQuldiXNreIV03dCo3Jkkflk6UDoAzWMvhNXCuw";

export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Back the array with a concrete ArrayBuffer so it satisfies BufferSource
  // (PushManager.subscribe's applicationServerKey) under TS's stricter typing.
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
