import type { Session, WebContents } from 'electron';
import { expect, it, vi } from 'vitest';
import { installPermissions } from './permissions.js';

type Request = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
type Check = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
it('requires explicit scoped media grants, refuses subframes and rejects stale approvals (#857)', async () => {
  let request!: Request;
  let check!: Check;
  const session = {
    setPermissionRequestHandler: (f: Request) => {
      request = f;
    },
    setPermissionCheckHandler: (f: Check) => {
      check = f;
    },
  } as Session;
  let url = 'https://recorder.freeappstore.online/';
  const contents = { isDestroyed: () => false, getURL: () => url } as WebContents;
  const ask = vi.fn(async () => true);
  installPermissions(session, { origin: () => 'https://recorder.freeappstore.online', ask });
  const invoke = (
    permission: Parameters<Request>[1],
    details = { isMainFrame: true, requestingUrl: url },
    mediaTypes?: ('audio' | 'video')[],
  ) =>
    new Promise((resolve) =>
      request(contents, permission, resolve, { ...details, ...(mediaTypes && { mediaTypes }) }),
    );
  expect(check(contents, 'media', url, { isMainFrame: true, mediaType: 'audio' })).toBe(false);
  expect(await invoke('media', undefined, ['audio'])).toBe(true);
  expect(ask).toHaveBeenCalledWith(
    contents,
    'https://recorder.freeappstore.online',
    'your microphone',
  );
  expect(check(contents, 'media', url, { isMainFrame: true, mediaType: 'audio' })).toBe(true);
  expect(check(contents, 'media', url, { isMainFrame: true, mediaType: 'video' })).toBe(false);
  expect(await invoke('media', { isMainFrame: false, requestingUrl: url }, ['audio'])).toBe(false);
  expect(
    await invoke('notifications', {
      isMainFrame: true,
      requestingUrl: 'https://other.freeappstore.online',
    }),
  ).toBe(false);
  for (const permission of [
    'clipboard-read',
    'display-capture',
    'usb',
    'local-network',
    'unknown',
  ] as const)
    expect(await invoke(permission)).toBe(false);
  ask.mockImplementationOnce(async () => {
    url = 'https://other.freeappstore.online';
    return true;
  });
  expect(await invoke('geolocation')).toBe(false);
});
