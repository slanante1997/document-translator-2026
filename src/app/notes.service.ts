import { Injectable } from '@angular/core';
import { readJson } from './http';

/** Mirrors MAX_NOTES_BYTES in netlify/lib/notes.mts. */
export const MAX_NOTES_BYTES = 25 * 1024 * 1024;

/** Longest edge of a pasted image after downscaling. Keeps screenshots legible. */
const MAX_IMAGE_EDGE = 2000;
const IMAGE_QUALITY = 0.85;
/** GIFs this small are kept as-is so animation survives. */
const KEEP_GIF_BYTES = 2 * 1024 * 1024;

export interface NotesSnapshot {
  html: string;
  /** Version of the stored blob, or null if nothing has been saved yet. */
  etag: string | null;
}

/** What is stored in the blob. Versioned so the shape can change later. */
interface StoredNotes {
  version: 1;
  html: string;
  savedAt: string;
}

/** The server rejected the password; the caller should ask for it again. */
export class UnauthorizedError extends Error {}

/** The stored notes changed on another device since they were loaded here. */
export class ConflictError extends Error {}

/**
 * Loads and saves the synced scratchpad.
 *
 * Like the translation flow, the notes body goes straight between the browser
 * and Blob Storage on short-lived SAS URLs. The functions check the password
 * on every call and only then hand those URLs out.
 */
@Injectable({ providedIn: 'root' })
export class NotesService {
  async load(key: string): Promise<NotesSnapshot> {
    const { etag, readUrl } = await this.meta(key);
    if (!readUrl) return { html: '', etag: null };

    const res = await fetch(readUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not download your notes (HTTP ${res.status}).`);
    const stored = (await res.json()) as Partial<StoredNotes>;

    // Prefer the ETag of the bytes actually read, in case a save landed in between.
    return { html: stored.html ?? '', etag: res.headers.get('etag') ?? etag };
  }

  /** Current stored version, without downloading the notes. */
  async peekEtag(key: string): Promise<string | null> {
    return (await this.meta(key)).etag;
  }

  /**
   * Saves the notes and returns the new ETag. Refuses with ConflictError if
   * the stored copy is no longer `baseEtag`, unless `force` is set.
   */
  async save(key: string, html: string, baseEtag: string | null, force = false): Promise<string | null> {
    const stored: StoredNotes = { version: 1, html, savedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(stored)], { type: 'application/json' });

    if (blob.size > MAX_NOTES_BYTES) {
      const mb = Math.round(MAX_NOTES_BYTES / 1024 / 1024);
      throw new Error(`Notes are over the ${mb} MB limit. Remove some images to keep saving.`);
    }

    const ticketRes = await fetch('/api/notes-upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...keyHeader(key) },
      body: JSON.stringify({ size: blob.size, baseEtag, force }),
    });
    if (ticketRes.status === 401) throw new UnauthorizedError('Incorrect password.');
    if (ticketRes.status === 409) {
      throw new ConflictError((await ticketRes.json().catch(() => null))?.error ?? 'Conflict.');
    }
    const { uploadUrl } = await readJson<{ uploadUrl: string }>(ticketRes, 'Could not save notes');

    let putRes: Response;
    try {
      putRes = await fetch(uploadUrl, {
        method: 'PUT',
        // Required by the Blob REST API for a plain block-blob upload.
        headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/json' },
        body: blob,
      });
    } catch {
      throw new Error(
        'Could not reach Azure Blob Storage. This is usually a missing CORS rule on the storage account.'
      );
    }
    if (!putRes.ok) throw new Error(`Saving to Azure failed (HTTP ${putRes.status}).`);

    // ETag is only readable if the CORS rule exposes it; otherwise ask the server.
    return putRes.headers.get('etag') ?? (await this.peekEtag(key));
  }

  /**
   * Turns a pasted or dropped image into a data URL small enough to embed.
   * Large images are downscaled and re-encoded; WebP keeps transparency, and
   * JPEG is the fallback for browsers that cannot encode it.
   */
  async prepareImage(file: Blob): Promise<string> {
    if (file.type === 'image/gif' && file.size <= KEEP_GIF_BYTES) return readAsDataUrl(file);

    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d')!;

    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const webp = canvas.toDataURL('image/webp', IMAGE_QUALITY);
    if (webp.startsWith('data:image/webp')) {
      bitmap.close();
      return webp;
    }

    // JPEG has no alpha, so paint transparent areas white instead of black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
  }

  private async meta(key: string): Promise<{ etag: string | null; readUrl: string | null }> {
    const res = await fetch('/api/notes', { headers: keyHeader(key), cache: 'no-store' });
    if (res.status === 401) throw new UnauthorizedError('Incorrect password.');
    return readJson(res, 'Could not load notes');
  }
}

/** URI-encoded because header values cannot carry arbitrary Unicode. */
function keyHeader(key: string): Record<string, string> {
  return { 'x-notes-key': encodeURIComponent(key) };
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
