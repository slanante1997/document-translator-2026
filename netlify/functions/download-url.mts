/**
 * GET /api/download-url?blob=<name>&token=<hmac>&filename=<original>
 *   -> { downloadUrl }
 *
 * Mints a short-lived read SAS for the translated blob. The HMAC token proves
 * the caller is the one who uploaded this document; without it this endpoint
 * would hand out read access to anything in the target container.
 */
import type { Config } from '@netlify/functions';
import {
  HttpError,
  assertToken,
  assertWellFormedBlobName,
  blobSasUrl,
  extensionOf,
  handle,
  json,
  readEnv,
} from '../lib/azure.mts';

/**
 * Percent-encodes a string for the RFC 5987 `filename*` parameter. Only
 * `attr-char` may appear literally, so everything else is escaped - which also
 * neutralises quotes, semicolons and CRLF.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!~]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * Builds a safe `Content-Disposition` value.
 *
 * The filename reaches us from the browser, so it is emitted twice: a stripped
 * ASCII form for the legacy `filename` parameter, and an RFC 5987 `filename*`
 * that preserves the real name. Browsers prefer the latter, so a document
 * called 研究報告.docx keeps its name instead of becoming "document".
 */
function contentDisposition(rawName: string, language: string, ext: string): string {
  // Drop any path and the extension; the extension comes from the blob name,
  // which we control.
  const stem = rawName
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]*$/, '')
    // Strip control characters outright - they have no place in a header.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 80);

  const tag = language.replace(/[^A-Za-z0-9-]/g, '').slice(0, 20);
  const suffix = `${tag ? `.${tag}` : ''}${ext}`;

  // Conservative ASCII fallback for clients that ignore `filename*`.
  const ascii = stem.replace(/[^A-Za-z0-9 ._-]/g, '').trim() || 'document';

  let disposition = `attachment; filename="${ascii}${suffix}"`;
  if (stem && stem !== ascii) {
    disposition += `; filename*=UTF-8''${encodeRfc5987(stem + suffix)}`;
  }
  return disposition;
}

export default async (req: Request): Promise<Response> =>
  handle(async () => {
    const params = new URL(req.url).searchParams;
    const blobName = params.get('blob') ?? '';
    const filename = params.get('filename') ?? 'document';
    const language = params.get('language') ?? '';

    assertWellFormedBlobName(blobName);
    assertToken(blobName, params.get('token'));

    const env = readEnv();

    // 15 minutes: long enough to click the link, short enough that a leaked URL
    // stops working quickly.
    const downloadUrl = blobSasUrl(env.targetContainer, blobName, 'r', 15, {
      contentDisposition: contentDisposition(filename, language, extensionOf(blobName)),
    });

    if (!downloadUrl) throw new HttpError(500, 'Could not create a download link.');

    return json({ downloadUrl }, 200, { 'cache-control': 'no-store' });
  });

export const config: Config = { path: '/api/download-url' };
