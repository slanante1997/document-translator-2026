/**
 * POST /api/notes-upload-url   (header x-notes-key: <password>)
 *   { size, baseEtag, force? } -> { uploadUrl }
 *
 * Mints a short-lived write SAS for the scratchpad blob. `baseEtag` is the
 * version the browser last loaded; if the stored notes have moved on since
 * (edited on another device), the request is refused with 409 unless the
 * caller explicitly chose to overwrite.
 */
import type { Config } from '@netlify/functions';
import { HttpError, blobSasUrl, handle, json } from '../lib/azure.mts';
import {
  MAX_NOTES_BYTES,
  NOTES_BLOB,
  assertNotesKey,
  currentNotesEtag,
  ensureNotesContainer,
  notesContainer,
} from '../lib/notes.mts';

interface Body {
  size?: unknown;
  baseEtag?: unknown;
  force?: unknown;
}

export default async (req: Request): Promise<Response> =>
  handle(async () => {
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
    await assertNotesKey(req);

    const body = (await req.json().catch(() => ({}))) as Body;
    const size = typeof body.size === 'number' ? body.size : NaN;
    const baseEtag = typeof body.baseEtag === 'string' ? body.baseEtag : null;

    if (!Number.isFinite(size) || size <= 0) {
      throw new HttpError(400, 'A positive size is required.');
    }
    if (size > MAX_NOTES_BYTES) {
      const mb = Math.round(MAX_NOTES_BYTES / 1024 / 1024);
      throw new HttpError(413, `Notes are too large. The limit is ${mb} MB - remove some images.`);
    }

    await ensureNotesContainer();

    if (body.force !== true && (await currentNotesEtag()) !== baseEtag) {
      throw new HttpError(409, 'These notes were changed on another device since you opened them.');
    }

    const uploadUrl = blobSasUrl(notesContainer(), NOTES_BLOB, 'cw', 5);
    return json({ uploadUrl }, 200, { 'cache-control': 'no-store' });
  });

export const config: Config = { path: '/api/notes-upload-url' };
