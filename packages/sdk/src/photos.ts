import type { Auth } from './auth.js';

export const PHOTO_LIMITS = { maxBytes: 200_000, maxEdge: 640, retentionDays: 90 } as const;
export interface Photo {
  id: string;
  /** Absolute API URL. Public photos can be used directly in an <img>. */
  url: string;
  visibility: 'private' | 'public';
  bytes: number;
  contentType: 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  createdAt: number;
  expiresAt: number;
}

/** Re-encode through canvas: resize, flatten transparency, and discard EXIF/GPS. */
export async function preparePhoto(source: Blob): Promise<Blob> {
  if (!source.type.startsWith('image/') || source.size > 20_000_000) {
    throw new Error('Choose an image smaller than 20 MB.');
  }
  const image = await createImageBitmap(source);
  try {
    if (!image.width || !image.height || image.width * image.height > 40_000_000) {
      throw new Error('This photo is too large to process.');
    }
    const scale = Math.min(1, PHOTO_LIMITS.maxEdge / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Photo processing is unavailable in this browser.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.65, 0.5, 0.35, 0.2]) {
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error('Could not compress photo.'))),
          'image/jpeg',
          quality,
        );
      });
      if (blob.size <= 100_000 || (quality === 0.2 && blob.size <= PHOTO_LIMITS.maxBytes))
        return blob;
    }
    throw new Error('Could not make this photo small enough. Choose a simpler image.');
  } finally {
    image.close();
  }
}

/** Small, temporary photos. Private by default; public is an explicit choice. */
export class Photos {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  /** Compress a camera/photo-picker image, then upload. Expires after 90 days. */
  async upload(source: Blob, opts: { visibility?: 'private' | 'public' } = {}): Promise<Photo> {
    if (!this.auth.token) throw new Error('Not signed in.');
    const image = await preparePhoto(source);
    const result = await this.request(`?visibility=${opts.visibility ?? 'private'}`, {
      method: 'POST',
      headers: { 'Content-Type': image.type },
      body: image,
    });
    return this.absolute((await result.json()) as Photo);
  }

  async list(): Promise<Photo[]> {
    const response = await this.request('', {});
    const data = (await response.json()) as { photos: Photo[] };
    return data.photos.map((photo) => this.absolute(photo));
  }

  /** Download your private photo; callers own any object URL they create. */
  async download(id: string): Promise<Blob> {
    return (await this.request(`/${encodeURIComponent(id)}`, {})).blob();
  }

  async delete(id: string): Promise<void> {
    await this.request(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  private absolute(photo: Photo): Photo {
    return { ...photo, url: new URL(photo.url, this.apiBase).href };
  }

  private async request(suffix: string, init: RequestInit): Promise<Response> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const response = await fetch(
      `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/photos${suffix}`,
      {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
      },
    );
    if (response.status === 401) {
      this.auth.handleUnauthorized(token);
      throw new Error('Not signed in.');
    }
    if (!response.ok)
      throw new Error((await response.text()) || `Photo request failed (${response.status}).`);
    return response;
  }
}
