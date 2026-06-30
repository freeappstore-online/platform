export const VAPID_PUBLIC_KEY = "BB9nIKmrVFJQJWZ4MiXzv3eN2UfGtuXESqVlQMobPiZiTmS8cQuldiXNreIV03dCo3Jkkflk6UDoAzWMvhNXCuw";

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
