import { Injectable } from '@angular/core';
import type { Language, StatusResponse, UploadTicket } from './translation.models';

/** Gap between status polls. Document jobs are measured in tens of seconds. */
const POLL_INTERVAL_MS = 3_000;
/** Give up rather than poll a stuck job forever. */
const POLL_TIMEOUT_MS = 15 * 60_000;

export interface TranslateOptions {
  file: File;
  targetLanguage: string;
  sourceLanguage?: string;
  onUploadProgress: (percent: number) => void;
  onPhase: (phase: 'starting' | 'translating', progress: number) => void;
}

export interface TranslateResult {
  downloadUrl: string;
  charactersCharged?: number;
}

/**
 * Drives the four-step pipeline: get a SAS, upload straight to Azure Blob
 * Storage, start the batch job, poll it, then swap the finished blob for a
 * download link.
 *
 * No Azure credential ever reaches this class - the functions in netlify/
 * hold the keys and hand back only scoped, short-lived URLs.
 */
@Injectable({ providedIn: 'root' })
export class TranslationService {
  async listLanguages(): Promise<Language[]> {
    const res = await fetch('/api/languages');
    const body = await this.readJson<{ languages: Language[] }>(res, 'Could not load languages');
    return body.languages;
  }

  async translate(opts: TranslateOptions): Promise<TranslateResult> {
    const { file, targetLanguage, sourceLanguage } = opts;

    // 1. Ask our function for a write-once SAS scoped to a single new blob.
    const ticketRes = await fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size }),
    });
    const ticket = await this.readJson<UploadTicket>(ticketRes, 'Could not prepare the upload');

    // 2. PUT the bytes straight to Azure, bypassing the function payload limit.
    await this.uploadToBlob(ticket.uploadUrl, file, opts.onUploadProgress);

    // 3. Start the batch job.
    opts.onPhase('starting', -1);
    const startRes = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        blobName: ticket.blobName,
        token: ticket.token,
        targetLanguage,
        ...(sourceLanguage ? { sourceLanguage } : {}),
      }),
    });
    const { jobId } = await this.readJson<{ jobId: string }>(
      startRes,
      'Could not start the translation'
    );

    // 4. Poll until Azure says the job reached a terminal state.
    const final = await this.pollUntilDone(jobId, (p) => opts.onPhase('translating', p));

    if (!final.succeeded) {
      throw new Error(final.error || `Translation ${final.status.toLowerCase()}.`);
    }

    // 5. Exchange the blob reference for a short-lived read link.
    const params = new URLSearchParams({
      blob: ticket.blobName,
      token: ticket.token,
      filename: file.name,
      language: targetLanguage,
    });
    const dlRes = await fetch(`/api/download-url?${params}`);
    const { downloadUrl } = await this.readJson<{ downloadUrl: string }>(
      dlRes,
      'Could not create a download link'
    );

    return { downloadUrl, charactersCharged: final.charactersCharged };
  }

  /**
   * Uploads via XMLHttpRequest rather than fetch: fetch cannot report upload
   * progress, and for a 30 MB document a progress bar is the difference between
   * "working" and "frozen".
   */
  private uploadToBlob(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      // Required by the Blob REST API for a plain block-blob upload.
      xhr.setRequestHeader('x-ms-blob-type', 'BlockBlob');
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
          resolve();
          return;
        }
        // A CORS rejection surfaces here as an opaque failure, so name the most
        // likely cause instead of echoing an empty Azure response.
        reject(
          new Error(
            `Upload to Azure failed (HTTP ${xhr.status}). ` +
              'If this persists, check the CORS rule on the storage account.'
          )
        );
      };
      xhr.onerror = () =>
        reject(
          new Error(
            'Could not reach Azure Blob Storage. This is usually a missing CORS ' +
              'rule on the storage account - see the README.'
          )
        );
      xhr.onabort = () => reject(new Error('Upload cancelled.'));
      xhr.send(file);
    });
  }

  private async pollUntilDone(
    jobId: string,
    onProgress: (percent: number) => void
  ): Promise<StatusResponse> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    for (;;) {
      const res = await fetch(`/api/status?jobId=${encodeURIComponent(jobId)}`);
      const status = await this.readJson<StatusResponse>(res, 'Lost track of the translation');

      if (status.done) return status;
      onProgress(status.progress);

      if (Date.now() > deadline) {
        throw new Error('The translation is taking unusually long. Check the Azure portal.');
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  /** Unwraps a function response, preferring the server's error text over a status code. */
  private async readJson<T>(res: Response, fallback: string): Promise<T> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`${fallback} (HTTP ${res.status}).`);
    }
    if (!res.ok) {
      const message = (body as { error?: string })?.error;
      throw new Error(message || `${fallback} (HTTP ${res.status}).`);
    }
    return body as T;
  }
}
