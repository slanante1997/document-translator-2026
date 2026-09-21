/**
 * POST /api/translate  { blobName, token, targetLanguage, sourceLanguage? }
 *   -> { jobId }
 *
 * Starts an async Document Translation batch job for the single blob the
 * caller just uploaded. `storageType: File` lets us name the exact output
 * blob, so the download step does not have to guess where Azure put it.
 */
import type { Config } from '@netlify/functions';
import {
  API_VERSION,
  HttpError,
  assertToken,
  assertWellFormedBlobName,
  blobSasUrl,
  handle,
  json,
  readEnv,
  signBlobName,
  translatorError,
  translatorFetch,
} from '../lib/azure.mts';

interface Body {
  blobName?: unknown;
  token?: unknown;
  targetLanguage?: unknown;
  sourceLanguage?: unknown;
}

/** BCP-47 tags as the service uses them: `es`, `pt-BR`, `zh-Hans`. */
const LANGUAGE_TAG = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/;

export default async (req: Request): Promise<Response> =>
  handle(async () => {
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');

    const body = (await req.json().catch(() => ({}))) as Body;
    const blobName = String(body.blobName ?? '');
    const targetLanguage = String(body.targetLanguage ?? '');
    const sourceLanguage =
      typeof body.sourceLanguage === 'string' && body.sourceLanguage ? body.sourceLanguage : '';

    assertWellFormedBlobName(blobName);
    assertToken(blobName, typeof body.token === 'string' ? body.token : null);

    if (!LANGUAGE_TAG.test(targetLanguage)) {
      throw new HttpError(400, 'A valid target language is required.');
    }
    if (sourceLanguage && !LANGUAGE_TAG.test(sourceLanguage)) {
      throw new HttpError(400, 'Invalid source language.');
    }

    const env = readEnv();

    // The service reads the source and writes the target itself, so each SAS
    // carries only the permission that one direction needs. 4 hours comfortably
    // outlives a long job without being a durable credential.
    const sourceUrl = blobSasUrl(env.sourceContainer, blobName, 'r', 240);
    const targetUrl = blobSasUrl(env.targetContainer, blobName, 'cw', 240);

    const res = await translatorFetch(`/translator/document/batches?api-version=${API_VERSION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inputs: [
          {
            storageType: 'File',
            source: {
              sourceUrl,
              // Omitting the language entirely lets Azure auto-detect.
              ...(sourceLanguage ? { language: sourceLanguage } : {}),
            },
            targets: [{ targetUrl, language: targetLanguage }],
          },
        ],
      }),
    });

    if (!res.ok) await translatorError(res, 'Could not start the translation');

    // The job id only comes back in the Operation-Location header.
    const operationLocation = res.headers.get('operation-location') ?? '';
    const jobId = operationLocation.split('/').pop()?.split('?')[0] ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
      console.error('[translate] unexpected Operation-Location:', operationLocation);
      throw new HttpError(502, 'Translation started but Azure returned no usable job id.');
    }

    return json({ jobId, blobName, token: signBlobName(blobName) });
  });

export const config: Config = { path: '/api/translate' };
