/**
 * GET /api/notes   (header x-notes-key: <password>)
 *   -> { etag, readUrl }
 *
 * Returns a short-lived read SAS for the scratchpad rather than its contents,
 * so notes full of pasted images never pass through a function body. Both
 * fields are null until the first save.
 */
import type { Config } from '@netlify/functions';
import { HttpError, blobSasUrl, handle, json } from '../lib/azure.mts';
import { NOTES_BLOB, assertNotesKey, currentNotesEtag, notesContainer } from '../lib/notes.mts';

export default async (req: Request): Promise<Response> =>
  handle(async () => {
    if (req.method !== 'GET') throw new HttpError(405, 'Use GET.');
    await assertNotesKey(req);

    const etag = await currentNotesEtag();
    // 5 minutes: the browser fetches it immediately and never stores it.
    const readUrl = etag ? blobSasUrl(notesContainer(), NOTES_BLOB, 'r', 5) : null;

    return json({ etag, readUrl }, 200, { 'cache-control': 'no-store' });
  });

export const config: Config = { path: '/api/notes' };
