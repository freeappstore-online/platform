import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error Plain Node ESM helper used outside the build.
import { waitForSmoke } from './wait-for-smoke.mjs';

afterEach(() => vi.useRealTimers());
it('waits beyond the old 200ms assumption for the actual message', async () => {
  vi.useFakeTimers();
  let delivered = false;
  setTimeout(() => {
    delivered = true;
  }, 700);
  const wait = waitForSmoke(() => delivered, 'message');
  await vi.advanceTimersByTimeAsync(710);
  await expect(wait).resolves.toBeUndefined();
});
it('fails when the expected protocol event never arrives', async () => {
  vi.useFakeTimers();
  const wait = expect(waitForSmoke(() => false, 'room broadcast', 100)).rejects.toThrow(
    'Timed out waiting for room broadcast',
  );
  await vi.advanceTimersByTimeAsync(110);
  await wait;
});
