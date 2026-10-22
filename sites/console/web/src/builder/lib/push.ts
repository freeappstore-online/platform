export const VAPID_PUBLIC_KEY = "BIlVvIX9EX-NSIUGqt_DNiQWC_-SRUO7aLeu-SWNSWXqMC0ilLSCIkJ_Noa6GBn2UhC5z0OLJ2Pu2Yk8NcoSqyg";

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
