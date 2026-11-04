export type CaptureKind = 'microphone' | 'camera' | 'display';

export interface MediaSupport {
  capture: boolean;
  recorder: boolean;
  fileShare: boolean;
  reason?: 'unsupported' | 'mobile-display-capture-unsupported';
}

export interface MediaBusyGuardHost {
  addBusyGuard(guard: () => boolean): () => void;
}

export type MediaExportResult =
  | { ok: true; method: 'shared' | 'downloaded'; filename: string; release: () => void }
  | { ok: false; reason: 'cancelled' | 'unavailable'; message: string };

export function mediaSupport(kind: CaptureKind): MediaSupport {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  const capture =
    kind === 'display'
      ? typeof media?.getDisplayMedia === 'function'
      : typeof media?.getUserMedia === 'function';
  const mobile =
    typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return {
    capture: capture && !(kind === 'display' && mobile),
    recorder: typeof MediaRecorder !== 'undefined',
    fileShare: typeof navigator !== 'undefined' && typeof navigator.share === 'function',
    ...(!capture
      ? { reason: 'unsupported' as const }
      : kind === 'display' && mobile
        ? { reason: 'mobile-display-capture-unsupported' as const }
        : {}),
  };
}

/** Call directly from a user action. A late permission grant is stopped on cancel. */
export async function requestCapture(
  kind: CaptureKind,
  signal?: AbortSignal,
): Promise<MediaStream> {
  if (signal?.aborted) throw new DOMException('Capture cancelled', 'AbortError');
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  const request =
    kind === 'display'
      ? media?.getDisplayMedia?.({ video: true, audio: true })
      : media?.getUserMedia?.(
          kind === 'camera' ? { video: true, audio: true } : { audio: true, video: false },
        );
  if (!request) throw new Error(`${kind} capture is not supported by this browser`);
  const stream = await request;
  if (signal?.aborted) {
    stopTracks(stream);
    throw new DOMException('Capture cancelled', 'AbortError');
  }
  return stream;
}

/** Select a format reported by this browser; an empty result means use its default. */
export function chooseRecordingType(candidates: string[]): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

export function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** Stop the recorder before releasing its tracks; app listeners retain the final dataavailable Blob. */
export async function stopRecording(recorder: MediaRecorder, stream: MediaStream): Promise<void> {
  try {
    if (recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        const finish = () => {
          recorder.removeEventListener('stop', finish);
          recorder.removeEventListener('error', finish);
          resolve();
        };
        recorder.addEventListener('stop', finish);
        recorder.addEventListener('error', finish);
        try {
          recorder.stop();
        } catch {
          finish();
        }
      });
    }
  } finally {
    stopTracks(stream);
  }
}

/** Keep a prompted PWA update from discarding active capture or unsaved media. */
export function registerMediaBusyGuard(pwa: MediaBusyGuardHost, isBusy: () => boolean): () => void {
  return pwa.addBusyGuard(isBusy);
}

/** Share when available, otherwise download and revoke the temporary URL after dispatch. */
export async function exportRecording(blob: Blob, filename: string): Promise<MediaExportResult> {
  const file =
    typeof File === 'undefined'
      ? undefined
      : new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  let canShare = false;
  try {
    canShare = !!file && !!nav?.share && !!nav.canShare?.({ files: [file] });
  } catch {
    canShare = false;
  }
  if (canShare && file && nav?.share) {
    try {
      await nav.share({ files: [file], title: filename });
      return { ok: true, method: 'shared', filename, release() {} };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError')
        return { ok: false, reason: 'cancelled', message: 'Sharing was cancelled.' };
      // A failed share can still use the download fallback.
    }
  }
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL)
    return { ok: false, reason: 'unavailable', message: 'File export is not available.' };
  let objectUrl: string | undefined;
  let anchor: HTMLAnchorElement | undefined;
  try {
    objectUrl = URL.createObjectURL(blob);
    anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch {
    try {
      anchor?.remove();
    } catch {
      // Continue releasing the object URL even if DOM cleanup throws.
    }
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // The URL may already be revoked by the browser.
      }
    }
    return { ok: false, reason: 'unavailable', message: 'The recording could not be downloaded.' };
  }
  let released = false;
  const timer: ReturnType<typeof setTimeout> | undefined = setTimeout(release, 0);
  function release() {
    if (released) return;
    released = true;
    if (timer !== undefined) clearTimeout(timer);
    try {
      URL.revokeObjectURL(objectUrl!);
    } catch {
      // A browser may already have released the URL.
    }
  }
  return { ok: true, method: 'downloaded', filename, release };
}
