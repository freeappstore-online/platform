import { describe, it, expect } from 'vitest';
import { sealSecret, openSecret, type SealedSecret } from './encryption.js';

function freshKek(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw));
}

describe('envelope encryption', () => {
  it('round-trips a typical API key', async () => {
    const kek = freshKek();
    const sealed = await sealSecret('sk-abc123_OPENWEATHER', kek);
    expect(await openSecret(sealed, kek)).toBe('sk-abc123_OPENWEATHER');
  });

  it('round-trips empty, unicode, and long values', async () => {
    const kek = freshKek();
    for (const plaintext of ['', 'ключ-🔑-密钥', 'x'.repeat(4096)]) {
      const sealed = await sealSecret(plaintext, kek);
      expect(await openSecret(sealed, kek)).toBe(plaintext);
    }
  });

  it('produces different ciphertexts for the same plaintext (fresh DEK + IV)', async () => {
    const kek = freshKek();
    const a = await sealSecret('same-key', kek);
    const b = await sealSecret('same-key', kek);
    expect(a.keyCiphertext).not.toEqual(b.keyCiphertext);
    expect(a.dekWrapped).not.toEqual(b.dekWrapped);
    expect(a.iv).not.toEqual(b.iv);
  });

  it('uses a 12-byte IV for the key ciphertext', async () => {
    const sealed = await sealSecret('whatever', freshKek());
    expect(sealed.iv.byteLength).toBe(12);
  });

  it('prepends a 12-byte IV to dek_wrapped (length = 12 + 32 + 16 tag = 60)', async () => {
    const sealed = await sealSecret('whatever', freshKek());
    expect(sealed.dekWrapped.byteLength).toBe(12 + 32 + 16);
  });

  it('rejects decryption with a different KEK', async () => {
    const sealed = await sealSecret('secret', freshKek());
    await expect(openSecret(sealed, freshKek())).rejects.toThrow();
  });

  it('rejects a tampered key ciphertext (auth tag check)', async () => {
    const kek = freshKek();
    const sealed = await sealSecret('secret', kek);
    const tampered: SealedSecret = {
      ...sealed,
      keyCiphertext: flipFirstByte(sealed.keyCiphertext),
    };
    await expect(openSecret(tampered, kek)).rejects.toThrow();
  });

  it('rejects a tampered wrapped DEK (KEK auth tag check)', async () => {
    const kek = freshKek();
    const sealed = await sealSecret('secret', kek);
    const tampered: SealedSecret = {
      ...sealed,
      dekWrapped: flipFirstByte(sealed.dekWrapped),
    };
    await expect(openSecret(tampered, kek)).rejects.toThrow();
  });

  it('rejects a wrong-length KEK', async () => {
    const tooShort = btoa(String.fromCharCode(...new Uint8Array(16)));
    await expect(sealSecret('x', tooShort)).rejects.toThrow(/32 bytes/);
  });

  it('rotation simulation: re-wrap DEK under a new KEK without touching key_ciphertext', async () => {
    // This documents the property the rotation job will rely on. We don't
    // expose a re-wrap helper yet, so we re-wrap inline to assert the design
    // works end-to-end.
    const kekOld = freshKek();
    const kekNew = freshKek();
    const sealed = await sealSecret('rotateme', kekOld);

    // Unwrap DEK under old KEK.
    const oldKekRaw = Uint8Array.from(atob(kekOld), (c) => c.charCodeAt(0));
    const oldKek = await crypto.subtle.importKey(
      'raw',
      oldKekRaw,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    const ivKekOld = sealed.dekWrapped.slice(0, 12);
    const wrappedBody = sealed.dekWrapped.slice(12);
    const dekRaw = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivKekOld }, oldKek, wrappedBody),
    );

    // Re-wrap under new KEK with a fresh IV.
    const newKekRaw = Uint8Array.from(atob(kekNew), (c) => c.charCodeAt(0));
    const newKek = await crypto.subtle.importKey(
      'raw',
      newKekRaw,
      { name: 'AES-GCM' },
      false,
      ['encrypt'],
    );
    const ivKekNew = crypto.getRandomValues(new Uint8Array(12));
    const reWrapped = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivKekNew }, newKek, dekRaw),
    );
    const newDekWrapped = new Uint8Array(12 + reWrapped.byteLength);
    newDekWrapped.set(ivKekNew, 0);
    newDekWrapped.set(reWrapped, 12);

    // key_ciphertext + iv unchanged; only dek_wrapped is replaced.
    const rotated: SealedSecret = {
      keyCiphertext: sealed.keyCiphertext,
      iv: sealed.iv,
      dekWrapped: newDekWrapped,
    };
    expect(await openSecret(rotated, kekNew)).toBe('rotateme');
    // And the old KEK no longer decrypts the rotated row.
    await expect(openSecret(rotated, kekOld)).rejects.toThrow();
  });
});

function flipFirstByte(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  out[0] = (out[0] ?? 0) ^ 0xff;
  return out;
}
