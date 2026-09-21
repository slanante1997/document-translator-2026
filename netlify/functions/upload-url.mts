/**
 * POST /api/upload-url  { filename, size }
 *   -> { blobName, uploadUrl, token }
 *
 * Mints a short-lived, write-only SAS for exactly one new blob in the source
 * container. The browser PUTs the file straight to Azure with it, which keeps
 * the document off the Netlify function payload path entirely (no 6 MB cap).
 */
import type { Config } from '@netlify/functions';
import {
  HttpError,
  MAX_FILE_BYTES,
  blobSasUrl,
  handle,
  json,
  newBlobName,
  readEnv,
  signBlobName,
} from '../lib/azure.mts';

interface Body {
  filename?: unknown;
  size?: unknown;
}

export default async (req: Request): Promise<Response> =>
  handle(async () => {
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');

    const body = (await req.json().catch(() => ({}))) as Body;
    const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
    const size = typeof body.size === 'number' ? body.size : NaN;

    if (!filename) throw new HttpError(400, 'A filename is required.');
    if (!Number.isFinite(size) || size <= 0) {
      throw new HttpError(400, 'A positive file size is required.');
    }
    if (size > MAX_FILE_BYTES) {
      const mb = Math.round(MAX_FILE_BYTES / 1024 / 1024);
      throw new HttpError(413, `File is too large. The limit is ${mb} MB.`);
    }

    const env = readEnv();
    // `newBlobName` validates the extension and discards the caller's path.
    const blobName = newBlobName(filename);

    // Create + write only, and only on this one blob. 30 minutes covers a slow
    // upload without leaving a usable credential lying around afterwards.
    const uploadUrl = blobSasUrl(env.sourceContainer, blobName, 'cw', 30);

    return json({ blobName, uploadUrl, token: signBlobName(blobName) });
  });

export const config: Config = { path: '/api/upload-url' };
