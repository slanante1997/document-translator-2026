/**
 * GET /api/status?jobId=<uuid>
 *   -> { status, progress, charactersCharged?, error? }
 *
 * Polled by the browser while a batch job runs. Job ids are unguessable
 * Azure-issued UUIDs and the response carries only counts, never document
 * contents or URLs.
 */
import type { Config } from '@netlify/functions';
import {
  API_VERSION,
  HttpError,
  handle,
  json,
  translatorError,
  translatorFetch,
} from '../lib/azure.mts';

interface BatchStatus {
  status?: string;
  summary?: {
    total?: number;
    failed?: number;
    success?: number;
    inProgress?: number;
    notYetStarted?: number;
    totalCharacterCharged?: number;
  };
  error?: { message?: string };
}

interface DocumentStatus {
  value?: Array<{ status?: string; error?: { message?: string }; progress?: number }>;
}

/** Azure statuses that mean the job will not progress any further. */
const TERMINAL = new Set(['Succeeded', 'Failed', 'Cancelled', 'ValidationFailed']);

export default async (req: Request): Promise<Response> =>
  handle(async () => {
    const jobId = new URL(req.url).searchParams.get('jobId') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new HttpError(400, 'A valid jobId is required.');

    const res = await translatorFetch(
      `/translator/document/batches/${jobId}?api-version=${API_VERSION}`
    );
    if (!res.ok) await translatorError(res, 'Could not read the translation status');

    const body = (await res.json()) as BatchStatus;
    const status = body.status ?? 'Unknown';
    const summary = body.summary ?? {};
    const total = summary.total || 1;
    const done = (summary.success ?? 0) + (summary.failed ?? 0);

    let error = body.error?.message;

    // The batch-level error is often empty even on failure; the per-document
    // endpoint is where the actionable reason lives.
    if (!error && (status === 'Failed' || (summary.failed ?? 0) > 0)) {
      const docsRes = await translatorFetch(
        `/translator/document/batches/${jobId}/documents?api-version=${API_VERSION}`
      );
      if (docsRes.ok) {
        const docs = (await docsRes.json()) as DocumentStatus;
        error = docs.value?.find((d) => d.error?.message)?.error?.message;
      }
    }

    return json(
      {
        status,
        done: TERMINAL.has(status),
        succeeded: status === 'Succeeded' && (summary.failed ?? 0) === 0,
        progress: Math.round((done / total) * 100),
        charactersCharged: summary.totalCharacterCharged,
        ...(error ? { error } : {}),
      },
      200,
      // Polled endpoint: never let a CDN or browser serve a stale status.
      { 'cache-control': 'no-store' }
    );
  });

export const config: Config = { path: '/api/status' };
